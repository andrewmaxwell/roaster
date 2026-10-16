// Whole sessions against the simulated roaster, on a virtual clock (an hour
// of roasting takes well under a second).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {createVirtualClock} from '../server/clock.js';
import {Machine} from '../server/machine.js';
import {SimKaleido} from '../server/sim.js';
import {Session} from '../server/session.js';
import {loadProcedure} from '../server/procedure.js';
import {autopilot} from '../server/autopilot.js';

const preheat = JSON.parse(
  fs.readFileSync(new URL('../preheat.json', import.meta.url), 'utf8'),
);
const ESPRESSO = {
  bean: 'colombian_supremo',
  variant: 'espresso',
  weightIn: 155,
};
const POUROVER = {...ESPRESSO, variant: 'pourover'};
const HOUR = 3600_000;

function seeded(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

function setup({dropRate = 0.15, sim, clock} = {}) {
  clock ??= createVirtualClock();
  sim ??= new SimKaleido({clock, dropRate, random: seeded(7)});
  const machine = new Machine({clock, openTransport: () => sim.open()});
  const session = new Session({machine, clock, preheat, loadProcedure});
  const log = [];
  for (const e of ['phase', 'say', 'alert', 'charge', 'tp', 'fc'])
    session.on(e, (a, b) => log.push({e, t: clock.now(), a, b}));
  for (const e of ['step', 'drop', 'beansOut', 'batchComplete'])
    session.on(e, (a, b) => log.push({e, t: clock.now(), a, b}));
  machine.run();
  return {clock, sim, machine, session, log};
}

const phases = (log) => log.filter((x) => x.e === 'phase').map((x) => x.a);
const said = (log) => log.filter((x) => x.e === 'say').map((x) => x.a);

async function finish({clock, machine}) {
  const stopped = machine.stop();
  await clock.advance(5000);
  await stopped;
}

test('a two-batch session, start to all-off, with 15% of commands dropped', async () => {
  const ctx = setup();
  const {clock, sim, session, log} = ctx;
  session.start();
  let off = false;
  autopilot(session, sim, clock, {batches: [ESPRESSO, POUROVER]}).then(
    () => (off = true),
  );
  await clock.until(() => off, 3 * HOUR, 5000);

  assert.deepEqual(phases(log), [
    'PREHEAT',
    'READY',
    'ROASTING',
    'PREHEAT',
    'READY',
    'ROASTING',
    'PREHEAT',
    'SHUTDOWN',
    'OFF',
  ]);
  const batches = log.filter((x) => x.e === 'batchComplete').map((x) => x.a);
  assert.deepEqual(
    batches.map((b) => b.variant),
    ['espresso', 'pourover'],
  );
  for (const b of batches) {
    assert.ok(b.tp.BT > 95 && b.tp.BT < 125, `TP ${b.tp.BT}`);
    assert.deepEqual(
      b.steps.map((s) => s.bt),
      [154, 175, 178, 190, 194, 198],
    );
    for (const s of b.steps) assert.ok(s.BT >= s.bt && s.BT < s.bt + 2);
    assert.equal(b.drop.reason, 'temperature');
    assert.ok(b.drop.BT >= b.proc.drop.bt && b.drop.BT < b.proc.drop.bt + 2);
    assert.ok(b.fc && b.beansOut);
    assert.ok(b.samples.length > 300);
  }
  // The second preheat starts hot, so it's shorter than the first.
  const ready = log.filter((x) => x.e === 'phase' && x.a === 'READY');
  const drop1 = log.find((x) => x.e === 'drop').t;
  assert.ok(ready[1].t - drop1 < ready[0].t);
  // Everything off at the end.
  assert.deepEqual(
    {HS: sim.m.HS, HP: sim.m.HP, FC: sim.m.FC, RC: sim.m.RC, CS: sim.m.CS},
    {HS: 0, HP: 0, FC: 0, RC: 0, CS: 0},
  );
  await finish(ctx);
});

test('after the drop it preheats again with the cooling fan on, for 4 minutes', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  autopilot(session, sim, clock, {batches: [ESPRESSO, ESPRESSO]});
  await clock.until(() => log.some((x) => x.e === 'drop'), 2 * HOUR, 5000);
  await clock.advance(3000);
  assert.equal(session.phase, 'PREHEAT');
  assert.equal(sim.m.HS, 0, 'no heat until the beans are out');
  await clock.until(() => log.some((x) => x.e === 'beansOut'), HOUR, 1000);
  await clock.advance(5000);
  assert.deepEqual(
    {TS: sim.m.TS, AH: sim.m.AH, HS: sim.m.HS, FC: sim.m.FC, RC: sim.m.RC},
    {TS: 185, AH: 1, HS: 1, FC: 30, RC: 90},
  );
  assert.equal(sim.m.CS, 1);
  const out = log.find((x) => x.e === 'beansOut').t;
  await clock.until(() => sim.m.CS === 0, 10 * 60_000, 1500);
  const offAfter = clock.now() - out;
  assert.ok(
    offAfter >= 4 * 60_000 && offAfter < 4 * 60_000 + 5000,
    `${offAfter}`,
  );
  await finish(ctx);
});

