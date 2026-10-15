import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {createVirtualClock} from '../server/clock.js';
import {Machine} from '../server/machine.js';
import {SimKaleido} from '../server/sim.js';
import {Session} from '../server/session.js';
import {Recorder} from '../server/recorder.js';
import {loadProcedure} from '../server/procedure.js';
import {autopilot} from '../server/autopilot.js';
import {EventEmitter} from 'events';
import {fileURLToPath} from 'url';
import {readRoast, writeRoast, indexAt} from '../server/roastlog.js';

const preheat = JSON.parse(
  fs.readFileSync(new URL('../preheat.json', import.meta.url), 'utf8'),
);
const beans = JSON.parse(
  fs.readFileSync(new URL('../beans.json', import.meta.url), 'utf8'),
);
const ESPRESSO = {
  bean: 'colombian_supremo',
  variant: 'espresso',
  weightIn: 155,
};
const HOUR = 3600_000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaleido-'));
  // An older Artisan-only roast already in the directory.
  fs.writeFileSync(
    path.join(dir, '#41_brazil_cerrado_26-10-01_0900.json'),
    '{}',
  );
  const clock = createVirtualClock(Date.parse('2026-10-04T10:00:00'));
  const sim = new SimKaleido({clock});
  const machine = new Machine({clock, openTransport: () => sim.open()});
  let recorder;
  const session = new Session({
    machine,
    clock,
    preheat,
    loadProcedure,
    nextRoastNumber: () => recorder.nextRoastNumber(),
  });
  recorder = new Recorder({session, dir, beans});
  machine.run();
  session.start();
  return {dir, clock, sim, machine, session, recorder};
}

const files = (dir) => fs.readdirSync(dir).sort();

async function finish({clock, machine, dir}) {
  const stopped = machine.stop();
  await clock.advance(5000);
  await stopped;
  fs.rmSync(dir, {recursive: true});
}

test('a roast log keeps its readings one column to a line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaleido-'));
  const file = path.join(dir, '#1_x_26-10-15_0900.json');
  const record = {
    roast: 1,
    notes: [{date: null, text: "it's\nfine"}],
    samples: {t: [-1.5, 0, 1.5], BT: [185.2, null, 120]},
  };
  writeRoast(file, record);
  assert.deepEqual(readRoast(file), record);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.ok(lines.includes('    "BT": [185.2,null,120]'), lines.join('\n'));
  fs.rmSync(dir, {recursive: true});
});

test('a roast is written as it happens, then finalized', async () => {
  const ctx = setup();
  const {dir, clock, sim, session} = ctx;
  autopilot(session, sim, clock, {batches: [ESPRESSO]});
  await clock.until(() => session.batch?.steps.length === 2, 2 * HOUR, 1500);

  // Mid-roast: the file exists already, numbered after the highest roast.
  const base = '#42_colombian_supremo_espresso_26-10-04_1000';
  assert.deepEqual(files(dir).slice(1), [`${base}.json`]);
  let r = readRoast(path.join(dir, `${base}.json`));
  assert.equal(r.drop, null, 'no drop yet');
  const charged = indexAt(r.samples.t, 0);
  assert.equal(r.samples.t[charged], 0, 'the charge is a reading');
  assert.ok(Math.abs(r.charge.BT - 185) < 1.5, `CHARGE BT ${r.charge.BT}`);

  await clock.until(() => session.phase === 'OFF', 3 * HOUR, 5000);
  r = readRoast(path.join(dir, `${base}.json`));
  const S = r.samples;
  assert.ok(0 < r.tp.t && r.tp.t < r.dry.t && r.dry.t < r.fc.t);
  assert.ok(r.fc.t < r.drop.t && r.drop.t < r.beansOut.t);
  // Every event sits on (or just after) the reading that caused it.
  for (const ev of [r.tp, r.dry, ...r.steps])
    assert.ok(S.t.includes(ev.t), `${ev.t} is a reading`);
  for (const ev of [r.fc, r.drop])
    assert.equal(S.BT[indexAt(S.t, ev.t)], ev.BT);
  assert.ok(r.drop.BT >= 207.4);
  assert.equal(r.dry.BT >= 152, true);
  assert.equal(r.weightIn, 155);
  assert.equal(r.weightOut, null);
  assert.equal(r.source, 'app');
  // The burner changes are all in the readings, in roast order, ending
  // with the burner off at the drop (auto mode's HP is the PID's: skipped).
  const end = indexAt(S.t, r.drop.t) + 3;
  const burner = [];
  for (let i = charged; i <= end; i++)
    if (S.HP[i] !== S.HP[i - 1] && (S.AH[i] === 0 || S.AH[i - 1] === 0))
      burner.push(S.HP[i]);
  assert.deepEqual(burner, [55, 45, 40, 35, 30, 25, 15, 0]);
  for (const k of ['BT', 'ET', 'HP', 'FC', 'RC', 'TS', 'AT', 'AH', 'HS', 'CS'])
    assert.equal(S[k].length, S.t.length, k);
  assert.equal(r.steps.length, 6);
  assert.ok(r.steps.every((s, i) => i === 0 || s.t > r.steps[i - 1].t));
  assert.equal(r.procedure.version, 2);
  await finish(ctx);
});

