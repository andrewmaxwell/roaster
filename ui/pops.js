// Listens to the microphone for cracks: short, sharp transients well above
// the background (drum, fans, the room). It only reports pops; deciding
// whether they add up to first crack is for the person (and the hint in
// main.js). No audio is kept.
//
// The detector runs in an AudioWorklet so it isn't throttled like timers in
// a background tab. Below ~1.5 kHz is cut first, which removes most of the
// drum rumble and fan noise while keeping the crack's click.

const WORKLET = `
class PopDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.floor = 0.003; // running background level (RMS)
    this.last = -1;
    this.blocks = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    let peak = 0, sum = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      sum += a * a;
    }
    const rms = Math.sqrt(sum / ch.length);
    // A pop: a peak far above the background, not too soon after the last.
    // One sound rings for a while: roast #38 logged three "pops" 0.1 s apart
    // at 177 °C, a minute before first crack, enough for the hint on its own.
    if (peak > this.floor * 12 && peak > 0.01 && currentTime - this.last > 0.25) {
      this.last = currentTime;
      this.port.postMessage({pop: peak / this.floor});
    } else {
      // The background adapts slowly, and never to the pops themselves.
      this.floor += (Math.max(rms, 1e-4) - this.floor) * 0.003;
    }
    if (++this.blocks % 40 === 0) this.port.postMessage({level: this.floor});
    return true;
  }
}
registerProcessor('pop-detector', PopDetector);
`;

// Starts listening. onPop(intensity) for each pop, onLevel(rms) now and then.
// Returns stop().
export async function listen({onPop, onLevel}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(
    new Blob([WORKLET], {type: 'application/javascript'}),
  );
  await ctx.audioWorklet.addModule(url);
  const source = ctx.createMediaStreamSource(stream);
  const highpass = new BiquadFilterNode(ctx, {
    type: 'highpass',
    frequency: 1500,
  });
  const detector = new AudioWorkletNode(ctx, 'pop-detector');
  detector.port.onmessage = ({data}) => {
    if (data.pop) onPop(Math.round(data.pop));
    if (data.level) onLevel?.(data.level);
  };
  source.connect(highpass).connect(detector);
  return () => {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
  };
}

// Pops cluster when cracking really starts. The hint asks the person; it
// never marks anything itself.
export function clusters(pops, now, {within = 8000, count = 3} = {}) {
  return pops.filter((t) => now - t <= within).length >= count;
}