test('the cooling fan comes on 1 °C before the drop, while still roasting', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  // (First crack turns the fan on too: here it's never marked.)
  autopilot(session, sim, clock, {batches: [ESPRESSO], fcAt: Infinity});
  let last = null;
  session.on('sample', (s) => (last = s));
  await clock.until(() => session.phase === 'ROASTING', 2 * HOUR, 1000);
  const dropBT = session.batch.proc.drop.bt;
  let fanOn = null;
  await clock.until(
    () => {
      if (!fanOn && sim.m.CS === 1)
        fanOn = {BT: last.BT, phase: session.phase, t: clock.now()};
      return log.some((x) => x.e === 'drop');
    },
    HOUR,
    500,
  );
  const drop = log.find((x) => x.e === 'drop');
  assert.equal(fanOn.phase, 'ROASTING');
  assert.ok(
    fanOn.BT >= dropBT - 1.5 && fanOn.BT < dropBT,
    `fan on at ${fanOn.BT}`,
  );
  assert.ok(drop.t - fanOn.t >= 3000, 'fan on a few seconds before the drop');
  await finish(ctx);
});

test("won't call for or detect a charge until the beans are chosen", async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  assert.match(said(log).at(-1), /choose the next beans/i);
  sim.chargeBeans(155);
  await clock.advance(60_000);
  assert.equal(session.phase, 'READY');
  const alerts = log.filter((x) => x.e === 'alert').map((x) => x.a);
  assert.equal(alerts.length, 1, 'the unexpected charge is flagged, once');
  assert.equal(alerts[0].level, 'urgent');
  assert.match(alerts[0].text, /no beans are chosen/);
  await finish(ctx);
});

test('beans poured in before "ready" still start the roast', async () => {
  // 3 of the 12 real roasts before #38 were charged before the app would
  // have called the preheat ready.
  const ctx = setup({dropRate: 0});
  const {clock, sim, session} = ctx;
  session.start();
  session.selectBatch(ESPRESSO);
  await clock.advance(8 * 60_000); // BT at the setpoint, the drum still soaking
  assert.equal(session.phase, 'PREHEAT');
  const pouredAt = clock.now();
  sim.chargeBeans(155);
  await clock.advance(20_000);
  assert.equal(session.phase, 'ROASTING');
  assert.ok(Math.abs(session.batch.charge.t - pouredAt) < 3000, 'backdated');
  await finish(ctx);
});

test('a charge in preheat with no beans chosen is flagged', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  await clock.advance(8 * 60_000);
  sim.chargeBeans(155);
  await clock.advance(20_000);
  assert.equal(session.phase, 'PREHEAT');
  const alerts = log.filter((x) => x.e === 'alert').map((x) => x.a);
  assert.match(alerts.at(-1).text, /no beans are chosen/);
  await finish(ctx);
});

test("the beans coming out after a drop don't look like the next charge", async () => {
  // The next batch is chosen right away, so a false charge would start it.
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  autopilot(session, sim, clock, {batches: [ESPRESSO, ESPRESSO]});
  await clock.until(() => log.some((x) => x.e === 'drop'), 2 * HOUR, 5000);
  sim.chargeBeans = () => {}; // nobody pours the second batch in
  await clock.advance(15 * 60_000);
  assert.equal(log.filter((x) => x.e === 'charge').length, 1);
  await finish(ctx);
});

