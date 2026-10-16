// The app server's startup: resuming a saved session from disk. (A bug here
// once threw partway through a resume, 2026-10-04.)

import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {createVirtualClock} from '../server/clock.js';
import {Machine} from '../server/machine.js';
import {SimKaleido} from '../server/sim.js';
import WebSocket from 'ws';
import {startApp, allowedOrigin} from '../server/app.js';
import {writeRoast} from '../server/roastlog.js';

function start(saved, {roasts = []} = {}) {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaleido-app-'));
  for (const r of roasts)
    writeRoast(path.join(logsDir, `#${r.roast}_${r.bean}.json`), r);
  const clock = createVirtualClock(Date.parse('2026-10-04T12:00:00'));
  if (saved)
    fs.writeFileSync(
      path.join(logsDir, '.session.json'),
      JSON.stringify({savedAt: clock.now() - 30_000, state: saved}),
    );
  const sim = new SimKaleido({clock});
  const machine = new Machine({clock, openTransport: () => sim.open()});
  const logged = mock.method(console, 'log', () => {});
  // sim: null takes the real roaster's path (the sim never resumes).
  const app = startApp({machine, clock, sim: null, port: 0, logsDir});
  const lines = logged.mock.calls.map((c) => c.arguments.join(' '));
  logged.mock.restore();
  // Close only once it's listening: closing first lets the listen finish
  // afterwards, and the test process never exits.
  const stop = async () => {
    app.saveNow(); // nothing left to write after the folder is gone
    if (!app.server.listening)
      await new Promise((r) => app.server.once('listening', r));
    await new Promise((r) => app.server.close(r));
    fs.rmSync(logsDir, {recursive: true});
  };
  return {app, machine, lines, stop};
}

const saved = (phase) => ({
  phase,
  next: {bean: 'colombian_supremo', variant: 'espresso', weightIn: 155},
  batch: null,
  tracker: null,
  planned: {},
  cooling: false,
  doneRequested: false,
  log: [],
  alarms: {},
});

