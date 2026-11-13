// Fits physics.js parameters to the real roasts in logs/ by replaying each
// log's burner/air through the model and minimizing the curve error.
// Usage: node server/fitSim.js   (writes server/simParams.json)
//
// The two parameter sets are fit separately: `empty` on each log's preheat
// (first sample to charge), `roast` on each roast (charge to drop, starting
// from the logged temps at charge, closed loop; see replayClosed). The roast
// error adds the shape of RoR around first crack (crackError), which the BT
// curve barely registers: its dip is only 1-2 °C of BT.

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {CHANNELS, indexAt, isRoastFile, readRoast} from './roastlog.js';
import {step, charge, initialState, GREEN_TEMP} from './physics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(here, '../logs');
const DT = 0.5;

export function loadRoasts() {
  const roasts = [];
  for (const f of fs.readdirSync(logsDir).filter(isRoastFile).sort()) {
    const r = readRoast(path.join(logsDir, f));
    const {t} = r.samples;
    const ci = indexAt(t, 0);
    const di = indexAt(t, r.drop?.t);
    if (!(ci >= 1) || !(di > ci)) continue; // no charge, or never dropped
    // A missing reading holds the last good one (the first good one, before
    // any), so the replays' inputs don't jump; `ok` marks the real readings,
    // the only ones the error counts. The preheat replay starts at the first.
    const ok = t.map(
      (_, i) => r.samples.BT[i] != null && r.samples.ET[i] != null,
    );
    const c = {t, ok};
    for (const k of CHANNELS) c[k] = hold(r.samples[k]);
    const start = ok.indexOf(true);
    if (!(start >= 0 && start < ci)) continue;
    roasts.push({name: f, grams: r.weightIn, fc: r.fc, c, ci, di, start});
  }
  return roasts;
}

function hold(xs) {
  let last = xs.find((x) => x != null) ?? null;
  return xs.map((x) => (last = x ?? last));
}

// Steps the physics across one sample interval, in whole steps of about DT
// that add up to exactly its length (Artisan's intervals jitter around 1.5 s,
// and a `t += DT` loop gave 1.5000004 s four steps: 2 s of physics).
function advance(s, u, params, dt) {
  const n = Math.max(1, Math.round(dt / DT));
  for (let i = 0; i < n; i++) step(s, u, params, dt / n);
}

// The logged HP is the PID duty in auto mode and the command in manual, where
// the machine cuts the burner once BT reaches the setpoint.
function inputs(c, k) {
  const capped = !c.AH[k] && c.BT[k] >= c.TS[k];
  return {
    duty: capped ? 0 : c.HP[k],
    FC: c.FC[k],
    AT: c.AT[k] || GREEN_TEMP,
  };
}

// Simulated {ET, BT} for samples [from, to), starting from the logged temps
// at `from`. Beans go in at `from` if withBeans. The drum starts at its steady
// state for the first minute's average inputs.
export function replay(r, params, from, to, withBeans) {
  const {c} = r;
  const avg = (xs) => xs.slice(from, from + 40).reduce((a, b) => a + b, 0) / 40;
  const u0 = {duty: avg(c.HP), FC: avg(c.FC), AT: c.AT[from] || GREEN_TEMP};
  const s = initialState(c.ET[from], c.BT[from], params, u0);
  if (withBeans) charge(s, r.grams, params);
  const out = [];
  for (let k = from; k < to; k++) {
    out.push({ET: s.ET, BT: s.BT});
    advance(s, inputs(c, k), params, c.t[k + 1] - c.t[k]);
  }
  return out;
}