test('quitting mid-roast keeps the heater off even if a step fires', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, machine, session} = ctx;
  session.start();
  session.selectBatch(ESPRESSO);
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.chargeBeans(155);
  // One reading before the first step fires, do what main.js does on quit.
  await clock.until(
    () => session.tracker?.nextStep === 0 && session.tracker.stepCount === 2,
    HOUR,
    100,
  );
  machine.heaterOff();
  await clock.advance(10_000);
  assert.equal(session.batch.steps.length, 1, 'the step did fire');
  assert.equal(machine.desired.HS, 0);
  assert.equal(sim.m.HS, 0);
  assert.ok(machine.heaterConfirmedOff());
  await finish(ctx);
});

test('choosing the beans right after pouring them in still starts the roast', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  const pouredAt = clock.now();
  sim.chargeBeans(155);
  await clock.until(() => log.some((x) => x.e === 'alert'), 30_000, 500);
  session.selectBatch(ESPRESSO);
  await clock.advance(5000);
  assert.equal(session.phase, 'ROASTING');
  assert.ok(Math.abs(session.batch.charge.t - pouredAt) < 3000, 'backdated');
  await finish(ctx);
});

test('beans charged with none chosen keep the alarm going until they are', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  const pouredAt = clock.now();
  sim.chargeBeans(155);
  await clock.advance(3 * 60_000);
  assert.equal(session.phase, 'READY');
  const since = log.filter((x) => x.t > pouredAt + 15_000);
  const reminders = said(since).filter((t) => /none are chosen/.test(t));
  assert.ok(reminders.length >= 5, `reminded ${reminders.length} times`);
  assert.ok(
    !said(since).some((t) => /^Ready/.test(t)),
    "doesn't call for a charge with the beans already in",
  );
  session.selectBatch(ESPRESSO);
  assert.equal(session.phase, 'ROASTING');
  assert.ok(Math.abs(session.batch.charge.t - pouredAt) < 3000, 'backdated');
  assert.ok(session.batch.tp, 'caught up on the roast so far');
  await finish(ctx);
});

test('"not a charge" ends the alarm without starting a roast', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.chargeBeans(155);
  await clock.until(() => session.pendingCharge, 30_000, 500);
  session.dismissCharge();
  const dismissedAt = clock.now();
  await clock.advance(2 * 60_000);
  const after = log.filter((x) => x.t > dismissedAt);
  assert.ok(!said(after).some((t) => /none are chosen/.test(t)));
  assert.equal(session.pendingCharge, null);
  session.selectBatch(ESPRESSO);
  await clock.advance(10_000);
  assert.notEqual(session.phase, 'ROASTING', 'needs a new charge');
  await finish(ctx);
});

test('a weight in that is not a number is refused', async () => {
  // (A NaN would be saved as null: the weight lost.)
  const ctx = setup();
  const {session} = ctx;
  session.start();
  for (const weightIn of ['abc', 0, null])
    assert.throws(() => session.selectBatch({...ESPRESSO, weightIn}), /grams/);
  assert.equal(session.next, null);
  session.selectBatch({...ESPRESSO, weightIn: '160.5'});
  assert.equal(session.next.weightIn, 160.5);
  await finish(ctx);
});

test("a batch far from the procedure's weight is flagged", async () => {
  const ctx = setup();
  const {session, log} = ctx;
  session.start();
  const warned = () =>
    log.filter((x) => x.e === 'alert' && /155 g/.test(x.a.text));
  session.selectBatch({...ESPRESSO, weightIn: 150});
  assert.equal(warned().length, 0, 'within 5%');
  session.selectBatch({...ESPRESSO, weightIn: 140});
  assert.equal(warned().length, 1);
  await finish(ctx);
});

test('"ready for charge" names the beans, so a wrong choice is heard', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, session, log} = ctx;
  session.start();
  session.selectBatch({...ESPRESSO, weightIn: 140});
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  assert.ok(
    said(log).includes(
      'Ready for charge: colombian supremo, espresso, 140 grams.',
    ),
    said(log).join(' | '),
  );
  await finish(ctx);
});

