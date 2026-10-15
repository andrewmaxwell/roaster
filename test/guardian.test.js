import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {guard, runningApp} from '../server/guardian.js';

function setup({
  ageMs = 0,
  alive = true,
  stopResults = [{ok: true, message: 'Heater off.'}],
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-'));
  const heartbeatFile = path.join(dir, '.heartbeat');
  fs.writeFileSync(heartbeatFile, '');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(heartbeatFile, t, t);
  const calls = {stop: 0, kill: 0, said: []};
  let isAlive = alive;
  const opts = {
    pid: 4242,
    heartbeatFile,
    sleep: async () => {},
    isAlive: () => isAlive,
    kill: () => {
      calls.kill++;
      isAlive = false;
    },
    stop: async () =>
      stopResults[Math.min(calls.stop++, stopResults.length - 1)],
    announce: (text) => calls.said.push(text),
    log: () => {},
  };
  return {opts, calls, heartbeatFile};
}

test('a clean exit (heartbeat removed) needs nothing', async () => {
  const {opts, calls, heartbeatFile} = setup();
  fs.unlinkSync(heartbeatFile);
  assert.equal(await guard(opts), 'clean');
  assert.equal(calls.stop, 0);
});

test('a crashed app gets the heater turned off, out loud', async () => {
  const {opts, calls} = setup({alive: false});
  assert.equal(await guard(opts), 'the app stopped');
  assert.equal(calls.stop, 1);
  assert.equal(calls.kill, 0);
  assert.match(calls.said[0], /Heater off/);
});

test('a hung app is killed first, so its port frees up', async () => {
  const {opts, calls} = setup({ageMs: 20_000});
  assert.equal(await guard(opts), 'the app stopped responding');
  assert.equal(calls.kill, 1);
  assert.equal(calls.stop, 1);
});

test('keeps trying while the port is still busy, then says to unplug', async () => {
  const busy = {ok: false, message: 'busy'};
  const a = setup({
    alive: false,
    stopResults: [busy, busy, {ok: true, message: 'ok'}],
  });
  await guard(a.opts);
  assert.equal(a.calls.stop, 3);
  const b = setup({alive: false, stopResults: [busy]});
  await guard(b.opts);
  assert.equal(b.calls.stop, 5);
  assert.match(b.calls.said[0], /Unplug the roaster/);
});

test("a restarted app's heartbeat is left to its own guardian", async () => {
  // The app was restarted: our app (4242) is gone, and the heartbeat now
  // holds the new app's pid. Not a crash; don't fight it for the port.
  const {opts, calls, heartbeatFile} = setup({alive: false});
  fs.writeFileSync(heartbeatFile, '5151');
  assert.equal(await guard(opts), 'replaced');
  assert.equal(calls.stop, 0);
  assert.equal(fs.readFileSync(heartbeatFile, 'utf8'), '5151', 'untouched');
});

test('stops retrying once a restarted app takes over, without crying wolf', async () => {
  // Our app crashed (its pid is still in the heartbeat); the stop can't get
  // the port because a restarted app already has it.
  const {opts, calls, heartbeatFile} = setup({
    alive: false,
    stopResults: [{ok: false, message: 'busy'}],
  });
  fs.writeFileSync(heartbeatFile, '4242');
  opts.stop = async () => {
    calls.stop++;
    fs.writeFileSync(heartbeatFile, '5151'); // the new app's first beat
    return {ok: false, message: 'busy'};
  };
  assert.equal(await guard(opts), 'replaced');
  assert.equal(calls.stop, 1);
  assert.deepEqual(calls.said, [], 'no "unplug the roaster"');
  assert.ok(fs.existsSync(heartbeatFile), "the new app's heartbeat stays");
});

test('a second app can tell one is already running', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-'));
  const file = path.join(dir, '.heartbeat');
  assert.equal(runningApp(file), null, 'no heartbeat');
  fs.writeFileSync(file, String(process.ppid)); // a live process
  assert.equal(runningApp(file), process.ppid);
  fs.writeFileSync(file, String(process.pid)); // our own
  assert.equal(runningApp(file), null);
  fs.writeFileSync(file, '999999'); // a crashed app's
  assert.equal(runningApp(file), null);
});
