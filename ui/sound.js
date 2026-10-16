// Speech and chimes. Browsers only allow audio after a click, so unlock() has
// to run from one (the "Start" overlay does it).

let ctx = null;
let quietAt = 0; // performance.now() once our last sound has died away
const ECHO_MS = 300; // the room still rings a little after

// True while the app itself is making sound (and just after), which the
// microphone would otherwise hear as pops: speech is full of clicks above
// the crack detector's 1.5 kHz cutoff.
export const busy = () =>
  speechSynthesis.speaking ||
  speechSynthesis.pending ||
  performance.now() < quietAt;

const quietAfter = (ms) =>
  (quietAt = Math.max(quietAt, performance.now() + ms + ECHO_MS));

export function unlock() {
  ctx ??= new AudioContext();
  ctx.resume();
  speechSynthesis.speak(new SpeechSynthesisUtterance(''));
}

export const unlocked = () => ctx?.state === 'running';

// Urgent speech jumps the queue.
export function say(text, urgent = false) {
  if (urgent) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.onend = () => quietAfter(0);
  speechSynthesis.speak(u);
}

// step: a soft two-note rise (the procedure changed something)
// event: one soft note (something was marked)
// alarm: a harsh triple beep
const CHIMES = {
  step: [
    [660, 0, 0.12],
    [880, 0.13, 0.18],
  ],
  event: [[740, 0, 0.2]],
  alarm: [
    [1000, 0, 0.12],
    [1000, 0.18, 0.12],
    [1000, 0.36, 0.12],
  ],
};

export function chime(kind) {
  if (!ctx) return;
  const notes = CHIMES[kind] ?? CHIMES.event;
  const t0 = ctx.currentTime + 0.01;
  quietAfter((0.01 + Math.max(...notes.map(([, s, d]) => s + d))) * 1000);
  for (const [freq, start, dur] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === 'alarm' ? 'square' : 'sine';
    osc.frequency.value = freq;
    const peak = kind === 'alarm' ? 0.25 : 0.12;
    gain.gain.setValueAtTime(0, t0 + start);
    gain.gain.linearRampToValueAtTime(peak, t0 + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + dur + 0.02);
  }
}

// One crack, for the simulator (server/simPops.js): a short burst of noise,
// first crack's a louder, lower pop, second crack's a fainter, sharper snap.
// It deliberately doesn't count as our own sound (busy()), so the microphone
// hears it the way it would hear the beans.
export function crack(kind) {
  if (!ctx) return;
  const sc = kind === 'sc';
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(rate * (sc ? 0.015 : 0.04)), rate);
  const data = buf.getChannelData(0);
  const decay = rate * (sc ? 0.002 : 0.006);
  for (let i = 0; i < data.length; i++)
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / decay);
  const src = new AudioBufferSourceNode(ctx, {buffer: buf});
  const band = new BiquadFilterNode(ctx, {
    type: 'bandpass',
    frequency: sc ? 5000 : 2500,
    Q: 0.7,
  });
  const gain = new GainNode(ctx, {
    gain: (sc ? 0.25 : 0.7) * (0.4 + Math.random() * 0.6),
  });
  src.connect(band).connect(gain).connect(ctx.destination);
  src.start();
}
