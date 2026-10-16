// Crack sounds for the simulator: the pops a person would hear, as a rate
// that rises and falls with BT. The browser plays them through the speakers
// (ui/sound.js crack()), where the microphone can hear them like real ones,
// so the crack hint gets tested along with the person's ears.
//
// First crack centers on the bean's reference roast's FC temperature (on
// this probe, 189-197 °C); second crack starts around 206 (202-207 in the
// real logs), which most drops stop short of.

export const SC_ONSET_C = 206;
const FC_DEFAULT_C = 194;

// Pops per second (simulated time) at this BT.
export function popRate(BT, fcBT = FC_DEFAULT_C) {
  let fc = 0;
  const x = BT - fcBT;
  // A few early pops, then rolling, then tapering off ~10 °C later.
  if (x >= -0.5 && x < 2) fc = 0.1 + ((x + 0.5) / 2.5) * 1.4;
  else if (x >= 2 && x < 6) fc = 1.5;
  else if (x >= 6 && x < 10) fc = 1.5 * (1 - (x - 6) / 4);
  const y = BT - SC_ONSET_C;
  const sc = y < 0 ? 0 : Math.min(3, 0.5 + y / 2);
  return {fc, sc};
}

// The pops in the dtS seconds just past, at random moments in it:
// [{kind: 'fc' | 'sc', atS}], atS from its start.
export function popsBetween(BT, dtS, fcBT, random = Math.random) {
  const out = [];
  const rates = popRate(BT, fcBT);
  for (const kind of ['fc', 'sc']) {
    const rate = rates[kind];
    if (!(rate > 0)) continue;
    // A Poisson process: exponential gaps.
    for (let t = -Math.log(1 - random()) / rate; t < dtS;) {
      out.push({kind, atS: t});
      t += -Math.log(1 - random()) / rate;
    }
  }
  return out.sort((a, b) => a.atS - b.atS);
}
