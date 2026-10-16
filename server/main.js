// Entry point.
//
// App (the normal way to roast): serves the UI at http://localhost:3100/.
//   node server/main.js                 real roaster
//   node server/main.js --sim [--speed 10]   simulated roaster; the
//       UI gets buttons to pour beans in and discharge them. Roasts go to
//       logs-sim/ (gitignored), never to logs/.
//   --port 3100 to change the port.
//   --open opens the UI in Chrome once it's up (npm start passes it).
//
// Monitor: connects and prints every reading. Against the real roaster this
// never sets a control: it only does the handshake (PI, TU C, SC AR), polls
// (RD A0), and sends CL AR on exit.
//   node server/main.js --monitor [--sim]
//
// Autopilot: a whole simulated session (two batches, then shutdown) in the
// terminal, with a simulated person charging, marking FC, and discharging.
//   node server/main.js --sim --autopilot [--speed 20]
//
// Self-test: the empty-drum hardware checks in selftest.js. Asks before it
// fires the burner. The report goes to selftests/ (logs-sim/ for --sim).
//   node server/main.js --selftest [--no-heat] [--no-cable] [--sim]

import fs from 'fs';
import {createClock} from './clock.js';
import {Machine} from './machine.js';
import {SerialTransport} from './port.js';
import {SimKaleido} from './sim.js';
import {Session} from './session.js';
import {loadProcedure} from './procedure.js';
import {autopilot} from './autopilot.js';
import {Recorder} from './recorder.js';
import {runSelfTest} from './selftest.js';
import readline from 'readline';
import {fileURLToPath} from 'url';
import {spawn} from 'child_process';
import {HEARTBEAT_MS, runningApp} from './guardian.js';
import {startApp} from './app.js';

// (fileURLToPath, not .pathname: that leaves a space in the path as %20.)
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const LOGS_DIR = here('../logs/');
const HEARTBEAT_FILE = `${LOGS_DIR}.heartbeat`;

const args = process.argv.slice(2);
const SIM = args.includes('--sim');
const AUTOPILOT = SIM && args.includes('--autopilot');
const SELFTEST = args.includes('--selftest');
const MONITOR = args.includes('--monitor');
const OPEN = args.includes('--open');
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 3100;
const speedArg = args.indexOf('--speed');
const speed = SIM && speedArg >= 0 ? Number(args[speedArg + 1]) : 1;
// Checked before anything connects: a bad number would otherwise surface
// later as a confusing listen error or a clock running at NaN speed.
if (!(Number.isInteger(PORT) && PORT > 0 && PORT < 65536)) {
  console.log(`--port needs a port number, like --port 3100`);
  process.exit(2);
}
if (!(speed > 0)) {
  console.log(`--speed needs a number above 0, like --speed 10`);
  process.exit(2);
}

const clock = createClock(speed);
const sim = SIM ? new SimKaleido({clock, dropRate: 0.1}) : null;
const machine = new Machine({
  clock,
  openTransport: () => (SIM ? sim.open() : new SerialTransport().open()),
});

const t0 = clock.now();
const mmss = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const stamp = () => mmss(clock.now() - t0).padStart(6);

// One live status line at the bottom, redrawn in place (on a terminal), with
// normal log lines printed above it. Piped output gets the status every 30 s.
const TTY = process.stdout.isTTY;
let statusText = null;
let statusPrinted = 0;
const drawStatus = () => {
  if (!statusText) return;
  const cols = process.stdout.columns || 100;
  process.stdout.write(
    `\r\x1b[K${`${stamp()}  ${statusText}`.slice(0, cols - 1)}`,
  );
};
const log = (msg) => {
  if (TTY && statusText) process.stdout.write('\r\x1b[K');
  console.log(`${stamp()}  ${msg}`);
  if (TTY) drawStatus();
};
const status = (text) => {
  if (TTY) {
    if (!text && statusText) process.stdout.write('\r\x1b[K');
    statusText = text;
    drawStatus();
  } else if (text && Date.now() - statusPrinted >= 30_000) {
    statusPrinted = Date.now();
    console.log(`${stamp()}  ${text}`);
  }
};

// The reconnect loop retries every second, so an unplugged roaster (how the
// day ends) would print "not found" forever: say each error once per run.
let lastError = null;
machine.on('connected', () => {
  lastError = null;
  log('connected');
});
machine.on('disconnected', () => log('DISCONNECTED'));
machine.on('error', (err) => {
  if (err.message === lastError) return;
  lastError = err.message;
  log(`error: ${err.message}`);
});
machine.on('stuck', ({control, want, got}) =>
  log(`STUCK: ${control} should be ${want} but reads ${got}`),
);

const f = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));
const reading = (r) =>
  `BT ${f(r.BT, 1)}  ET ${f(r.ET, 1)}  SV ${f(r.TS)}  burner ${f(r.HP)}%` +
  `  air ${f(r.FC)}%  drum ${f(r.RC)}%  auto ${f(r.AH)}  heat ${f(r.HS)}` +
  `  cool ${f(r.CS)}`;

