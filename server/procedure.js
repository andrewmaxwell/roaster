// Procedures (procedures/<bean>.json) and the pure logic that follows one
// through a roast. Nothing here talks to the machine; session.js does that.

import fs from 'fs';
import path from 'path';

// A procedure with its variant applied. Variants are a shallow override of
// top-level fields; a variant's `steps` replaces the whole list.
export function resolve(proc, variantName) {
  const {variants = {}, history = [], ...base} = proc;
  const names = Object.keys(variants);
  if (variantName == null && names.length) variantName = names[0];
  if (variantName != null && !variants[variantName])
    throw new Error(`${proc.bean} has no "${variantName}" variant`);
  const p = {...base, ...(variants[variantName] ?? {})};
  p.variant = variantName ?? null;
  p.version = history.length; // which procedure revision this roast used
  validate(p);
  return p;
}

const pct = (v) => v == null || (Number.isFinite(v) && v >= 0 && v <= 100);

export function validate(p) {
  const fail = (msg) => {
    throw new Error(`procedure ${p.bean}/${p.variant}: ${msg}`);
  };
  if (!p.charge || p.charge.burner == null || !pct(p.charge.burner))
    fail('charge needs a burner %');
  if (!pct(p.charge.air)) fail('bad charge air %');
  if (!(p.charge.sv > 0)) fail('charge needs an sv');
  if (p.charge.sv > 240) fail('charge.sv over 240 (the machine caps it there)');
  if (!(p.drop?.bt > 0)) fail('needs drop.bt');
  if (p.charge.sv <= p.drop.bt + 5)
    fail('charge.sv must sit well above drop.bt, or it caps the burner');
  let last = -Infinity;
  for (const s of p.steps ?? []) {
    if (!(s.bt > last)) fail('steps must be in increasing bt order');
    if (!pct(s.burner) || !pct(s.air)) fail(`bad step at ${s.bt}`);
    if (s.burner == null && s.air == null) fail(`empty step at ${s.bt}`);
    if (s.bt >= p.drop.bt) fail(`step at ${s.bt} is past the drop`);
    last = s.bt;
  }
}

const here = path.dirname(new URL(import.meta.url).pathname);
export const PROCEDURES_DIR = path.join(here, '../procedures');

export function loadProcedure(bean, variant, dir = PROCEDURES_DIR) {
  const file = path.join(dir, `${bean}.json`);
  return resolve(JSON.parse(fs.readFileSync(file, 'utf8')), variant);
}

// Rate of rise in °C/min: least-squares slope of `key` over the samples in
// the last windowMs.
export function rateOfRise(samples, windowMs = 30_000, key = 'BT') {
  if (samples.length < 2) return null;
  const tEnd = samples.at(-1).t;
  let n = 0;
  let st = 0;
  let sv = 0;
  let stt = 0;
  let stv = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (tEnd - s.t > windowMs) break;
    if (s[key] == null) continue;
    const t = (s.t - tEnd) / 60_000;
    n++;
    st += t;
    sv += s[key];
    stt += t * t;
    stv += t * s[key];
  }
  const d = n * stt - st * st;
  return n < 2 || d === 0 ? null : (n * stv - st * sv) / d;
}

// Preheat is done when, over the last `forSeconds`, BT stayed within
// btWithinC of the setpoint the whole time and ET has stopped climbing. From
// cold, the drum keeps soaking up heat for ~15 min after BT looks settled, and
// ET climbs the whole time. Falling ET is fine: between batches the drum is
// still hotter than it needs to be, and real second batches were charged with
// ET falling 0.5-1.5 °C/min, after a 5-8 minute preheat.
export function preheatStable(samples, sv, cfg) {
  return preheatProgress(samples, sv, cfg).ready;
}

