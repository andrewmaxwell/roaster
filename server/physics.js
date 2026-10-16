// Lumped thermal model of the M1 LITE, used by the simulator. Parameters are
// fit to real roasts by fitSim.js and saved in simParams.json as two sets:
// `empty` (drum without beans: preheat, between batches) and `roast` (with
// beans). One set can't fit both well in a model this simple.
//
// State: D (drum metal), ET (drum air), BT (what the bean probe reads), Tb
// (bean mass temp, null when the drum is empty), grams.
// Inputs: duty (actual burner %, 0-100), FC (air %), AT (ambient).
//
// The burner heats the drum; the drum heats the air and (by contact) the
// beans. Late in a roast the real ET drops below BT while BT keeps climbing,
// which only works if the beans get heat from the drum, not just the air.
// The probe sits in the bean pile, so it lags toward the bean temp (that lag is
// what makes the turning point ~110 instead of room temp).

export const GREEN_TEMP = 22; // °C, beans going in
const EXO_ONSET = 188; // °C bean temp
const DISCHARGE_TAU_S = 9; // probe settling after the beans come out
const DISCHARGE_SETTLE_S = 30;
const DISCHARGE_FALL_C = 20;

export function step(s, u, params, dt) {
  const beans = s.Tb != null;
  const p = beans ? params.roast : params.empty;
  const air = 1 + p.airBoost * (u.FC / 100);
  const m = s.grams / 155;
  const drumToAir = p.drumAir * air * (s.D - s.ET);
  const drumToBeans = beans ? p.drumBeans * m * (s.D - s.Tb) : 0;
  const airToBeans = beans ? p.airBeans * m * (s.ET - s.Tb) : 0;
  const dD =
    (p.burner * u.duty) / 100 -
    p.drumLoss * (s.D - u.AT) -
    drumToAir -
    drumToBeans;
  const dET =
    p.airGain * drumToAir - p.airLoss * air * (s.ET - u.AT) - airToBeans;
  let dBT;
  if (!beans) {
    // Empty drum: the probe sits in the burner's hot air stream, so it comes
    // up to temperature in minutes while ET follows the drum metal, which
    // takes ~15 minutes to heat-soak (and the PID's duty drifts down as it
    // does).
    dBT =
      (p.probeDuty * u.duty) / 100 +
      p.probeAir * (s.ET - s.BT) +
      p.probeDrum * (s.D - s.BT) -
      p.probeLoss * (s.BT - u.AT);
    // Just after a discharge the probe, no longer in the bean pile, drops
    // to the air temperature fast: on the real logs (#30, #37-39) the
    // BT - ET gap halves about every 6 s, a 10 °C fall in 12-24 s. It falls
    // as fast with ET at or above BT (mid-roast, or #1, #4, #17: the door's
    // open), so it never settles toward more than DISCHARGE_FALL_C under
    // where it was.
    if (s.settleS > 0) {
      dBT -= (s.BT - Math.min(s.ET, s.settleTo)) / DISCHARGE_TAU_S;
      s.settleS -= dt;
    }
  } else {
    // Beans: heated by drum contact and hot air, plus their own exothermic
    // heat from first crack on (onset fixed near FC temps; only its strength
    // is fit, or the fit wanders the onset off to nowhere).
    const exo = p.exo / (1 + Math.exp(-(s.Tb - EXO_ONSET) / 4));
    const dTb = p.beanDrum * (s.D - s.Tb) + p.beanAir * (s.ET - s.Tb) + exo;
    dBT = p.probeBeans * (s.Tb - s.BT) + p.probeEnv * (s.ET - s.BT);
    s.Tb += dTb * dt;
  }
  s.D += dD * dt;
  s.ET += dET * dt;
  s.BT += dBT * dt;
}

// The drum metal isn't measured, so estimate it as the temperature where it
// would hold steady with the recent burner duty `u`. Without u (a cold
// machine) it's just ET.
export function initialState(ET, BT, params, u) {
  const p = params.empty;
  let D = ET;
  if (u) {
    const air = 1 + p.airBoost * (u.FC / 100);
    const k = p.drumLoss + p.drumAir * air;
    D =
      ((p.burner * u.duty) / 100 + p.drumLoss * u.AT + p.drumAir * air * ET) /
      k;
  }
  return {D, ET, BT, Tb: null, grams: 0};
}

// Beans in. The roast parameters were fit assuming the drum is `drumOffset`
// above ET at charge, so start it there.
export function charge(s, grams, params) {
  s.Tb = GREEN_TEMP;
  s.grams = grams;
  s.D = s.ET + params.roast.drumOffset;
}

// Beans out. The drum state the roast parameters left means something
// different to the empty-drum parameters, so restart it as a drum holding
// preheat temperature at typical preheat duty.
export function discharge(s, params, u) {
  s.Tb = null;
  s.grams = 0;
  s.D = initialState(s.ET, s.BT, params, {...u, duty: 25}).D;
  s.settleS = DISCHARGE_SETTLE_S;
  s.settleTo = s.BT - DISCHARGE_FALL_C;
}

// What the burner actually does: off without HS; the machine's PID in auto
// mode; the commanded HP in manual, but cut once BT reaches TS (the setpoint
// caps the burner even in manual mode).
export function burnerDuty(m, s, ctl, dt) {
  if (!m.HS) return 0;
  if (m.AH) return pid(ctl, s, m.TS, dt);
  return s.BT >= m.TS ? 0 : m.HP;
}

// The machine's own PID in auto mode, approximated as PI with a clamped
// integral. Tuned by hand to resemble the burner pattern in real preheats
// (it hovers 10-45% once settled).
function pid(ctl, s, sv, dt) {
  const err = sv - s.BT;
  ctl.i = Math.max(-20, Math.min(30, (ctl.i ?? 0) + err * 0.05 * dt));
  return Math.max(0, Math.min(100, err * 6 + ctl.i));
}