test('BT past any sane drop drops, whatever the procedure says', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  session.selectBatch(ESPRESSO);
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.chargeBeans(155);
  await clock.until(() => session.batch?.tp, HOUR, 1500);
  // A typo that got past the procedure check (an older saved batch, say),
  // and nothing turning the burner down.
  session.batch.proc = {...session.batch.proc, steps: [], drop: {bt: 235}};
  session.tracker.proc = session.batch.proc;
  session.planned.HP = 100;
  session.apply();
  await clock.until(() => log.some((x) => x.e === 'drop'), HOUR, 1500);
  const drop = log.find((x) => x.e === 'drop').b;
  assert.equal(drop.reason, 'over temperature');
  assert.ok(drop.BT >= 218 && drop.BT < 220, `${drop.BT}`);
  assert.equal(sim.m.HP, 0);
  await finish(ctx);
});

test('opening the door mid-roast is the drop, and the beans are out', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  session.selectBatch(ESPRESSO);
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.chargeBeans(155);
  // Well before the procedure's drop: right after first crack.
  await clock.until(() => session.batch?.steps.length >= 3, HOUR, 1500);
  const peak = sim.s.BT;
  const opened = clock.now();
  sim.discharge();
  await clock.until(() => log.some((x) => x.e === 'drop'), 60_000, 1500);
  const found = clock.now() - opened;
  const b = log.find((x) => x.e === 'drop').a;
  assert.equal(b.drop.reason, 'door');
  assert.ok(found < 20_000, `found ${found / 1000} s after`);
  // Backdated to the reading before the fall.
  assert.ok(b.drop.t <= opened && opened - b.drop.t < 3000);
  assert.ok(Math.abs(b.drop.BT - peak) < 1, `${b.drop.BT} vs ${peak}`);
  assert.ok(b.beansOut, 'beans out with it');
  assert.equal(session.phase, 'PREHEAT');
  assert.ok(!said(log).some((x) => /drop now/i.test(x)));
  await clock.advance(5000);
  assert.equal(sim.m.HS, 1, 'preheating again');
  assert.equal(sim.m.CS, 1, 'cooling fan on');
  await finish(ctx);
});

test('a whole roast with the door shut never looks like the door opening', async () => {
  const ctx = setup();
  const {clock, sim, session, log} = ctx;
  session.start();
  autopilot(session, sim, clock, {batches: [ESPRESSO, POUROVER]});
  await clock.until(
    () => log.filter((x) => x.e === 'batchComplete').length === 2,
    3 * HOUR,
    5000,
  );
  const drops = log.filter((x) => x.e === 'drop').map((x) => x.b.reason);
  assert.deepEqual(drops, ['temperature', 'temperature']);
  await finish(ctx);
});

test('a restart mid-roast picks up where it left off', async () => {
  const clock = createVirtualClock();
  const sim = new SimKaleido({clock, dropRate: 0.15, random: seeded(3)});
  const a = setup({clock, sim});
  a.session.start();
  autopilot(a.session, sim, clock, {batches: [ESPRESSO]});
  await clock.until(() => a.session.batch?.steps.length === 3, 2 * HOUR, 1500);
  const saved = JSON.parse(JSON.stringify(a.session.toJSON()));
  // The process dies: nothing is listening and the port closes. The roaster
  // carries on with its last settings.
  a.session.removeAllListeners();
  a.session.detach();
  await finish(a);
  await clock.advance(20_000);

  const b = setup({clock, sim});
  b.session.start(saved);
  assert.equal(b.session.phase, 'ROASTING');
  await clock.until(() => b.log.some((x) => x.e === 'drop'), HOUR, 1500);
  const steps = b.log.filter((x) => x.e === 'step').map((x) => x.b.bt);
  assert.deepEqual(steps, [190, 194, 198], 'no step fires twice');
  const drop = b.log.find((x) => x.e === 'drop').b;
  assert.ok(drop.BT >= 207.4 && drop.BT < 209.4);
  await finish(b);
});

