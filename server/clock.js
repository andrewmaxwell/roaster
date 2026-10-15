// All timing goes through a clock so the simulator can run a whole session
// faster than real time. now() is in (simulated) ms; sleep() takes simulated ms.

export function createClock(speed = 1) {
  const t0 = Date.now();
  return {
    speed,
    now: () => t0 + (Date.now() - t0) * speed,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms / speed)),
  };
}

// A clock that only moves when told to, for tests: advance(ms) runs every
// sleep that comes due, in order, letting the code each one wakes up run to
// its next await before moving on. An hour-long session takes milliseconds,
// and runs the same way every time.
export function createVirtualClock(start = 0) {
  let now = start;
  let seq = 0;
  const timers = [];
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    speed: Infinity,
    now: () => now,
    sleep: (ms) =>
      new Promise((resolve) => {
        timers.push({at: now + Math.max(0, ms), seq: seq++, resolve});
      }),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        if (!timers.length || timers[0].at > end) break;
        const timer = timers.shift();
        now = timer.at;
        timer.resolve();
      }
      now = end;
    },
    // Advances until cond() is true; throws if that takes longer than ms.
    async until(cond, ms, step = 500) {
      const end = now + ms;
      while (!cond()) {
        if (now >= end) throw new Error('virtual clock: timed out');
        await this.advance(step);
      }
    },
  };
}
