// The app: serves the browser UI (index.html, main.js, ui/) and talks
// to it over a WebSocket at /ws.
//
// server → browser:
//   {type: 'state', state}       after anything changes (see snapshot())
//   {type: 'history', samples}   on connect: the samples the chart needs
//   {type: 'sample', sample}     every reading (~1.5 s)
//   {type: 'say', text, urgent}  {type: 'chime', kind}  {type: 'alert', alert}
//   {type: 'error', message}     an action failed
// browser → server:
//   {type: 'action', action, args}   see ACTIONS
//
// The session is saved to disk on every change. If the server restarts
// mid-session (crash, laptop sleep), it resumes from that file, as long as
// it's less than RESUME_WITHIN_MS old.
//
// Only pages served from this machine may open the WebSocket. Browsers don't
// stop other sites from connecting to ws://localhost, so without the check
// any page you have open could send actions (burner to 100%). Checking the
// Origin's host, not the Host header, also covers DNS rebinding.

import fs from 'fs';
import path from 'path';
import http from 'http';
import {fileURLToPath} from 'url';
import express from 'express';
import {WebSocketServer} from 'ws';
import {Session} from './session.js';
import {Recorder} from './recorder.js';
import {loadProcedure, rateOfRise, PROCEDURES_DIR} from './procedure.js';
import {findRoast, readRoast, indexAt, isRoastFile} from './roastlog.js';
import {popsBetween} from './simPops.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESUME_WITHIN_MS = 30 * 60_000; // (a roast in progress: see session.js)
const KEEP_IDLE_MS = 30 * 60_000; // readings kept for the chart with no session
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// Browsers always send an Origin; other programs on this machine may not.
export const allowedOrigin = (origin) =>
  origin == null || LOCAL_ORIGIN.test(origin);

