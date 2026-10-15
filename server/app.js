// The app: serves the browser UI (kaleido/index.html, main.js, ui/) and talks
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
import express from 'express';
import {WebSocketServer} from 'ws';
import {Session} from './session.js';
import {Recorder} from './recorder.js';
import {loadProcedure, rateOfRise, PROCEDURES_DIR} from './procedure.js';
import {readAlog, channels} from './alog.js';

const ROOT = new URL('..', import.meta.url).pathname;
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
    });
    recorder = new Recorder({session, dir: logsDir, beans});
    session.on('sample', (s) => broadcast({type: 'sample', sample: s}));
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
    for (const e of ['phase', 'charge', 'tp', 'step', 'fc', 'sc', 'drop'])
      session.on(e, changed);
    session.on('beansOut', changed);
    session.on('batchComplete', changed);
    session.on('persist', save);
    session.start(saved, {downMs});
    changed();
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
      need().selectBatch({bean, variant, weightIn: Number(weightIn) || null}),
    setWeightIn: ({grams}) => need().setWeightIn(Number(grams)),
    markFC: () => need().markFC(),
    markSC: () => need().markSC(),
    dropNow: () => need().dropNow(),
    beansOut: () => need().beansOut(),
    setCooling: ({on}) => need().setCooling(on),
    override: ({control, value}) => need().override(control, Number(value)),
    release: ({control}) => need().release(control),
    done: () => need().done(),
    offNow: () => need().offNow(),
    // Works with or without a session.
    emergencyStop: () =>
      session && session.phase !== 'OFF'
        ? session.emergencyStop()
        : machine.set({HS: 0, AH: 0, HP: 0}),
    pop: ({intensity}) => session?.addPop(intensity),
    setWeightOut: ({number, grams}) => {
      recorder.setWeightOut(number, Number(grams));
      if (lastBatch?.number === number) lastBatch.weightOut = Number(grams);
    },
    addNote: ({number, text}) => recorder.addNote(number, text),
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
      doneRequested: s?.doneRequested ?? false,
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
        sc: b.sc,
        drop: b.drop,
        beansOut: b.beansOut,
        steps: b.steps,
        file: b.file,
      },
      planned: s?.planned ?? {},
      overrides: s?.overrides ?? {},
      desired: machine.desired,
      lastBatch,
      alerts: alerts.slice(-5),
    };
  }

  // ---- HTTP

  const app = express();
  app.use(express.json());
  app.get('/api/procedures', (req, res) => {
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
        };
      });
    res.json(list);
  });
  // A past roast's curve, relative to its charge, for the chart background.
  // Reference roasts are the real ones in kaleido/logs, even in the sim.
  app.get('/api/roast/:number', (req, res) => {
    const dir = path.join(ROOT, 'logs');
    const file = fs
      .readdirSync(dir)
      .find(
        (f) => f.startsWith(`#${req.params.number}_`) && f.endsWith('.alog'),
      );
    if (!file) return res.status(404).json({error: 'no such roast'});
    const d = readAlog(path.join(dir, file));
    const c = channels(d);
    const [ci, , fci, , , , dpi] = d.timeindex;
    const t0 = c.t[ci];
    const end = dpi > 0 ? dpi : c.t.length - 1;
    const keep = (xs) => xs.slice(ci, end + 1);
    res.json({
      number: Number(req.params.number),
      file,
      t: keep(c.t).map((t) => t - t0),
      BT: keep(c.BT),
      ET: keep(c.ET),
      fc: fci > 0 ? {t: c.t[fci] - t0, BT: c.BT[fci]} : null,
      drop: dpi > 0 ? {t: c.t[dpi] - t0, BT: c.BT[dpi]} : null,
    });
  });
  app.use(express.static(ROOT, {index: 'index.html'}));

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
        const fn = ACTIONS[msg.action];
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
