// A simulated person at the simulated roaster, for tests and demos: does
// what the session asks (charge, mark FC, discharge, pick the next beans).
// The sim has no cracking sounds, so FC is "heard" at a fixed BT.

export function autopilot(session, sim, clock, opts) {
  const {
    batches, // [{bean, variant, weightIn}], roasted in order, then done()
    fcAt = 189, // BT at which first crack is "heard"
    scAt = null, // BT at which second crack is "heard" (null = never)
    reactMs = 4000, // how long the person takes to do what's asked
    coolingMs = 4 * 60_000, // cooling fan runs this long after a drop
  } = opts;
  const queue = [...batches];
  let charging = false;
  const later = async (ms, fn) => {
    await clock.sleep(ms);
    fn();
  };

  session.on('say', (text) => {
    if (/ready for charge/i.test(text) && !charging) {
      charging = true;
      later(reactMs, () => sim.chargeBeans(session.next?.weightIn ?? 155));
    }
  });
  session.on('charge', () => (charging = false));
  session.on('sample', (s) => {
    if (s.phase !== 'ROASTING') return;
    const b = session.batch;
    if (!b.fc && b.tp && s.BT >= fcAt) session.markFC();
    else if (scAt != null && !b.sc && b.tp && s.BT >= scAt) session.markSC();
  });
  session.on('drop', () => {
    later(reactMs, () => sim.discharge());
    later(coolingMs, () => session.setCooling(false));
    later(reactMs * 2, () => {
      if (queue.length) session.selectBatch(queue.shift());
      else session.done();
    });
  });

  session.selectBatch(queue.shift());
  return new Promise((resolve) => session.once('off', resolve));
}