test('weight out and tasting notes patch the log later', async () => {
  const ctx = setup();
  const {dir, clock, sim, session, recorder} = ctx;
  autopilot(session, sim, clock, {batches: [ESPRESSO]});
  await clock.until(() => session.phase === 'OFF', 3 * HOUR, 5000);
  const file = path.join(
    dir,
    '#42_colombian_supremo_espresso_26-10-04_1000.json',
  );
  const before = readRoast(file);
  recorder.setWeightOut(42, 131.5);
  recorder.addNote(42, 'Chocolate, a bit flat.', new Date('2026-10-06'));
  const r = readRoast(file);
  assert.equal(r.weightOut, 131.5);
  assert.deepEqual(r.notes, [
    {date: '2026-10-06', text: 'Chocolate, a bit flat.'},
  ]);
  assert.deepEqual(r.samples, before.samples, 'readings untouched');
  assert.throws(() => recorder.setWeightOut(99, 100), /no roast #99/);
  assert.throws(() => recorder.setWeightOut(42, 'abc'), /grams/);
  assert.equal(readRoast(file).weightOut, 131.5, 'left as it was');
  await finish(ctx);
});

test('notes on an older Artisan roast add up, and leave the rest alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaleido-'));
  const name = '#7_ethiopiques_v2_26-06-14_1418.json';
  // ('#' would start a URL fragment, so build the path from the folder.)
  const logs = fileURLToPath(new URL('../logs/', import.meta.url));
  fs.copyFileSync(path.join(logs, name), path.join(dir, name));
  const before = readRoast(path.join(dir, name));
  const recorder = new Recorder({session: new EventEmitter(), dir, beans});
  recorder.addNote(7, 'Blueberry.', new Date('2026-10-05'));
  recorder.setWeightOut(7, 130);
  recorder.addNote(7, 'Even better a week on.', new Date('2026-10-12'));
  const r = readRoast(path.join(dir, name));
  assert.deepEqual(
    r.notes.map((n) => n.text),
    [
      ...before.notes.map((n) => n.text),
      'Blueberry.',
      'Even better a week on.',
    ],
  );
  assert.equal(r.weightOut, 130);
  const {notes, weightOut, ...rest} = r;
  const {notes: n0, weightOut: w0, ...rest0} = before;
  assert.deepEqual(rest, rest0);
  fs.rmSync(dir, {recursive: true});
});

test('a roast number used twice has to be given by file name', () => {
  // Old logs have two #7s and two #25s.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaleido-'));
  const logs = fileURLToPath(new URL('../logs/', import.meta.url));
  const names = ['#7_ethiopiques_v2_26-06-14_1418', '#7_other_26-06-15_0900'];
  for (const n of names)
    fs.copyFileSync(
      path.join(logs, '#7_ethiopiques_v2_26-06-14_1418.json'),
      path.join(dir, `${n}.json`),
    );
  const recorder = new Recorder({session: new EventEmitter(), dir, beans});
  assert.throws(() => recorder.setWeightOut(7, 130), /ambiguous.*file name/);
  recorder.setWeightOut(names[1], 130);
  assert.equal(readRoast(path.join(dir, `${names[0]}.json`)).weightOut, null);
  assert.equal(readRoast(path.join(dir, `${names[1]}.json`)).weightOut, 130);
  assert.throws(() => recorder.addNote('../x', 'no'), /no roast/);
  fs.rmSync(dir, {recursive: true});
});

test("a log that can't be saved doesn't stop the roast", async () => {
  const ctx = setup();
  const {dir, clock, sim, session} = ctx;
  // The folder vanishes and a file takes its place: every write now fails.
  fs.rmSync(dir, {recursive: true});
  fs.writeFileSync(dir, '');
  const alerts = [];
  session.on('alert', (a) => alerts.push(a));
  let off = false;
  autopilot(session, sim, clock, {batches: [ESPRESSO]}).then(
    () => (off = true),
  );
  await clock.until(() => off, 3 * HOUR, 5000);
  assert.ok(session.batch == null && session.phase === 'OFF');
  const saveAlerts = alerts.filter((a) => /couldn't save/i.test(a.text));
  assert.equal(saveAlerts.length, 1, 'reported once, not on every retry');
  fs.rmSync(dir);
  fs.mkdirSync(dir);
  await finish(ctx);
});