function rmse(r, sim, from) {
  const {c} = r;
  let e = 0;
  let n = 0;
  sim.forEach((x, k) => {
    if (!c.ok[from + k]) return;
    e += (x.BT - c.BT[from + k]) ** 2 + 0.3 * (x.ET - c.ET[from + k]) ** 2;
    n++;
  });
  return Math.sqrt(e / n);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export const preheatError = (roasts, params) =>
  mean(
    roasts.map((r) =>
      rmse(r, replay(r, params, r.start, r.ci, false), r.start),
    ),
  );

// The burner/air changes made during a roast, each with the BT it was made
// at. Changes before the turning point are kept on their timing instead.
export function roastEvents(r) {
  const {c, ci, di} = r;
  let tp = ci;
  for (let k = ci; k < Math.min(di, ci + 200); k++)
    if (c.BT[k] < c.BT[tp]) tp = k;
  const events = [];
  for (let k = ci + 1; k < di; k++)
    if (c.HP[k] !== c.HP[k - 1] || c.FC[k] !== c.FC[k - 1])
      events.push({k, bt: k > tp ? c.BT[k] : null, HP: c.HP[k], FC: c.FC[k]});
  return events;
}

// Closed-loop replay, the way the simulator is used: each logged change is
// applied when the simulated BT reaches the temperature it was made at (after
// the turning point), not at its logged time. Small errors then compound the
// way they would in a live simulated roast, so the fit has to get them right.
export function replayClosed(r, params) {
  const {c, ci, di} = r;
  const avg = (xs) => xs.slice(ci - 40, ci).reduce((a, b) => a + b, 0) / 40;
  const u0 = {duty: avg(c.HP), FC: avg(c.FC), AT: c.AT[ci] || GREEN_TEMP};
  const s = initialState(c.ET[ci], c.BT[ci], params, u0);
  charge(s, r.grams, params, r.fc?.BT);
  const events = roastEvents(r);
  const u = {duty: c.HP[ci], FC: c.FC[ci], AT: u0.AT};
  let min = Infinity;
  let armed = false;
  const out = [];
  for (let k = ci; k < di; k++) {
    out.push({ET: s.ET, BT: s.BT});
    if (s.BT < min) min = s.BT;
    else if (s.BT > min + 2) armed = true;
    while (events.length) {
      const e = events[0];
      const due = e.bt == null ? k >= e.k : armed && s.BT >= e.bt;
      if (!due) break;
      Object.assign(u, {duty: e.HP, FC: e.FC});
      events.shift();
    }
    advance(s, u, params, c.t[k + 1] - c.t[k]);
  }
  return out;
}

// RoR (30 s least squares, °C/min, as the app shows) every 30 s from FC-60 to
// FC+180, stopping at the end of the data.
const GRID = [-60, -30, 0, 30, 60, 90, 120, 150, 180];
export function rorGrid(t, BT, tf) {
  const out = [];
  let lo = 0;
  let hi = 0;
  for (const g of GRID) {
    const tq = tf + g;
    if (tq > t.at(-1)) {
      out.push(NaN);
      continue;
    }
    while (hi < t.length - 1 && t[hi + 1] <= tq) hi++;
    while (t[lo] < tq - 30) lo++;
    let n = 0,
      st = 0,
      sv = 0,
      stt = 0,
      stv = 0;
    for (let i = lo; i <= hi; i++) {
      if (BT[i] == null) continue;
      const x = (t[i] - tq) / 60;
      n++;
      st += x;
      sv += BT[i];
      stt += x * x;
      stv += x * BT[i];
    }
    const d = n * stt - st * st;
    out.push(n < 2 || d === 0 ? NaN : (n * stv - st * sv) / d);
  }
  return out;
}

// The real RoR around first crack, for roasts with a logged FC at least a
// minute before the drop (cached on r).
export function realCrack(r) {
  if (r.crack !== undefined) return r.crack;
  const {c, ci, di, fc} = r;
  r.crack = null;
  if (fc && fc.t + 60 <= c.t[di]) {
    const t = c.t.slice(ci, di + 1);
    const BT = c.BT.slice(ci, di + 1).map((b, i) => (c.ok[ci + i] ? b : null));
    r.crack = {fcBT: fc.BT, grid: rorGrid(t, BT, fc.t)};
  }
  return r.crack;
}

// The shape of RoR around first crack, from a grid: RoR at FC, how far it
// falls in the next 90 s (dip), and how far it climbs back from that low by
// FC+180 or the drop (rebound). Timing-free: the real low comes 30-150 s after
// the FC mark, so a fit to the grid itself is rewarded for a shallow,
// smeared dip.
export function crackShape(g) {
  const after = g.slice(3, 6).filter(Number.isFinite);
  if (!Number.isFinite(g[2]) || !after.length) return null;
  const low = Math.min(...after);
  const rest = g.slice(g.indexOf(low)).filter(Number.isFinite);
  return {r0: g[2], dip: g[2] - low, rebound: Math.max(...rest) - low};
}

// The simulated crack's shape (around when its BT first reaches the real FC's
// BT, past the turning point) against the real one's, as an RMS over r0, dip
// and rebound in °C/min.
export function crackError(r, sim) {
  const real = realCrack(r);
  const want = real && crackShape(real.grid);
  if (!want) return null;
  const t = r.c.t.slice(r.ci, r.ci + sim.length);
  const BT = sim.map((x) => x.BT);
  const k = BT.findIndex((b, i) => t[i] > 120 && b >= real.fcBT);
  const got =
    k < 0 ? {r0: 0, dip: 0, rebound: 0} : crackShape(rorGrid(t, BT, t[k]));
  if (!got) return null;
  return Math.sqrt(
    ((got.r0 - want.r0) ** 2 +
      (got.dip - want.dip) ** 2 +
      (got.rebound - want.rebound) ** 2) /
      3,
  );
}

// Per roast: BT/ET RMSE (°C) plus the crack shape's error (°C/min), weighted
// equally.
export const CRACK_WEIGHT = 1;
export const roastError = (roasts, params) =>
  mean(
    roasts.map((r) => {
      const sim = replayClosed(r, params);
      const e = rmse(r, sim, r.ci);
      const ce = CRACK_WEIGHT ? crackError(r, sim) : null;
      return ce == null ? e : e + CRACK_WEIGHT * ce;
    }),
  );

// Nelder-Mead, restarted around the best point a few times (a single run
// tends to collapse its simplex early in this many dimensions).
function minimize(f, x0, iters, restarts) {
  const n = x0.length;
  let best = {x: x0, f: f(x0)};
  for (let run = 0; run < restarts; run++) {
    let simplex = [
      best,
      ...best.x.map((_, i) => {
        const x = best.x.map((v, j) => (i === j ? v + 0.5 : v));
        return {x, f: f(x)};
      }),
    ];
    for (let it = 0; it < iters; it++) {
      simplex.sort((a, b) => a.f - b.f);
      const worst = simplex[n];
      const centroid = best.x.map(
        (_, j) => simplex.slice(0, n).reduce((s, v) => s + v.x[j], 0) / n,
      );
      const at = (t) => {
        const x = centroid.map((c, j) => c + t * (worst.x[j] - c));
        return {x, f: f(x)};
      };
      const reflect = at(-1);
      if (reflect.f < simplex[0].f) {
        const expand = at(-2);
        simplex[n] = expand.f < reflect.f ? expand : reflect;
      } else if (reflect.f < simplex[n - 1].f) simplex[n] = reflect;
      else {
        const contract = at(0.5);
        if (contract.f < worst.f) simplex[n] = contract;
        else
          simplex = simplex.map((v, i) => {
            if (i === 0) return v;
            const x = v.x.map((xj, j) => (xj + simplex[0].x[j]) / 2);
            return {x, f: f(x)};
          });
      }
    }
    simplex.sort((a, b) => a.f - b.f);
    best = simplex[0];
    console.log(`  run ${run + 1}/${restarts}: RMSE ${best.f.toFixed(2)}`);
  }
  return best;
}

const SHARED = {
  burner: 2,
  drumLoss: 0.002,
  drumAir: 0.02,
  airBoost: 1,
  airGain: 1,
  airLoss: 0.005,
};
export const INITIAL = {
  empty: {
    ...SHARED,
    probeAir: 0.03,
    probeDrum: 0.001,
    probeDuty: 0.5,
    probeLoss: 0.005,
  },
  roast: {
    ...SHARED,
    drumOffset: 50,
    drumBeans: 0.02,
    airBeans: 0.01,
    beanDrum: 0.003,
    beanAir: 0.002,
    exo: 0.05,
    endo: 0.5,
    probeBeans: 0.05,
    probeEnv: 0.005,
  },
};

// Fits params[set] over log space so everything stays positive. Each
// parameter may move at most e^4 (55x) from INITIAL, which keeps the search
// away from values the model ignores (they'd drift to infinity) and from
// rates so fast the Euler integration blows up.
export function fitSet(roasts, params, set, errFn, {iters, restarts}) {
  const keys = Object.keys(INITIAL[set]);
  const toP = (x) => ({
    ...params,
    [set]: {
      ...params[set],
      ...Object.fromEntries(
        keys.map((k, j) => {
          const lim = Math.log(INITIAL[set][k]);
          return [k, Math.exp(Math.max(lim - 4, Math.min(lim + 4, x[j])))];
        }),
      ),
    },
  });
  const safe = (x) => {
    const e = errFn(roasts, toP(x));
    return Number.isFinite(e) ? e : 1e9;
  };
  const x0 = keys.map((k) => Math.log(params[set][k]));
  return toP(minimize(safe, x0, iters, restarts).x);
}

// Nelder-Mead only finds a nearby minimum, so each fit starts from the last
// one (`start`, simParams.json), with INITIAL for any parameter it lacks; from
// INITIAL alone the roast set lands far worse (2026-11-12: 9.3 vs 6.4).
export function fit(roasts, opts = {iters: 1000, restarts: 4}, start = {}) {
  const from = Object.fromEntries(
    Object.keys(INITIAL).map((set) => [
      set,
      {...INITIAL[set], ...pick(start[set], Object.keys(INITIAL[set]))},
    ]),
  );
  console.log('empty drum (preheat):');
  const params = fitSet(roasts, from, 'empty', preheatError, opts);
  console.log('with beans (roast):');
  return fitSet(roasts, params, 'roast', roastError, opts);
}

const pick = (o, keys) =>
  Object.fromEntries(keys.filter((k) => o?.[k] != null).map((k) => [k, o[k]]));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = path.join(here, 'simParams.json');
  const roasts = loadRoasts();
  console.log(`fitting to ${roasts.length} roasts`);
  const start = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  const params = fit(roasts, undefined, start);
  fs.writeFileSync(file, JSON.stringify(params, null, 2) + '\n');
}
