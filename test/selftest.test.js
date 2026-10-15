import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVirtualClock} from '../server/clock.js';
import {Machine} from '../server/machine.js';
import {SimKaleido} from '../server/sim.js';
import {runSelfTest} from '../server/selftest.js';

function setup({dropRate = 0.15, faults = {}} = {}) {
  const clock = createVirtualClock();
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const sim = new SimKaleido({clock, dropRate, random});
  Object.assign(sim.faults, faults);
  const machine = new Machine({clock, openTransport: () => sim.open()});
  machine.run();
  const lines = [];
  const asked = [];
  const run = runSelfTest({
    machine,
    clock,
    log: (l) => lines.push(l),
    ask: async (q) => asked.push(q),
    opts: {
      pullCable: () => {
        sim.unplugged = true;
        sim.close();
      },
      plugCable: () => (sim.unplugged = false),
    },
  });
  return {clock, sim, machine, run, lines, asked};
}

async function result({clock, run, machine}) {
  let report;
  run.then((r) => (report = r));
  await clock.until(() => report, 3 * 3600_000, 5000);
  const stopped = machine.stop();
  await clock.advance(5000);
  await stopped;
  return report;
}

test('a healthy (simulated) machine passes everything', async () => {
  const ctx = setup();
  const report = await result(ctx);
  const failed = report.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, []);
  assert.ok(report.checks.length >= 18);
  assert.ok(ctx.asked.some((q) => /EMPTY/.test(q)));
  const {setpointCap, pidDuty, hpReadsInManual} = report.observations;
  assert.equal(hpReadsInManual, 60);
  assert.ok(setpointCap.btChange < 0, 'capped burner: BT falls');
  assert.equal(pidDuty.length, 8);
  assert.ok(report.sends.FC > 0);
  // Ends with everything off.
  assert.deepEqual(
    {HS: ctx.sim.m.HS, HP: ctx.sim.m.HP, FC: ctx.sim.m.FC, RC: ctx.sim.m.RC},
    {HS: 0, HP: 0, FC: 0, RC: 0},
  );
});

test("a burner that won't light fails, and the test still shuts down", async () => {
  const ctx = setup({faults: {burner: true}});
  const report = await result(ctx);
  const burner = report.checks.find((c) => c.name === 'manual burner heats');
  assert.equal(burner.ok, false);
  assert.match(burner.detail, /in 4 min/);
  assert.ok(!report.checks.some((c) => /auto mode \(PID\)/.test(c.name)));
  assert.equal(report.checks.at(-1).ok, true, 'shutdown still ran');
  assert.equal(report.passed, false);
  assert.equal(ctx.sim.m.HS, 0);
});

test('no machine: fails the first check, sends nothing', async () => {
  const clock = createVirtualClock();
  const machine = new Machine({
    clock,
    openTransport: async () => {
      throw new Error('Roaster not found');
    },
  });
  machine.on('error', () => {});
  machine.run();
  const ctx = {clock, machine};
  ctx.run = runSelfTest({machine, clock, log: () => {}, ask: async () => {}});
  const report = await result(ctx);
  assert.equal(report.checks.length, 1);
  assert.match(report.checks[0].detail, /no connection/);
});

test('a control that never takes fails only the checks that use it', async () => {
  const ctx = setup({faults: {ignore: ['CS']}});
  const report = await result(ctx);
  const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  // Every failure involves the cooling fan; nothing else is dragged down.
  assert.deepEqual(failed, [
    'control: cooling fan on',
    'control: cooling fan off',
    'cooling fan',
    'all off',
  ]);
  assert.match(report.checks.at(-1).detail, /^not echoed: CS wants 0/);
  // And everything else still ends up off.
  assert.deepEqual(
    {HS: ctx.sim.m.HS, HP: ctx.sim.m.HP, FC: ctx.sim.m.FC, RC: ctx.sim.m.RC},
    {HS: 0, HP: 0, FC: 0, RC: 0},
  );
});

test('the heater is off before the cable pull', async () => {
  const ctx = setup();
  let heaterAtPull = null;
  const pull = ctx.sim.close.bind(ctx.sim);
  ctx.sim.close = () => {
    // (The watchdog check also closes the port, mid-heat, on purpose. The
    // cable pull is the close that happens while unplugged.)
    if (ctx.sim.unplugged) heaterAtPull ??= ctx.sim.m.HS;
    pull();
  };
  await result(ctx);
  assert.equal(heaterAtPull, 0);
});

test('the watchdog check reports what the roaster did while the computer was silent', async () => {
  const ctx = setup();
  const report = await result(ctx);
  const w = report.observations.watchdog;
  // The simulator has no watchdog: it keeps heating, like a roaster would
  // that needs the computer to turn it off.
  assert.equal(w.silentSeconds, 45);
  assert.ok(w.after.BT > w.before.BT);
  assert.match(w.verdict, /KEPT HEATING/);
  assert.equal(report.passed, true);
});

test('skipping the cool-down leaves the air and drum cooling, heater off', async () => {
  const clock = createVirtualClock();
  const sim = new SimKaleido({clock});
  const machine = new Machine({clock, openTransport: () => sim.open()});
  machine.run();
  const ctx = {clock, machine};
  ctx.run = runSelfTest({
    machine,
    clock,
    log: () => {},
    ask: async () => {},
    opts: {cable: false, offerSkip: () => ({skipped: () => true})},
  });
  const report = await result(ctx);
  assert.equal(
    report.checks.at(-1).name,
    'heater off, air and drum left cooling',
  );
  assert.equal(report.passed, true);
  assert.deepEqual(
    {HS: sim.m.HS, HP: sim.m.HP, FC: sim.m.FC, RC: sim.m.RC},
    {HS: 0, HP: 0, FC: 100, RC: 90},
  );
});