test('a saved session resumes cleanly, beans and all', async () => {
  const {app, machine, lines, stop} = start(saved('PREHEAT'));
  assert.ok(!lines.some((l) => /couldn't resume/.test(l)), lines.join('\n'));
  const session = app.getSession();
  assert.equal(session.phase, 'PREHEAT');
  assert.equal(session.next.bean, 'colombian_supremo');
  assert.equal(machine.desired.HS, 1, 'preheat heat is wanted again');
  await stop();
});

test('a session saved as ready resumes as preheating', async () => {
  const {app, stop} = start(saved('READY'));
  assert.equal(app.getSession().phase, 'PREHEAT');
  await stop();
});

test("a resume still works when the next beans' procedure is gone", async () => {
  // Procedures get edited between batches; a renamed bean or variant must
  // not cost the resume (or leave a session that never got started).
  const state = saved('PREHEAT');
  state.next = {bean: 'no_such_bean', variant: null, weightIn: 155};
  const {app, machine, lines, stop} = start(state);
  assert.ok(!lines.some((l) => /couldn't resume/.test(l)), lines.join('\n'));
  const session = app.getSession();
  assert.equal(session.phase, 'PREHEAT');
  assert.equal(session.next, null, 'the beans have to be chosen again');
  assert.equal(machine.desired.HS, 1, 'preheating');
  await stop();
});

test('a resume that fails leaves no half-started session behind', async () => {
  const state = saved('ROASTING'); // a roast with no batch can't resume
  state.next = null;
  const {app, machine, lines, stop} = start(state);
  assert.ok(
    lines.some((l) => /couldn't resume/.test(l)),
    lines.join('\n'),
  );
  assert.equal(app.getSession(), null, 'a new session can be started');
  assert.equal(machine.desired.HS, 0, 'nothing is heating');
  await stop();
});

test('with nothing to resume, the heater is set off', async () => {
  const {app, machine, stop} = start(null);
  assert.equal(app.getSession(), null);
  assert.equal(machine.desired.HS, 0);
  await stop();
});

test('serves the page and its scripts, and nothing else in the folder', async () => {
  const {app, stop} = start(null);
  if (!app.server.listening)
    await new Promise((r) => app.server.once('listening', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const status = async (p) => (await fetch(base + p)).status;
  for (const p of ['/', '/index.html', '/main.js', '/ui/charts.js'])
    assert.equal(await status(p), 200, p);
  assert.equal(await status('/ui/vendor/uPlot.min.css'), 200);
  for (const p of [
    '/server/app.js',
    '/package.json',
    '/CLAUDE.md',
    '/AGENTS.md',
    '/procedures/colombian_supremo.json',
    '/node_modules/ws/package.json',
    '/ui/../server/app.js',
  ])
    assert.equal(await status(p), 404, p);
  await stop();
});

test('the bean list is the beans in stock, most recently roasted first', async () => {
  const {app, stop} = start(null);
  if (!app.server.listening)
    await new Promise((r) => app.server.once('listening', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const list = await (await fetch(`${base}/api/procedures`)).json();
  const stock = JSON.parse(
    fs.readFileSync(new URL('../inventory.json', import.meta.url), 'utf8'),
  ).beans;
  const procs = fs
    .readdirSync(new URL('../procedures/', import.meta.url))
    .map((f) => f.slice(0, -5));
  assert.deepEqual(
    list.map((p) => p.bean).sort(),
    procs.filter((b) => stock[b]?.batches > 0).sort(),
  );
  // Newest first; never-roasted beans (null) last.
  const dates = list.map((p) => p.lastRoasted ?? '');
  assert.deepEqual(dates, [...dates].sort().reverse());
  await stop();
});

test('only pages from this machine may use the WebSocket', async () => {
  assert.ok(allowedOrigin('http://localhost:3100'));
  assert.ok(allowedOrigin('http://127.0.0.1:3100'));
  assert.ok(allowedOrigin(undefined), 'not a browser');
  assert.ok(!allowedOrigin('https://example.com'));
  assert.ok(!allowedOrigin('http://localhost.example.com:3100'));
  assert.ok(!allowedOrigin('http://evil.com:3100'), 'DNS rebinding');

  const {app, stop} = start(null);
  if (!app.server.listening)
    await new Promise((r) => app.server.once('listening', r));
  const url = `ws://127.0.0.1:${app.server.address().port}/ws`;
  const opens = (origin) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, {origin});
      ws.on('open', () => (ws.close(), resolve(true)));
      ws.on('error', () => resolve(false));
    });
  assert.equal(await opens('http://localhost:3100'), true);
  assert.equal(await opens('https://example.com'), false);
  await stop();
});

test('a restart keeps the last roast, so its weight out can still be entered', async () => {
  const roast = (n, hoursAgo) => ({
    roast: n,
    bean: 'colombian_supremo',
    variant: 'espresso',
    chargedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    weightIn: 155,
    weightOut: null,
    fc: {t: 420, BT: 188},
    drop: {t: 600, BT: 207.6, reason: 'temperature'},
    samples: {t: [0], BT: [185]},
  });
  const a = start(null, {roasts: [roast(41, 30), roast(42, 1)]});
  const last = a.app.snapshot().lastBatch;
  assert.equal(last.number, 42);
  assert.equal(last.weightOut, null);
  assert.deepEqual(last.drop, {s: 600, BT: 207.6});
  await a.stop();
  // Yesterday's isn't "the last roast" any more.
  const b = start(null, {roasts: [roast(41, 30)]});
  assert.equal(b.app.snapshot().lastBatch, null);
  await b.stop();
});

test('an OFF the roaster never confirmed resumes, to turn things off again', async () => {
  const a = start({...saved('OFF'), next: null, offConfirmed: false});
  assert.equal(a.app.getSession()?.phase, 'OFF');
  assert.deepEqual(
    {FC: a.machine.desired.FC, RC: a.machine.desired.RC},
    {FC: 0, RC: 0},
  );
  await a.stop();
  const b = start({...saved('OFF'), next: null, offConfirmed: true});
  assert.equal(b.app.getSession(), null);
  await b.stop();
});
