// Fits physics.js parameters to the real roasts in logs/ by replaying each
// log's burner/air through the model and minimizing the curve error.
// Usage: node kaleido/server/fitSim.js   (writes server/simParams.json)
//
// The two parameter sets are fit separately: `empty` on each log's preheat
// (first sample to charge), `roast` on each roast (charge to drop, starting
// from the logged temps at charge, closed loop; see replayClosed).

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {readAlog, channels} from './alog.js';
import {step, charge, initialState, GREEN_TEMP} from './physics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(here, '../logs');
const DT = 0.5;

export function loadRoasts() {
  const roasts = [];
  for (const f of fs.readdirSync(logsDir).filter((f) => f.endsWith('.alog'))) {
    const d = readAlog(path.join(logsDir, f));
    const [ci, , , , , , di] = d.timeindex;
    if (ci < 1 || di <= ci) continue; // no charge, or never dropped
    roasts.push({name: f, grams: d.weight[0], c: channels(d), ci, di});
  }
  return roasts;
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
    const u = inputs(c, k);
    for (let t = c.t[k]; t < c.t[k + 1] - 1e-9; t += DT) step(s, u, params, DT);
  }
  return out;
}

function rmse(r, sim, from) {
  let e = 0;
  sim.forEach((x, k) => {
    e += (x.BT - r.c.BT[from + k]) ** 2 + 0.3 * (x.ET - r.c.ET[from + k]) ** 2;
  });
  return Math.sqrt(e / sim.length);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export const preheatError = (roasts, params) =>
  mean(roasts.map((r) => rmse(r, replay(r, params, 0, r.ci, false), 0)));

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
  charge(s, r.grams, params);
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
    for (let t = c.t[k]; t < c.t[k + 1] - 1e-9; t += DT) step(s, u, params, DT);
  }
  return out;
}

export const roastError = (roasts, params) =>
  mean(roasts.map((r) => rmse(r, replayClosed(r, params), r.ci)));

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
    probeBeans: 0.05,
    probeEnv: 0.005,
  },
};

// Fits params[set] over log space so everything stays positive. Each
// parameter may move at most e^4 (55x) from INITIAL, which keeps the search
// away from values the model ignores (they'd drift to infinity) and from
// rates so fast the Euler integration blows up.
function fitSet(roasts, params, set, errFn, {iters, restarts}) {
  const keys = Object.keys(INITIAL[set]);
  const toP = (x) => ({
    ...params,
    [set]: Object.fromEntries(
      keys.map((k, j) => {
        const lim = Math.log(INITIAL[set][k]);
        return [k, Math.exp(Math.max(lim - 4, Math.min(lim + 4, x[j])))];
      }),
    ),
  });
  const safe = (x) => {
    const e = errFn(roasts, toP(x));
    return Number.isFinite(e) ? e : 1e9;
  };
  const x0 = keys.map((k) => Math.log(params[set][k]));
  return toP(minimize(safe, x0, iters, restarts).x);
}

export function fit(roasts, opts = {iters: 1000, restarts: 4}) {
  console.log('empty drum (preheat):');
  const params = fitSet(roasts, INITIAL, 'empty', preheatError, opts);
  console.log('with beans (roast):');
  return fitSet(roasts, params, 'roast', roastError, opts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const roasts = loadRoasts();
  console.log(`fitting to ${roasts.length} roasts`);
  const params = fit(roasts);
  fs.writeFileSync(
    path.join(here, 'simParams.json'),
    JSON.stringify(params, null, 2) + '\n',
  );
}