test('a restart long after the app died mid-roast ends that roast instead of reheating it', async () => {
  const clock = createVirtualClock();
  const sim = new SimKaleido({clock, dropRate: 0});
  const a = setup({clock, sim});
  a.session.start();
  autopilot(a.session, sim, clock, {batches: [ESPRESSO]});
  await clock.until(() => a.session.batch?.steps.length === 3, 2 * HOUR, 1500);
  const saved = JSON.parse(JSON.stringify(a.session.toJSON()));
  const lastT = saved.log.at(-1).t;
  a.session.removeAllListeners();
  a.session.detach();
  await finish(a);
  await clock.advance(5 * 60_000);

  const b = setup({clock, sim});
  b.session.start(saved, {downMs: 5 * 60_000});
  assert.equal(b.session.phase, 'PREHEAT');
  assert.equal(b.machine.desired.AH, 1, 'back on the preheat PID');
  const drop = b.log.find((x) => x.e === 'drop').b;
  assert.equal(drop.reason, 'interrupted');
  assert.equal(drop.t, lastT, 'where the record stopped');
  assert.match(
    b.log.find((x) => x.e === 'alert').a.text,
    /off for 5 minutes mid-roast/,
  );
  // The beans may still be in: no heat, and the drop alarm, until they're out.
  await clock.advance(60_000);
  assert.equal(sim.m.HS, 0);
  assert.ok(b.session.batch, 'record open until the beans are out');
  assert.ok(b.log.some((x) => x.e === 'say' && /drop now/i.test(x.a)));
  b.session.beansOut();
  await clock.advance(5000);
  assert.equal(sim.m.HS, 1);
  await clock.advance(60_000); // the record closes a minute after beans out
  assert.ok(
    b.log.some((x) => x.e === 'batchComplete'),
    'record closed',
  );
  assert.equal(b.session.batch, null);
  await finish(b);
});

test('a restart while ready proves the preheat again before calling for beans', async () => {
  const clock = createVirtualClock();
  const sim = new SimKaleido({clock, dropRate: 0, random: seeded(5)});
  const a = setup({clock, sim});
  a.session.start();
  a.session.selectBatch(ESPRESSO);
  await clock.until(() => a.session.phase === 'READY', HOUR, 1500);
  const saved = JSON.parse(JSON.stringify(a.session.toJSON()));
  // The app quits (heater off) and comes back 25 minutes later, with the
  // drum far below the preheat temperature.
  a.session.removeAllListeners();
  a.session.detach();
  a.machine.set({HS: 0, AH: 0, HP: 0, FC: 100});
  await clock.advance(5000);
  await finish(a);
  await clock.advance(25 * 60_000);

  const b = setup({clock, sim});
  b.session.start(saved);
  await clock.advance(2 * 60_000);
  assert.equal(b.session.phase, 'PREHEAT');
  assert.ok(!said(b.log).some((x) => /ready for charge/i.test(x)));
  await clock.until(() => b.session.phase === 'READY', HOUR, 1500);
  const BT = Number(sim.readings().BT);
  assert.ok(BT > 183, `ready again at BT ${BT}`);
  await finish(b);
});

test('a cable pull mid-roast raises the alarm, then the roast carries on', async () => {
  const ctx = setup();
  const {clock, sim, session, log} = ctx;
  session.start();
  autopilot(session, sim, clock, {batches: [ESPRESSO]});
  await clock.until(() => session.batch?.steps.length === 2, 2 * HOUR, 1500);
  sim.close();
  await clock.advance(3000);
  const alert = log.find((x) => x.e === 'alert');
  assert.equal(alert.a.level, 'urgent');
  assert.match(alert.a.text, /disconnected/);
  await clock.until(() => log.some((x) => x.e === 'drop'), HOUR, 1500);
  assert.equal(session.batch.steps.length, 6);
  await finish(ctx);
});

test('the drop alarm keeps going until the beans are out', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  session.selectBatch(ESPRESSO);
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.chargeBeans(155);
  await clock.until(() => log.some((x) => x.e === 'drop'), HOUR, 1500);
  const dropAt = clock.now();
  // Nobody opens the door for 5 minutes.
  await clock.advance(5 * 60_000);
  assert.ok(session.batch?.drop, 'the record is still open');
  const calls = log.filter((x) => x.e === 'say' && x.t > dropAt + 60_000);
  assert.ok(calls.filter((x) => /drop now/i.test(x.a)).length > 30);
  assert.ok(!calls.some((x) => /ready for charge/i.test(x.a)));
  sim.discharge();
  await clock.until(() => log.some((x) => x.e === 'batchComplete'), HOUR, 1500);
  await finish(ctx);
});

