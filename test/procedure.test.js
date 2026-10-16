import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  resolve,
  loadProcedure,
  RoastTracker,
  preheatStable,
  rateOfRise,
  PROCEDURES_DIR,
} from '../server/procedure.js';
import fs from 'fs';

const proc = {
  bean: 'test',
  charge: {burner: 55, sv: 230},
  steps: [
    {bt: 150, burner: 45},
    {bt: 175, burner: 40, air: 40},
  ],
  variants: {espresso: {drop: {bt: 207}}, pourover: {drop: {bt: 204}}},
  history: [{}, {}],
};

test('variants override the base; the first is the default', () => {
  assert.equal(resolve(proc, 'pourover').drop.bt, 204);
  assert.equal(resolve(proc).variant, 'espresso');
  assert.equal(resolve(proc).version, 2);
  assert.throws(() => resolve(proc, 'cold brew'), /no "cold brew"/);
});

test('bad procedures are rejected', () => {
  const bad = (change) => () => resolve({...proc, ...change}, 'espresso');
  assert.throws(bad({charge: {burner: 55, sv: 200}}), /sv must sit well above/);
  assert.throws(
    bad({
      steps: [
        {bt: 175, burner: 40},
        {bt: 150, burner: 45},
      ],
    }),
    /increasing/,
  );
  assert.throws(bad({steps: [{bt: 150, burner: 140}]}), /bad step/);
  assert.throws(bad({steps: [{bt: 208, burner: 10}]}), /past the drop/);
  // Typos: 220 for 202, 15 for 150.
  const variants = (bt) => ({variants: {espresso: {drop: {bt}}}});
  assert.throws(bad(variants(220)), /outside 190-215/);
  assert.throws(bad(variants(185)), /outside 190-215/);
  assert.throws(bad({steps: [{bt: 15, burner: 45}]}), /under 100/);
  // Without one, the roast would start on whatever HP the PID left.
  assert.throws(bad({charge: {sv: 230}}), /charge needs a burner/);
});

test('the real procedures load', () => {
  assert.equal(loadProcedure('colombian_supremo', 'espresso').drop.bt, 207.4);
  assert.equal(loadProcedure('colombian_supremo', 'pourover').drop.bt, 204.3);
});

test('every procedure and variant is valid, for a bean in beans.json', () => {
  const beans = JSON.parse(
    fs.readFileSync(new URL('../beans.json', import.meta.url), 'utf8'),
  );
  const logs = fs.readdirSync(new URL('../logs/', import.meta.url));
  for (const f of fs.readdirSync(PROCEDURES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const bean = f.slice(0, -'.json'.length);
    assert.ok(beans[bean], `${bean} is in beans.json`);
    const raw = JSON.parse(fs.readFileSync(`${PROCEDURES_DIR}/${f}`, 'utf8'));
    assert.equal(raw.bean, bean, `${f} names its own bean`);
    assert.ok(raw.history?.length, `${bean} has a history`);
    for (const v of Object.keys(raw.variants ?? {null: 1})) {
      const p = loadProcedure(bean, v === 'null' ? null : v);
      // The reference curve has to be one roast in logs/ (the chart loads
      // it by number, or by file when the number is shared).
      const ref = p.reference;
      if (!ref) continue;
      const matches = ref.file
        ? logs.filter((l) => l === ref.file)
        : logs.filter(
            (l) => l.startsWith(`#${ref.roast}_`) && l.endsWith('.json'),
          );
      assert.equal(
        matches.length,
        1,
        `${bean}/${v}: reference ${ref.file ?? ref.roast}`,
      );
    }
  }
});

// Samples 1.5 s apart from a list of BTs.
const samples = (bts) => bts.map((BT, i) => ({t: i * 1500, BT}));

function run(tracker, bts) {
  return samples(bts).flatMap((s) =>
    tracker.feed(s).map((e) => e.type + (e.index ?? '')),
  );
}

test('steps wait for the turning point; the stale charge reading fires nothing', () => {
  const t = new RoastTracker(resolve(proc, 'espresso'));
  // At charge BT reads ~185 (above both steps), then dips, then climbs.
  const events = run(t, [185, 185, 184, 150, 120, 110, 109, 109, 112, 130]);
  assert.deepEqual(events, ['tp']);
  assert.deepEqual(run(t, [151, 152, 153, 160, 176, 177, 178]), [
    'step0',
    'step1',
  ]);
});

test('triggers need 3 readings in a row, so a spike fires nothing', () => {
  const t = new RoastTracker(resolve(proc, 'espresso'));
  run(t, [110, 109, 115, 180, 190, 200, 200, 200, 200]); // tp, both steps
  assert.deepEqual(run(t, [201, 250, 202, 203, 207.5, 203]), []);
  assert.deepEqual(run(t, [207, 207.2, 207.4]), ['drop']);
  assert.deepEqual(run(t, [210, 211, 212]), [], 'drops only once');
});

test('the drop never waits for the turning point', () => {
  const t = new RoastTracker(resolve(proc, 'espresso'), {tpRise: Infinity});
  assert.deepEqual(run(t, [185, 195, 205, 208, 208, 208]), ['drop']);
});

test('tracker state survives a save and restore', () => {
  const p = resolve(proc, 'espresso');
  const a = new RoastTracker(p);
  run(a, [110, 109, 115, 151, 152, 153]);
  const b = new RoastTracker(p, {}, JSON.parse(JSON.stringify(a)));
  assert.deepEqual(run(b, [160, 176, 177, 178]), ['step1']);
});

test('rate of rise is in °C per minute', () => {
  const s = samples([100, 100.5, 101, 101.5, 102]); // 0.5 per 1.5 s
  assert.ok(Math.abs(rateOfRise(s) - 20) < 1e-9);
});

test('preheat is stable when BT holds and ET stops rising (falling is fine)', () => {
  const cfg = {forSeconds: 180, btWithinC: 1.5, maxEtRiseCPerMin: 0.5};
  const window = (bt, et) =>
    Array.from({length: 130}, (_, i) => ({
      t: i * 1500,
      BT: bt(i),
      ET: et(i * 1.5),
    }));
  const flat = () => 185;
  const stable = (bt, et) => preheatStable(window(bt, et), 185, cfg);
  assert.ok(stable(flat, () => 180));
  assert.ok(
    stable(flat, (s) => 190 - s / 60),
    'ET falling',
  );
  assert.ok(!stable(flat, (s) => 170 + s / 60), 'ET rising');
  // The real first batch of 2026-10-04: ET overshot as BT reached SV, fell
  // ~10 °C, then climbed 2.5 °C/min. One fit over the window reads that V as
  // flat; it isn't ready.
  const dipThenClimb = (s) =>
    s < 80 ? 175 - (s * 12) / 80 : 163 + ((s - 80) * 2.5) / 60;
  assert.ok(!stable(flat, dipThenClimb), 'ET dipped, now climbing');
  assert.ok(!stable((i) => (i === 60 ? 187 : 185), flat), 'BT left the band');
  assert.ok(!preheatStable(window(flat, flat).slice(0, 60), 185, cfg));
});
