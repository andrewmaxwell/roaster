import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClock, createVirtualClock} from '../server/clock.js';
import {encode, parse} from '../server/protocol.js';
import {Machine} from '../server/machine.js';
import {SimKaleido} from '../server/sim.js';
import {emergencyStop} from '../server/stop.js';

const PREHEAT = {TS: 185, HS: 1, AH: 1, FC: 30, RC: 90};

for (const reconnect of [false, true]) {
  test(`${reconnect ? 'reconnecting' : 'connecting'} cannot enable heat before a fresh BT`, async () => {
    const clock = createVirtualClock();
    const sim = new SimKaleido({clock});
    const machine = new Machine({clock, openTransport: () => sim.open()});
    const readings = sim.readings.bind(sim);
    if (!reconnect) sim.readings = () => ({...readings(), BT: 'ERR'});
    machine.set(PREHEAT);
    machine.run();
    try {
      await clock.until(() => machine.connected, 10_000);
      if (reconnect) {
        await clock.until(() => sim.m.HS === 1, 10_000);
        sim.close();
        sim.readings = () => ({...readings(), BT: 'ERR'});
        await clock.until(() => !machine.connected, 5000, 100);
        await clock.until(() => machine.connected, 10_000, 100);
        sim.accepted.length = 0;
      }
      await clock.advance(10_000);
      assert.ok(!sim.accepted.some((a) => a.tag === 'HS' && a.value === 1));
      assert.equal(sim.m.HS, 0);
      sim.readings = readings;
      await clock.until(() => sim.m.HS === 1, 10_000);
    } finally {
      const stopped = machine.stop();
      await clock.advance(5000);
      await stopped;
    }
  });
}

test('monitoring with no desired controls never writes controls, even without BT', async () => {
  const clock = createVirtualClock();
  const sim = new SimKaleido({clock});
  const readings = sim.readings.bind(sim);
  sim.readings = () => ({...readings(), BT: 'ERR'});
  const machine = new Machine({clock, openTransport: () => sim.open()});
  machine.run();
  await clock.advance(15_000);
  const stopped = machine.stop();
  await clock.advance(5000);
  await stopped;
  assert.deepEqual(sim.accepted, []);
});

test('heater-off confirmation requires a fresh heater report, not unrelated replies', async () => {
  const clock = createVirtualClock();
  const machine = new Machine({clock, openTransport: async () => {}});
  machine.onLine('{0,BT:185,HS:0,AH:0,HP:0}');
  machine.heaterOff();
  await clock.advance(2000);
  machine.onLine('{0,FC:100}');
  assert.equal(machine.heaterConfirmedOff(), false);
  machine.onLine('{0,HS:0}');
  assert.equal(machine.heaterConfirmedOff(), true);
  machine.teardown();
  machine.onLine('{0,AH:0,HP:0}');
  assert.equal(machine.heaterConfirmedOff(), false);
});

// A deterministic "random" so drop-rate tests are repeatable.
function seeded(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

async function setup({speed = 200, dropRate = 0} = {}) {
  const clock = createClock(speed);
  const sim = new SimKaleido({clock, dropRate, random: seeded(42)});
  const machine = new Machine({openTransport: () => sim.open(), clock});
  const errors = [];
  machine.on('error', (e) => errors.push(e.message));
  machine.run();
  await until(clock, () => machine.connected, 10_000);
  return {clock, sim, machine, errors};
}

// Waits up to `ms` of simulated time for cond() to be true.
async function until(clock, cond, ms) {
  const end = clock.now() + ms;
  while (!cond()) {
    if (clock.now() > end) throw new Error('timed out');
    await clock.sleep(100);
  }
}

test('protocol encodes like Artisan and parses replies', () => {
  assert.equal(encode('PI'), '{[PI]}\n');
  assert.equal(encode('TS', 207.4), '{[TS 207]}\n');
  assert.equal(encode('RD', 'A0'), '{[RD A0]}\n');
  assert.deepEqual(parse('{3,BT:185.2,HP:45,TU:C,SN:ab}'), {
    sid: 3,
    vars: {BT: 185.2, HP: 45, TU: 'C', SN: 'ab'},
  });
  assert.equal(parse('garbage'), null);
});

test('desired state converges even when the machine drops a third of commands', async () => {
  const {clock, sim, machine} = await setup({dropRate: 0.33});
  machine.set(PREHEAT);
  await until(clock, () => machine.settled(), 30_000);
  assert.deepEqual(
    {TS: sim.m.TS, HS: sim.m.HS, AH: sim.m.AH, FC: sim.m.FC, RC: sim.m.RC},
    PREHEAT,
  );
  await machine.stop();
});

test('switching to manual sends TS, then AH 0, then HP, even with drops', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const clock = createClock(200);
    const sim = new SimKaleido({clock, dropRate: 0.4, random: seeded(seed)});
    const machine = new Machine({openTransport: () => sim.open(), clock});
    machine.run();
    machine.set(PREHEAT);
    await until(clock, () => machine.settled(), 30_000);
    sim.accepted.length = 0;
    machine.set({TS: 230, AH: 0, HP: 55});
    await until(clock, () => machine.settled(), 30_000);
    const order = sim.accepted.map((a) => a.tag);
    assert.ok(
      order.indexOf('TS') < order.indexOf('AH'),
      `seed ${seed}: ${order}`,
    );
    assert.ok(
      order.indexOf('AH') < order.indexOf('HP'),
      `seed ${seed}: ${order}`,
    );
    assert.equal(sim.m.HP, 55);
    await machine.stop();
  }
});