test('STOP mid-roast cuts the heat, calls for the drop, and shuts down', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  session.selectBatch(ESPRESSO);
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.chargeBeans(155);
  await clock.until(() => session.batch?.steps.length === 2, HOUR, 1500);
  session.emergencyStop();
  await clock.advance(5000);
  assert.equal(session.phase, 'SHUTDOWN');
  assert.equal(session.batch.drop.reason, 'emergency stop');
  assert.equal(sim.m.HS, 0);
  assert.equal(sim.m.HP, 0);
  assert.ok(sim.m.FC > 0 && sim.m.RC > 0, 'air and drum keep running');
  assert.ok(log.some((x) => x.e === 'say' && /drop now/i.test(x.a)));
  await finish(ctx);
});

test('an early drop keeps the heat off until the beans are out', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  autopilot(session, sim, clock, {
    batches: [ESPRESSO, ESPRESSO],
    reactMs: 30_000,
  });
  await clock.until(() => session.batch?.tp, 2 * HOUR, 1000);
  assert.ok(sim.s.BT < preheat.sv);
  session.dropNow();
  await clock.advance(20_000);
  assert.equal(session.phase, 'PREHEAT');
  assert.equal(sim.m.HS, 0, 'no heat while the beans are still in');
  // The autopilot opens the door 30 s after the drop.
  await clock.until(() => log.some((x) => x.e === 'beansOut'), 60_000, 1500);
  await clock.advance(5000);
  assert.equal(sim.m.HS, 1);
  await finish(ctx);
});

test('a closed drum cooling slowly after a drop is not "beans out"', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  session.selectBatch(ESPRESSO);
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.chargeBeans(155);
  await clock.until(() => session.batch?.tp, HOUR, 1500);
  session.dropNow();
  const dropBT = session.batch.drop.BT;
  await clock.until(() => sim.s.BT < dropBT - 15, HOUR, 1500);
  assert.ok(!log.some((x) => x.e === 'beansOut'));
  assert.equal(sim.m.HS, 0);
  await finish(ctx);
});

test('losing the roaster while ready means proving the preheat again', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session} = ctx;
  session.start();
  session.selectBatch(ESPRESSO);
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.close();
  await clock.advance(10_000);
  assert.equal(session.phase, 'PREHEAT');
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  await finish(ctx);
});

test('unplugging once all off is quiet; unplugging mid-cool-down is not', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, machine, session, log} = ctx;
  machine.on('error', () => {}); // "not found" while unplugged (main.js logs it)
  session.start();
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  session.done();
  await clock.advance(60_000);
  sim.unplugged = true;
  sim.close();
  await clock.advance(5000);
  const alerts = () => log.filter((x) => x.e === 'alert').map((x) => x.a);
  assert.equal(alerts().at(-1).level, 'urgent');
  assert.match(alerts().at(-1).text, /plug it back in/);
  sim.unplugged = false;
  let off = false;
  session.on('off', () => (off = true));
  await clock.until(() => off, HOUR, 5000);
  assert.ok(said(log).includes('All off. You can unplug the roaster.'));
  const before = alerts().length;
  sim.unplugged = true;
  sim.close();
  await clock.advance(30_000);
  assert.equal(alerts().length, before, 'no alarm for the end of the day');
  await finish(ctx);
});

// ---- faults: a reading that's wrong, a control that won't take, a gap

async function roastUntil(ctx, cond) {
  const {clock, sim, session} = ctx;
  session.start();
  session.selectBatch(ESPRESSO);
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.chargeBeans(155);
  await clock.until(cond, HOUR, 1500);
}

test('a discharge a minute after the drop starts no phantom roast', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  await roastUntil(ctx, () => log.some((x) => x.e === 'drop'));
  session.selectBatch(ESPRESSO); // the next beans, ready to go
  await clock.advance(65_000);
  sim.discharge();
  await clock.advance(3 * 60_000);
  assert.equal(log.filter((x) => x.e === 'charge').length, 1);
  assert.equal(session.pendingCharge, null);
  assert.equal(session.phase, 'PREHEAT');
  assert.ok(log.some((x) => x.e === 'batchComplete'));
  await finish(ctx);
});

test('one probe spike is not the door opening, nor the beans coming out', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  await roastUntil(ctx, () => sim.s.BT > 170);
  sim.probe.push(sim.s.BT + 8); // up: a fall from it looks like the door
  await clock.advance(20_000);
  assert.equal(session.phase, 'ROASTING');
  assert.ok(!log.some((x) => x.e === 'drop'));
  await clock.until(() => log.some((x) => x.e === 'drop'), HOUR, 1500);
  sim.probe.push(sim.s.BT - 15); // down, with the beans still in
  await clock.advance(10_000);
  assert.ok(!log.some((x) => x.e === 'beansOut'));
  assert.equal(sim.m.HS, 0, 'no heat with the beans in');
  sim.discharge();
  await clock.until(() => log.some((x) => x.e === 'beansOut'), 60_000, 1500);
  await finish(ctx);
});

