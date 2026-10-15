// The guardian: a separate process that turns the burner off if the app
// dies or hangs. Needed because the roaster has no panel and keeps heating on
// its own when the computer goes quiet (self-test watchdog, 2026-10-04).
//
// main.js starts it (detached) when the app starts:
//   node kaleido/server/guardian.js <app pid> <heartbeat file>
// The app writes its pid to the heartbeat file every 2 s and deletes it on a
// clean exit.
//   - file gone            → the app exited cleanly; the guardian exits too
//   - another app's pid    → a restarted app took over (with its own
//                            guardian); this one exits, and never touches
//                            the new app's port or heartbeat
//   - app process gone     → it crashed or was killed; its port is free now
//   - heartbeat > 15 s old → it's hung; kill it so the port frees up
// In the last two cases the guardian turns the heater off (fans keep running
// if it's hot), says so out loud, and exits.

import fs from 'fs';
import {spawn} from 'child_process';
import {fileURLToPath} from 'url';
import {emergencyStop} from './stop.js';

export const HEARTBEAT_MS = 2000;
export const HUNG_MS = 15_000;

// One look. Returns 'ok', 'clean' or 'replaced' (stop watching), or why to
// step in. owner: the pid in the heartbeat file (null if it has none).
export function assess({heartbeatAge, appAlive, owner, pid}) {
  if (heartbeatAge == null) return 'clean';
  if (owner != null && owner !== pid) return 'replaced';
  if (!appAlive) return 'the app stopped';
  if (heartbeatAge > HUNG_MS) return 'the app stopped responding';
  return 'ok';
}

// The pid of another live app that owns the heartbeat file, or null. (A
// stale file from a crashed app names a dead pid, so it doesn't count.)
export function runningApp(heartbeatFile) {
  let pid;
  try {
    pid = Number(fs.readFileSync(heartbeatFile, 'utf8'));
  } catch {
    return null;
  }
  if (!pid || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return err.code === 'EPERM' ? pid : null; // EPERM: alive, not ours
  }
}

export async function guard({
  pid,
  heartbeatFile,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  isAlive = (p) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  },
  kill = (p) => process.kill(p, 'SIGKILL'),
  stop = () => emergencyStop(),
  announce = (text) => spawn('say', [text], {stdio: 'ignore'}),
  log = console.log,
}) {
  // The pid written in the heartbeat file, or null (none, or no file).
  const owner = () => {
    try {
      return Number(fs.readFileSync(heartbeatFile, 'utf8')) || null;
    } catch {
      return null;
    }
  };
  for (;;) {
    let heartbeatAge = null;
    try {
      heartbeatAge = now() - fs.statSync(heartbeatFile).mtimeMs;
    } catch {
      // gone: a clean exit
    }
    const verdict = assess({
      heartbeatAge,
      appAlive: isAlive(pid),
      owner: owner(),
      pid,
    });
    if (verdict === 'clean' || verdict === 'replaced') return verdict;
    if (verdict !== 'ok') {
      log(`guardian: ${verdict}; turning the heater off`);
      if (isAlive(pid)) kill(pid);
      // The port frees up once the app is gone; retry until the stop lands,
      // unless a restarted app takes over first (it holds the port and has
      // its own guardian).
      let result;
      for (let i = 0; i < 5; i++) {
        await sleep(1000);
        const o = owner();
        if (o != null && o !== pid) {
          log(
            'guardian: a restarted app took over; leaving it to its guardian',
          );
          return 'replaced';
        }
        result = await stop();
        if (result.ok) break;
      }
      log(`guardian: ${result.message}`);
      announce(
        result.ok
          ? `Roaster app ${verdict.replace('the app ', '')}. Heater off.`
          : 'Roaster app stopped and I could not turn the heater off. Unplug the roaster.',
      );
      // Only our app's heartbeat: a new app's belongs to its own guardian.
      const o = owner();
      if (o == null || o === pid)
        try {
          fs.unlinkSync(heartbeatFile);
        } catch {
          // already gone
        }
      return verdict;
    }
    await sleep(1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [pid, heartbeatFile] = process.argv.slice(2);
  await guard({pid: Number(pid), heartbeatFile});
  process.exit(0);
}