// Where preheat stands, for the check above and for the UI (which shows
// exactly this, so it can't disagree with the server):
//   heldMs   how long BT has been in the band, from these samples
//   etRise   ET's rate (°C/min): the larger of the window's and its second
//            half's
//   ready    BT held the whole window, and ET isn't rising
export function preheatProgress(samples, sv, cfg) {
  const windowMs = cfg.forSeconds * 1000;
  if (!samples.length) return {heldMs: 0, etRise: null, ready: false};
  const tEnd = samples.at(-1).t;
  const inBand = (s) => s.BT != null && Math.abs(s.BT - sv) <= cfg.btWithinC;
  let i = samples.length - 1;
  while (i > 0 && inBand(samples[i]) && inBand(samples[i - 1])) i--;
  const heldMs = inBand(samples.at(-1)) ? tEnd - samples[i].t : 0;
  const recent = samples.filter((s) => tEnd - s.t <= windowMs);
  // ET must be flat over the whole window AND its second half. When BT first
  // reaches SV, ET overshoots, dips, then climbs for ~10 more minutes while
  // the drum soaks; one line fit across that dip-and-climb reads as flat
  // (real first batch, 2026-10-04: "ready" after 7 min with ET climbing
  // 2.5 °C/min, 10 °C short of where real charges were).
  const rates = [
    rateOfRise(recent, windowMs, 'ET'),
    rateOfRise(recent, windowMs / 2, 'ET'),
  ];
  const etRise = rates.includes(null) ? null : Math.max(...rates);
  const ready =
    recent[0].t <= tEnd - windowMs + 5000 && // enough history
    recent.every(inBand) &&
    etRise != null &&
    etRise <= cfg.maxEtRiseCPerMin;
  return {heldMs, etRise, ready};
}

// Follows a procedure through one roast, sample by sample. feed() returns the
// things that just happened, in order:
//   {type: 'tp', t, BT}           turning point confirmed (steps now armed)
//   {type: 'step', index, step}   BT reached a step's temperature
//   {type: 'drop'}                BT reached the drop temperature
// Steps arm only after the turning point, so the stale ~185 reading right at
// charge can't fire them. The drop does NOT wait for the turning point: the
// roast must always end. Every trigger needs `confirm` consecutive samples
// at/above its temperature, so one thermocouple spike can't fire it.
export class RoastTracker {
  constructor(proc, {confirm = 3, tpRise = 2} = {}, state = null) {
    this.proc = proc;
    this.confirm = confirm;
    this.tpRise = tpRise;
    Object.assign(
      this,
      state ?? {
        min: null, // {t, BT} coolest point so far
        tp: null, // {t, BT} once confirmed
        nextStep: 0,
        stepCount: 0, // consecutive samples at/above the next step
        dropCount: 0,
        dropped: false,
      },
    );
  }

  toJSON() {
    const {min, tp, nextStep, stepCount, dropCount, dropped} = this;
    return {min, tp, nextStep, stepCount, dropCount, dropped};
  }

  feed({t, BT}) {
    const out = [];
    if (this.dropped || BT == null) return out;
    if (!this.tp) {
      if (!this.min || BT < this.min.BT) this.min = {t, BT};
      else if (BT >= this.min.BT + this.tpRise) {
        this.tp = this.min;
        out.push({type: 'tp', ...this.tp});
      }
    }
    const steps = this.proc.steps ?? [];
    if (this.tp && this.nextStep < steps.length) {
      const step = steps[this.nextStep];
      this.stepCount = BT >= step.bt ? this.stepCount + 1 : 0;
      if (this.stepCount >= this.confirm) {
        out.push({type: 'step', index: this.nextStep, step});
        this.nextStep++;
        this.stepCount = 0;
        // If BT is already past later steps too, they fire on the following
        // samples (each still needs its own confirmations).
      }
    }
    this.dropCount = BT >= this.proc.drop.bt ? this.dropCount + 1 : 0;
    if (this.dropCount >= this.confirm) {
      this.dropped = true;
      out.push({type: 'drop'});
    }
    return out;
  }
}

// Roughly how long (ms) until `key` reaches target at the current rate, or
// null if it isn't heading there. Heating is close enough to linear over the
// remaining stretch; cooling slows as it nears the room, so that's modeled as
// exponential decay toward `ambient`.
export function timeTo(samples, target, {key = 'BT', ambient = 25} = {}) {
  const now = samples.at(-1)?.[key];
  const rate = rateOfRise(samples, 60_000, key); // °/min
  if (now == null || rate == null) return null;
  if (target > now) return rate > 0.2 ? ((target - now) / rate) * 60_000 : null;
  if (rate > -0.2 || target <= ambient) return null;
  const k = -rate / (now - ambient); // per minute
  return (Math.log((now - ambient) / (target - ambient)) / k) * 60_000;
}