test('one cool reading does not end the cool-down; hot ones after all-off resume it', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  session.done();
  await clock.advance(30_000);
  sim.probe.push(25);
  await clock.advance(10_000);
  assert.equal(session.phase, 'SHUTDOWN');
  assert.equal(sim.m.FC, 100);
  sim.probe.push(25, 25, 25); // a run of bad ones does end it...
  await clock.until(() => session.phase === 'OFF', 60_000, 1500);
  await clock.advance(10_000); // ...but the real, hot readings bring it back
  assert.equal(session.phase, 'SHUTDOWN');
  assert.ok(!said(log).some((t) => /unplug the roaster/.test(t)));
  assert.equal(sim.m.FC, 100);
  await finish(ctx);
});

test('too hot in preheat turns the heater off for the rest of the session', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  sim.probe.push(206, 207, 208);
  await clock.advance(10_000);
  assert.equal(session.overheated, true);
  assert.equal(sim.m.HS, 0);
  assert.ok(log.some((x) => x.e === 'alert' && /over 205/.test(x.a.text)));
  await clock.advance(10 * 60_000); // latched: normal readings don't undo it
  assert.equal(sim.m.HS, 0);
  assert.equal(session.noHeat(), 'overheated');
  await finish(ctx);
});

test('no heat while the roaster says the drum is stopped', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  await roastUntil(ctx, () => session.batch?.tp);
  sim.faults.ignore = ['RC'];
  sim.m.RC = 0; // the drum stops, and won't restart
  await clock.advance(12_000);
  assert.equal(sim.m.HS, 0);
  assert.ok(
    log.some((x) => x.e === 'alert' && /Drum.*Heater off/.test(x.a.text)),
  );
  sim.faults.ignore = [];
  await clock.advance(5000);
  assert.equal(sim.m.RC, 90);
  assert.equal(sim.m.HS, 1, 'heat again once it turns');
  await finish(ctx);
});

test('out of touch for minutes mid-roast ends the roast instead of carrying on', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, machine, session, log} = ctx;
  machine.on('error', () => {});
  await roastUntil(ctx, () => session.batch?.steps.length === 2);
  sim.unplugged = true;
  sim.close();
  await clock.advance(3 * 60_000);
  Object.assign(sim.m, {TS: 0, AH: 1, FC: 0, RC: 0}); // a power cycle
  sim.unplugged = false;
  await clock.advance(10_000);
  const drop = log.find((x) => x.e === 'drop').b;
  assert.equal(drop.reason, 'interrupted');
  assert.equal(session.phase, 'PREHEAT');
  assert.equal(sim.m.HS, 0, 'no heat with the beans maybe still in');
  assert.ok(
    log.some(
      (x) => x.e === 'alert' && /out of touch for 3 minutes/.test(x.a.text),
    ),
  );
  await finish(ctx);
});

test('first crack turns the tray fan on', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session} = ctx;
  await roastUntil(ctx, () => session.batch?.tp);
  assert.equal(sim.m.CS, 0);
  session.markFC();
  await clock.advance(3000);
  assert.equal(sim.m.CS, 1);
  await finish(ctx);
});

test('"all off" is said only once the roaster confirms it', async () => {
  const ctx = setup({dropRate: 0});
  const {clock, sim, session, log} = ctx;
  session.start();
  await clock.until(() => session.phase === 'READY', HOUR, 5000);
  session.done();
  sim.faults.ignore = ['RC']; // the drum won't stop
  sim.s.BT = 50; // (cool already)
  await clock.until(() => session.phase === 'OFF', HOUR, 1500);
  await clock.advance(20_000);
  assert.equal(session.offConfirmed, false);
  assert.ok(!said(log).some((t) => /unplug the roaster/.test(t)));
  sim.faults.ignore = [];
  await clock.advance(5000);
  assert.equal(session.offConfirmed, true);
  assert.ok(said(log).includes('All off. You can unplug the roaster.'));
  await finish(ctx);
});
