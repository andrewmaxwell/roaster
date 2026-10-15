import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SimKaleido} from '../server/sim.js';

// The simulated machine on a hand-driven clock, so minutes take no time.
async function bench() {
  const clock = {t: 0, now: () => clock.t};
  const sim = new SimKaleido({clock});
  await sim.open();
  const read = () => {
    const r = sim.readings();
    return {...r, BT: +r.BT, ET: +r.ET};
  };
  return {clock, sim, read};
}

test('preheat from cold settles at the setpoint within ~20 minutes', async () => {
  const {clock, sim, read} = await bench();
  Object.assign(sim.m, {TS: 185, HS: 1, AH: 1, FC: 30, RC: 90});
  clock.t = 20 * 60_000;
  const r = read();
  assert.ok(Math.abs(r.BT - 185) < 1.5, `BT ${r.BT}`);
  assert.ok(r.HP > 5 && r.HP < 50, `PID duty ${r.HP}`);
});

test('no heat without HS, even in auto mode', async () => {
  const {clock, sim, read} = await bench();
  Object.assign(sim.m, {TS: 185, HS: 0, AH: 1, FC: 30, RC: 90});
  clock.t = 10 * 60_000;
  assert.ok(read().BT < 30);
});

test('the setpoint caps the burner in manual mode', async () => {
  const {clock, sim, read} = await bench();
  Object.assign(sim.m, {TS: 120, HS: 1, AH: 0, HP: 100, FC: 30, RC: 90});
  clock.t = 30 * 60_000;
  assert.ok(read().BT < 130, `BT ${read().BT}`);
});

test('a charged roast looks like a real one', async () => {
  const {clock, sim, read} = await bench();
  Object.assign(sim.m, {TS: 185, HS: 1, AH: 1, FC: 30, RC: 90});
  clock.t = 25 * 60_000;
  sim.chargeBeans(155); // (brings the sim up to now before settings change)
  Object.assign(sim.m, {TS: 230, AH: 0, HP: 55});
  const t0 = clock.t;
  const steps = [
    [154, {HP: 45}],
    [175, {HP: 40, FC: 40}],
    [178, {HP: 35}],
    [190, {HP: 30}],
    [194, {HP: 25}],
    [198, {HP: 15}],
  ];
  let tp = Infinity;
  let drop = null;
  while (clock.t - t0 < 15 * 60_000) {
    clock.t += 1500;
    const {BT} = read(); // advances the sim, so changing settings next is safe
    tp = Math.min(tp, BT);
    if (BT > tp + 2)
      while (steps.length && BT >= steps[0][0])
        Object.assign(sim.m, steps.shift()[1]);
    if (BT >= 207.4) {
      drop = (clock.t - t0) / 60_000;
      break;
    }
  }
  // Real Colombian Supremo roasts: TP ~110, drop 10-11 min.
  assert.ok(tp > 95 && tp < 125, `TP ${tp}`);
  assert.ok(drop > 9 && drop < 13.5, `drop at ${drop} min`);
});