export function startApp({machine, clock, sim, port = 3100, logsDir}) {
  const preheat = readJSON(path.join(ROOT, 'preheat.json'));
  const beans = readJSON(path.join(ROOT, 'beans.json'));
  const stateFile = path.join(logsDir, '.session.json');
  let session = null;
  let recorder = null;
  let idle = []; // readings while there's no session
  let lastBatch = null; // the most recent finished batch, for weight out
  const alerts = [];

  // ---- session

  function newSession(saved = null, downMs = 0) {
    session?.detach();
    session?.removeAllListeners();
    session = new Session({
      machine,
      clock,
      preheat,
      loadProcedure,
      nextRoastNumber: () => recorder.nextRoastNumber(),
      beanName: (slug) => beans[slug]?.name ?? slug,
    });
    recorder = new Recorder({session, dir: logsDir, beans});
    session.on('sample', (s) => broadcast({type: 'sample', sample: s}));
    if (sim) simCracks(session);
    session.on('say', (text, o) =>
      broadcast({type: 'say', text, urgent: !!o?.urgent}),
    );
    session.on('chime', (kind) => broadcast({type: 'chime', kind}));
    session.on('alert', (a) => {
      alerts.push({...a, t: clock.now()});
      alerts.splice(0, alerts.length - 20);
      broadcast({type: 'alert', alert: a});
    });
    session.on('batchComplete', (b) => {
      // Times are seconds since charge, for the "last roast" summary.
      const rel = (m) => m && {s: (m.t - b.charge.t) / 1000, BT: m.BT};
      lastBatch = {
        number: b.number,
        bean: b.bean,
        beanName: beans[b.bean]?.name ?? b.bean,
        variant: b.variant,
        weightIn: b.weightIn,
        weightOut: b.weightOut ?? null,
        fc: rel(b.fc),
        drop: rel(b.drop),
      };
    });
    for (const e of ['phase', 'charge', 'tp', 'step', 'fc', 'drop'])
      session.on(e, changed);
    session.on('beansOut', changed);
    session.on('batchComplete', changed);
    session.on('persist', save);
    session.start(saved, {downMs});
    changed();
  }

  // The simulator's crack sounds, played by the browser at the right moments
  // (in real time: the sim may run faster).
  function simCracks(session) {
    let prev = null;
    let fcBT;
    session.on('charge', (b) => (fcBT = referenceFC(b.proc)));
    session.on('sample', (s) => {
      const b = session.batch;
      const dtS = prev == null ? 0 : (s.t - prev) / 1000;
      prev = s.t;
      if (session.phase !== 'ROASTING' || !b?.tp || s.BT == null) return;
      const pops = popsBetween(s.BT, dtS, fcBT).map(({kind, atS}) => ({
        kind,
        delayMs: Math.round((atS * 1000) / clock.speed),
      }));
      if (pops.length) broadcast({type: 'simPops', pops});
    });
  }

  let saveTimer = null;
  function save() {
    changed();
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 200);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!session) return;
    // A failed save only costs the resume-after-restart; it mustn't become
    // an uncaught exception, which turns the heater off.
    try {
      const data = {savedAt: clock.now(), state: session.toJSON()};
      fs.mkdirSync(logsDir, {recursive: true});
      fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(data));
      fs.renameSync(`${stateFile}.tmp`, stateFile);
    } catch (err) {
      console.error(`couldn't save the session: ${err.message}`);
    }
  }

  machine.on('sample', (r) => {
    if (session) return; // the session forwards its own samples
    idle.push(r);
    while (idle.length && r.t - idle[0].t > KEEP_IDLE_MS) idle.shift();
    const ror = rateOfRise(idle);
    broadcast({type: 'sample', sample: {...r, ror, phase: 'IDLE'}});
  });
  machine.on('connected', changed);
  machine.on('disconnected', changed);

  // ---- actions from the browser

  const need = () => {
    if (!session) throw new Error('no session running');
    return session;
  };
  const ACTIONS = {
    startSession: () => {
      if (session && session.phase !== 'OFF')
        throw new Error('a session is already running');
      idle = [];
      alerts.length = 0; // yesterday's alerts don't belong to this session
      newSession();
    },
    selectBatch: ({bean, variant, weightIn}) =>
      need().selectBatch({bean, variant, weightIn}),
    markFC: () => need().markFC(),
    beansOut: () => need().beansOut(),
    dismissCharge: () => need().dismissCharge(),
    // Also how the day ends (between batches). Works with or without a
    // session.
    emergencyStop: () =>
      session && session.phase !== 'OFF'
        ? session.emergencyStop()
        : machine.set({HS: 0, AH: 0, HP: 0}),
    pop: ({intensity}) => session?.addPop(intensity),
    setWeightOut: ({number, grams}) => {
      need();
      recorder.setWeightOut(number, grams);
      if (lastBatch?.number === number) lastBatch.weightOut = Number(grams);
    },
    addNote: ({number, text}) => {
      need();
      recorder.addNote(number, text);
    },
    // Simulator only: stand in for the person at the roaster.
    simCharge: () => sim.chargeBeans(session?.next?.weightIn ?? 155),
    simDischarge: () => sim.discharge(),
  };

  // ---- what the browser sees

  function snapshot() {
    const s = session;
    const b = s?.batch;
    return {
      mode: sim ? 'sim' : 'real',
      preheat: {sv: preheat.sv, ...preheat.stable},
      connected: machine.connected,
      phase: s?.phase ?? 'IDLE',
      cooling: s?.cooling ?? false,
      pendingCharge: s?.pendingCharge ?? null,
      next: s?.next && {
        bean: s.next.bean,
        variant: s.next.variant,
        weightIn: s.next.weightIn,
        proc: s.next.proc,
      },
      batch: b && {
        number: b.number,
        bean: b.bean,
        beanName: beans[b.bean]?.name ?? b.bean,
        variant: b.variant,
        weightIn: b.weightIn,
        proc: b.proc,
        charge: b.charge,
        tp: b.tp,
        fc: b.fc,
        drop: b.drop,
        beansOut: b.beansOut,
        steps: b.steps,
        file: b.file,
      },
      desired: machine.desired,
      lastBatch,
      alerts: alerts.slice(-5),
    };
  }

  // ---- roast history

  // Bean slug → when its latest real roast was charged (ISO). The logs are
  // big, so each file is read once (again if it changes: notes, weight out).
  const roastInfo = new Map(); // file → {mtimeMs, bean, at}
  function lastRoasted() {
    const dir = path.join(ROOT, 'logs');
    const last = {};
    for (const f of fs.readdirSync(dir).filter(isRoastFile)) {
      const {mtimeMs} = fs.statSync(path.join(dir, f));
      let info = roastInfo.get(f);
      if (info?.mtimeMs !== mtimeMs) {
        // One unreadable log mustn't empty the bean list.
        try {
          const r = readRoast(path.join(dir, f));
          info = {mtimeMs, bean: r.bean, at: r.chargedAt ?? r.startedAt};
        } catch {
          info = {mtimeMs};
        }
        roastInfo.set(f, info);
      }
      if (info.at && !(info.at <= last[info.bean])) last[info.bean] = info.at;
    }
    return last;
  }

  // The first crack temperature of a procedure's reference roast, which the
  // simulator's crack sounds center on (simPops.js).
  function referenceFC(proc) {
    const ref = proc?.reference;
    if (!ref) return undefined;
    try {
      const dir = path.join(ROOT, 'logs');
      const r = readRoast(
        path.join(dir, findRoast(dir, ref.file ?? ref.roast)),
      );
      return r.fc?.BT ?? undefined;
    } catch {
      return undefined;
    }
  }

  // ---- HTTP

  const app = express();
  app.use(express.json());
  // The beans to choose from: those with a procedure and some left in
  // inventory.json (all of them if there's no inventory), most recently
  // roasted first, then the ones never roasted.
  app.get('/api/procedures', (req, res) => {
    let stock = null;
    try {
      stock = readJSON(path.join(ROOT, 'inventory.json')).beans;
    } catch {
      // no inventory: show everything
    }
    const last = lastRoasted();
    const list = fs
      .readdirSync(PROCEDURES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const p = readJSON(path.join(PROCEDURES_DIR, f));
        const bean = f.slice(0, -5);
        return {
          bean,
          name: beans[bean]?.name ?? bean,
          variants: Object.keys(p.variants ?? {}),
          batchGrams: p.batchGrams ?? null,
          lastRoasted: last[bean] ?? null,
        };
      })
      .filter((p) => !stock || stock[p.bean]?.batches > 0)
      .sort(
        (a, b) =>
          (b.lastRoasted ?? '').localeCompare(a.lastRoasted ?? '') ||
          a.name.localeCompare(b.name),
      );
    res.json(list);
  });
  // A past roast's curve, relative to its charge, for the chart background.
  // :number is a roast number, or a file name when the number is shared.
  // Reference roasts are the real ones in logs, even in the sim.
  app.get('/api/roast/:number', (req, res) => {
    const dir = path.join(ROOT, 'logs');
    let file;
    try {
      file = findRoast(dir, req.params.number);
    } catch (err) {
      return res.status(404).json({error: err.message});
    }
    const r = readRoast(path.join(dir, file));
    const {t} = r.samples;
    // Charge to drop (the last reading at or before it), or to the end.
    const reading = (ev) => {
      const i = indexAt(t, ev?.t);
      return i == null ? null : {t: t[i], BT: r.samples.BT[i]};
    };
    const from = indexAt(t, 0);
    const end = r.drop ? indexAt(t, r.drop.t) : t.length - 1;
    const keep = (xs) => xs.slice(from, end + 1);
    res.json({
      number: r.roast,
      file,
      t: keep(t),
      BT: keep(r.samples.BT),
      ET: keep(r.samples.ET),
      fc: reading(r.fc),
      drop: reading(r.drop),
    });
  });
  // Only the page and its scripts: not the logs, the server's own code, or
  // node_modules, which all live in the same folder.
  const page = (file) => (req, res) => res.sendFile(path.join(ROOT, file));
  app.get(['/', '/index.html'], page('index.html'));
  app.get('/main.js', page('main.js'));
  app.use('/ui', express.static(path.join(ROOT, 'ui')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({origin}) => allowedOrigin(origin),
  });
  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  function broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(text);
  }
  let changeTimer = null;
  function changed() {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      broadcast({type: 'state', state: snapshot()});
    }, 30);
  }

  wss.on('connection', (ws) => {
    send(ws, {type: 'state', state: snapshot()});
    const samples = session ? session.log : idle;
    send(ws, {type: 'history', samples});
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
        // (Own keys only: not 'constructor' or 'toString'.)
        const fn = Object.hasOwn(ACTIONS, msg.action) && ACTIONS[msg.action];
        if (msg.type !== 'action' || !fn)
          throw new Error(`unknown action ${msg.action}`);
        fn(msg.args ?? {});
        changed();
      } catch (err) {
        send(ws, {type: 'error', message: err.message, action: msg?.action});
      }
    });
  });

  // Resume a session that was cut off (not in the sim: the simulated
  // roaster starts cold every time, so there's nothing to resume). This
  // comes last, once everything a session's events touch exists.
  if (!sim && fs.existsSync(stateFile)) {
    try {
      const {savedAt, state} = readJSON(stateFile);
      const downMs = clock.now() - savedAt;
      if (state.phase !== 'OFF' && downMs < RESUME_WITHIN_MS) {
        console.log(
          `resuming the session saved ${Math.round(downMs / 1000)} s ago (${state.phase})`,
        );
        newSession(state, downMs);
      }
    } catch (err) {
      console.log(`couldn't resume the saved session: ${err.message}`);
      // It may have failed partway through starting: drop it, or it would
      // block "Start preheating" and skip the heater-off below.
      session?.detach();
      session?.removeAllListeners();
      session = null;
      recorder = null;
    }
  }
  // With no session, nothing should be heating. The roaster doesn't report
  // the heater switch until it's set on this connection (and it can be
  // heating while unreported), so set it: then the UI knows it's off.
  if (!session) machine.set({HS: 0});

  server.listen(port, '127.0.0.1', () =>
    console.log(
      `kaleido: http://localhost:${port}/  (${sim ? 'simulated roaster' : 'real roaster'})`,
    ),
  );
  return {
    server,
    getSession: () => session,
    saveNow,
  };
}