test('HP is left alone in auto mode', async () => {
  const {clock, sim, machine} = await setup();
  machine.set({...PREHEAT, HP: 0});
  await clock.sleep(10_000);
  assert.ok(!sim.accepted.some((a) => a.tag === 'HP'));
  assert.ok(machine.settled());
  await machine.stop();
});

test('reconnects after a cable pull and re-applies the desired state', async () => {
  const {clock, sim, machine} = await setup();
  machine.set(PREHEAT);
  await until(clock, () => machine.settled(), 10_000);
  const events = [];
  machine.on('disconnected', () => events.push('disconnected'));
  machine.on('connected', () => events.push('connected'));
  sim.close();
  sim.m.FC = 0; // something changed while we were away
  await until(clock, () => events.includes('connected'), 10_000);
  await until(clock, () => machine.settled(), 10_000);
  assert.deepEqual(events, ['disconnected', 'connected']);
  assert.equal(sim.m.FC, 30);
  await machine.stop();
});

test('a silent machine counts as disconnected, then recovers', async () => {
  const {clock, sim, machine, errors} = await setup();
  let down = false;
  machine.on('disconnected', () => (down = true));
  sim.muted = true;
  await until(clock, () => down, 15_000);
  assert.match(errors.join(), /stopped answering/);
  sim.muted = false;
  await until(clock, () => machine.connected, 15_000);
  await machine.stop();
});

test('reports a control that never takes', async () => {
  const {clock, sim, machine} = await setup();
  const stuck = [];
  machine.on('stuck', (s) => stuck.push(s));
  sim.dropRate = 1;
  sim.random = () => 0;
  machine.set({FC: 55});
  await until(clock, () => stuck.length > 0, 20_000);
  assert.deepEqual(stuck[0], {control: 'FC', want: 55, got: 0});
  await machine.stop();
});

test("time a control spent in the PID's hands never counts as stuck", async () => {
  // The drop sets HP 0 and switches to auto mode at once. If that HP 0 is
  // lost, HP still reads the old burner; "Done for today" minutes later
  // takes HP back, and that must not alarm before HP 0 has even been sent.
  const {clock, sim, machine} = await setup();
  machine.set({TS: 240, HS: 1, AH: 0, HP: 15, FC: 30, RC: 90});
  await until(clock, () => machine.settled(), 10_000);
  sim.faults.ignore = ['HP'];
  machine.set({HP: 0});
  machine.set({TS: 185, HS: 0, AH: 1});
  await until(clock, () => machine.settled() && sim.m.AH === 1, 10_000);
  await clock.sleep(20_000);
  sim.faults.ignore = [];
  const stuck = [];
  machine.on('stuck', (s) => stuck.push(s));
  machine.set({HS: 0, AH: 0, HP: 0, FC: 100});
  await until(clock, () => machine.settled(), 10_000);
  assert.deepEqual(stuck, []);
  assert.equal(sim.m.HP, 0);
  await machine.stop();
});