let app = null;
if (AUTOPILOT) runAutopilot();
else if (SELFTEST) runSelfTestCLI();
else if (MONITOR) {
  machine.on('sample', (r) => log(reading(r)));
  if (SIM) machine.set({TS: 185, HS: 1, AH: 1, FC: 30, RC: 90});
} else {
  // One app at a time. A second one would write its pid to the heartbeat,
  // so the first app's guardian would take it for a restart and leave, and
  // the first app would carry on with no guardian.
  const other = SIM ? null : runningApp(HEARTBEAT_FILE);
  if (other) {
    console.log(
      `kaleido is already running (pid ${other}): http://localhost:${PORT}/`,
    );
    console.log(`If it isn't, delete ${HEARTBEAT_FILE} and start again.`);
    if (OPEN) openInChrome();
    process.exit(1);
  }
  const logsDir = here(SIM ? '../logs-sim/' : '../logs/');
  app = startApp({machine, clock, sim, port: PORT, logsDir});
  if (OPEN) app.server.once('listening', openInChrome);
}
machine.run();

// A new Chrome tab on the UI. Best effort: the app runs fine without it.
function openInChrome() {
  const url = `http://localhost:${PORT}/`;
  spawn('open', ['-a', 'Google Chrome', url], {stdio: 'ignore'})
    .on('error', (err) => log(`couldn't open Chrome: ${err.message}`))
    .on('exit', (code) => {
      if (code) log(`couldn't open Chrome; go to ${url}`);
    });
}

function runAutopilot() {
  const preheat = JSON.parse(
    fs.readFileSync(new URL('../preheat.json', import.meta.url), 'utf8'),
  );
  const beans = JSON.parse(
    fs.readFileSync(new URL('../beans.json', import.meta.url), 'utf8'),
  );
  let recorder;
  const session = new Session({
    machine,
    clock,
    preheat,
    loadProcedure,
    nextRoastNumber: () => recorder.nextRoastNumber(),
  });
  const dir = here('../logs-sim/');
  recorder = new Recorder({session, dir, beans});
  session.on('batchComplete', (b) => log(`wrote logs-sim/${b.file}.json`));
  const at = (b) =>
    b?.charge ? ` (roast ${mmss(clock.now() - b.charge.t)})` : '';
  let lastPrint = 0;
  session.on('sample', (s) => {
    const every = s.phase === 'ROASTING' ? 15_000 : 60_000;
    if (s.t - lastPrint < every) return;
    lastPrint = s.t;
    log(`${s.phase.padEnd(9)} ${reading(s)}  RoR ${f(s.ror, 1)}`);
  });
  session.on('phase', (p) => log(`--- ${p}`));
  session.on('say', (text) => log(`SAY "${text}"${at(session.batch)}`));
  session.on('alert', (a) => log(`ALERT (${a.level}) ${a.text}`));
  session.on('step', (b, e) => {
    const what = [
      e.burner != null && `burner ${e.burner}%`,
      e.air != null && `air ${e.air}%`,
    ];
    log(`step at ${e.bt}: ${what.filter(Boolean).join(', ')}${at(b)}`);
  });
  session.on('tp', (b, e) => log(`turning point ${f(e.BT, 1)}${at(b)}`));
  session.on('fc', (b, e) =>
    log(`first crack marked at ${f(e.BT, 1)}${at(b)}`),
  );
  session.on('drop', (b, e) =>
    log(`dropped at ${f(e.BT, 1)} (${e.reason})${at(b)}`),
  );
  session.start();
  autopilot(session, sim, clock, {
    batches: [
      {bean: 'colombian_supremo', variant: 'espresso', weightIn: 155},
      {bean: 'colombian_supremo', variant: 'pourover', weightIn: 155},
    ],
  }).then(async () => {
    await machine.stop();
    process.exit(0);
  });
}

async function runSelfTestCLI() {
  // Only an Enter pressed after the prompt counts: nobody should be able to
  // say "the drum is empty" in advance. In the sim there's nobody to ask.
  const rl = SIM ? null : readline.createInterface({input: process.stdin});
  const ask = (q) =>
    new Promise((resolve) => {
      log(`>>> ${q}`);
      if (SIM) resolve();
      else rl.once('line', resolve);
    });
  const report = await runSelfTest({
    machine,
    clock,
    log,
    ask,
    opts: {
      heat: !args.includes('--no-heat'),
      cable: !args.includes('--no-cable'),
      status,
      // The cool-down can take 20 minutes; let the person end it early.
      offerSkip: (text) => {
        let skipped = false;
        log(`>>> ${text}`);
        rl?.once('line', () => (skipped = true));
        return {skipped: () => skipped};
      },
      ...(SIM && {
        pullCable: () => {
          sim.unplugged = true;
          sim.close();
        },
        plugCable: () => (sim.unplugged = false),
      }),
    },
  });
  const dir = here(SIM ? '../logs-sim/' : '../selftests/');
  fs.mkdirSync(dir, {recursive: true});
  const stamp = report.startedAt.slice(0, 16).replace(/[:T]/g, '-');
  const file = `${dir}selftest_${stamp}.json`;
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  const failed = report.checks.filter((c) => !c.ok);
  log(
    failed.length
      ? `${failed.length} FAILED: ${failed.map((c) => c.name).join('; ')}`
      : `all ${report.checks.length} checks passed`,
  );
  log(`report: ${file}`);
  rl?.close();
  await machine.stop();
  process.exit(failed.length ? 1 : 0);
}