test('polling keeps its place in a busy write queue', async () => {
  // Writes drain one per 100 ms; flood the queue faster than that, the way
  // resends pile up after a reconnect, and readings must still arrive.
  const clock = createClock(200);
  const sim = new SimKaleido({clock});
  const machine = new Machine({openTransport: () => sim.open(), clock});
  machine.run();
  await until(clock, () => machine.connected, 10_000);
  let samples = 0;
  machine.on('sample', () => samples++);
  const flood = setInterval(() => {
    for (const tag of ['EV']) machine.enqueue(tag, 1);
    machine.enqueue('FC', Math.round(Math.random() * 100));
  }, 0);
  await clock.sleep(15_000);
  clearInterval(flood);
  assert.ok(samples >= 5, `only ${samples} readings in 15 s`);
  await machine.stop();
});

test('a setpoint above the machine maximum is clamped, so it still settles', async () => {
  const {clock, sim, machine} = await setup();
  machine.set({TS: 250, HS: 0, AH: 0});
  await until(clock, () => machine.settled(), 10_000);
  assert.equal(machine.desired.TS, 240);
  assert.equal(sim.m.TS, 240);
  await machine.stop();
});

test('once the heater is locked off, nothing turns it back on', async () => {
  const {clock, sim, machine} = await setup();
  machine.set(PREHEAT);
  await until(clock, () => machine.settled(), 10_000);
  machine.heaterOff({FC: 100});
  // What a step firing (or a click) does while main.js waits to quit.
  machine.set({TS: 230, HS: 1, AH: 0, HP: 45});
  await until(clock, () => machine.heaterConfirmedOff(), 10_000);
  assert.deepEqual(
    {HS: sim.m.HS, AH: sim.m.AH, HP: sim.m.HP, FC: sim.m.FC, TS: sim.m.TS},
    {HS: 0, AH: 0, HP: 0, FC: 100, TS: 230},
  );
  await machine.stop();
});

test('a heat command still queued when the heater is locked off never goes out', async () => {
  const {clock, sim, machine} = await setup();
  machine.set({...PREHEAT, HS: 0});
  await until(clock, () => machine.settled(), 10_000);
  machine.event(1); // occupies the writer, so the next command waits
  machine.set({HS: 1});
  machine.heaterOff();
  await until(clock, () => machine.heaterConfirmedOff(), 10_000);
  await clock.sleep(3000);
  assert.equal(sim.m.HS, 0);
  assert.ok(!sim.accepted.some((a) => a.tag === 'HS' && a.value === 1));
  await machine.stop();
});

test('with no BT readings, the heater is held off until they come back', async () => {
  const {clock, sim, machine} = await setup();
  const blind = [];
  machine.on('blind', (b) => blind.push(b));
  machine.set({TS: 230, HS: 1, AH: 0, HP: 45, FC: 30, RC: 90});
  await until(clock, () => machine.settled(), 10_000);
  const readings = sim.readings.bind(sim);
  sim.readings = () => {
    const r = readings();
    r.BT = 'ERR'; // a probe fault: not a number is no reading either
    return r;
  };
  await until(clock, () => sim.m.HS === 0 && sim.m.HP === 0, 15_000);
  assert.ok(machine.connected, 'still talking to the roaster');
  assert.deepEqual(blind, [true]);
  sim.readings = readings;
  await until(clock, () => sim.m.HS === 1 && sim.m.HP === 45, 15_000);
  assert.deepEqual(blind, [true, false]);
  await machine.stop();
});

test('percentages are sent and matched as integers', async () => {
  const {clock, sim, machine} = await setup();
  machine.set({FC: 45.5, RC: 90});
  await until(clock, () => machine.settled(), 10_000);
  assert.equal(sim.m.FC, 46);
  await machine.stop();
});

test('the emergency stop turns the heater off even with no BT readings', async () => {
  const clock = createClock(200);
  const sim = new SimKaleido({clock, dropRate: 0});
  Object.assign(sim.m, {TS: 230, HS: 1, AH: 0, HP: 60});
  const readings = sim.readings.bind(sim);
  sim.readings = () => {
    const r = readings();
    delete r.BT;
    return r;
  };
  const {ok, message} = await emergencyStop({
    openTransport: () => sim.open(),
    clock,
  });
  assert.ok(ok, message);
  assert.deepEqual(
    {HS: sim.m.HS, HP: sim.m.HP, FC: sim.m.FC},
    {HS: 0, HP: 0, FC: 100},
  );
  assert.match(message, /BT unknown/);
});