// The M1 LITE has no panel: if this process goes away with the burner on,
// nothing turns it off. So quitting or crashing turns the heater off first
// (air, drum and the tray's cooling fan keep running while it's hot: beans
// may be dumped into the tray at any moment). Monitor mode never touches the
// controls, so it doesn't start now. Not covered: kill -9, power loss, the
// laptop sleeping (see caffeinate below); for those, server/stop.js.
async function heaterOffAndExit(code) {
  const active =
    SELFTEST ||
    (app && !['IDLE', 'OFF'].includes(app.getSession()?.phase ?? 'IDLE'));
  let confirmed = false;
  if (!MONITOR && !AUTOPILOT && machine.connected) {
    const hot = active && !(machine.state.BT < 60); // unknown BT: cool anyway
    // Locked off: the session is still running while we wait, and a step or
    // a click must not turn the heat back on.
    machine.heaterOff(hot ? {FC: 100, RC: 90, CS: 1} : {});
    const end = Date.now() + 5000;
    while (!machine.heaterConfirmedOff() && Date.now() < end)
      await new Promise((r) => setTimeout(r, 100));
    confirmed = machine.heaterConfirmedOff();
    log(
      confirmed
        ? 'heater off.'
        : 'tried to turn the heater off, but it was not confirmed!',
    );
    if (hot)
      log(
        'air, drum and cooling fan are still running; when BT is under 60: node server/stop.js --all',
      );
  }
  // The heartbeat goes only once the heater is confirmed off (or nothing
  // could have it on). Otherwise the guardian sees us gone and tries again.
  if (confirmed || !active) removeHeartbeat();
  app?.saveNow();
  await machine.stop();
  process.exit(code);
}

let quitting = false;
let warned = false;
process.on('SIGINT', async () => {
  if (quitting) process.exit(1);
  const phase = app?.getSession()?.phase;
  if (phase && phase !== 'OFF' && !warned) {
    warned = true;
    log(`A session is running (${phase}). Quitting turns the heater off; the`);
    log('session is saved, and restarting within 30 min resumes it (heat and');
    log('all). To end the day, press STOP instead. Ctrl-C again to quit.');
    return;
  }
  quitting = true;
  log('stopping');
  await heaterOffAndExit(0);
});
process.on('SIGTERM', async () => {
  if (quitting) return;
  quitting = true;
  log('terminated');
  await heaterOffAndExit(0);
});
for (const event of ['uncaughtException', 'unhandledRejection'])
  process.on(event, async (err) => {
    console.error(err);
    if (quitting) process.exit(1);
    quitting = true;
    await heaterOffAndExit(1);
  });

// The guardian (guardian.js) turns the heater off if this process dies or
// hangs: it watches our pid and a heartbeat file we rewrite every 2 s. The
// file holds our pid, so after a restart the old app's guardian can tell a
// new app took over (and leaves it alone).
let heartbeatFile = null;
let heartbeatTimer = null;
function beat() {
  try {
    fs.writeFileSync(heartbeatFile, String(process.pid));
  } catch (err) {
    // A missed beat only worries the guardian; it mustn't crash the app.
    console.error(`heartbeat: ${err.message}`);
  }
}
function removeHeartbeat() {
  if (!heartbeatFile) return;
  // Stop beating first, or the next beat writes it back while we're on the
  // way out, and our guardian takes us for crashed.
  clearInterval(heartbeatTimer);
  try {
    // Only ours: a restarted app may already have written its own.
    if (fs.readFileSync(heartbeatFile, 'utf8') === String(process.pid))
      fs.unlinkSync(heartbeatFile);
  } catch {
    // already gone
  }
}
if (app && !SIM) {
  heartbeatFile = HEARTBEAT_FILE;
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  const out = fs.openSync(`${LOGS_DIR}.guardian.log`, 'a');
  const guardian = here('./guardian.js');
  spawn(process.execPath, [guardian, String(process.pid), heartbeatFile], {
    stdio: ['ignore', out, out],
    detached: true,
  }).unref();
}

// Keep the Mac awake while the app runs: a sleeping laptop can't turn the
// burner off, and a dark screen hides the roast. (Closing the lid can
// still sleep it.)
if (app && !SIM && process.platform === 'darwin')
  spawn('caffeinate', ['-dis', '-w', String(process.pid)], {
    stdio: 'ignore',
    detached: true,
  }).unref();
