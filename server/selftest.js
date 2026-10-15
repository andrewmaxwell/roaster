// Empty-drum hardware self-test: run it before trusting the controller with
// beans, and whenever something seems off. Each check either passes or fails
// with a reason; "observations" record how the machine behaved, to settle
// questions the docs don't answer (does HP read back the command in manual
// mode? what does it read when the setpoint is capping the burner?).
//
//   1. connects and reads sane temperatures
//   2. every control takes and is echoed back (heater off)
//   3. manual burner heats, past the preheat SV (proves the SV ceiling lifts)
//   4. silence mid-heat: does the roaster stop heating by itself? (observed)
//      then: a setpoint below BT caps the burner in manual mode (observed)
//   5. auto mode: the PID runs and HP reads back its duty (observed)
//   6. the cooling fan works
//   7. a cable pull is survived and the settings are re-applied
//   8. shutdown: heater off, cool to 60 °C on air, then everything off
//
// ask(text) shows a prompt and resolves when the person is ready (they press
// Enter). Hooks let the simulator stand in for the person: pullCable() and
// plugCable() are called instead of asking when given.
//
// opts.status(text) shows a live progress line during every long wait (null
// clears it), so it's always clear the test is working, not stuck.
// opts.offerSkip(text) offers the person a way out of the cool-down; it
// returns {skipped()} (pressing Enter makes it true). Skipping ends the test
// with the air and drum still running: turning them off on a hot drum just
// lets the heat soak back up (164 → 173 °C in the second real self-test).

import {rateOfRise, timeTo} from './procedure.js';

const SAFE = {HS: 0, AH: 0, HP: 0};
const MIN = 60_000;

export async function runSelfTest({machine, clock, log, ask, opts = {}}) {
  const {heat = true, cable = true, pullCable, plugCable} = opts;
  const status = opts.status ?? (() => {});
  const offerSkip = opts.offerSkip ?? (() => ({skipped: () => false}));
  const report = {startedAt: new Date(clock.now()).toISOString(), checks: []};
  report.observations = {};
  let latest = null;
  const recent = []; // the last 2 minutes of readings, for rates and ETAs
  machine.on('sample', (r) => {
    latest = r;
    recent.push(r);
    while (r.t - recent[0].t > 2 * MIN) recent.shift();
  });

  // Waits (in clock time) until cond() is true or ms pass. Returns whether
  // it came true. show(elapsedMs) is the live status line meanwhile.
  const waitFor = async (cond, ms, step = 250, show = null) => {
    const t0 = clock.now();
    try {
      while (!cond()) {
        if (clock.now() - t0 >= ms) return false;
        if (show) status(show(clock.now() - t0));
        await clock.sleep(step);
      }
      return true;
    } finally {
      if (show) status(null);
    }
  };
  const mmss = (ms) => {
    const sec = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };
  // "BT 143.2 (+12.5°/min), about 4:10 left"
  const bt = (target) => {
    const rate = rateOfRise(recent, 60_000);
    let eta = target == null ? null : timeTo(recent, target);
    if (eta > 60 * MIN) eta = null; // the rate hasn't settled yet
    return (
      `BT ${latest?.BT ?? '-'}` +
      (rate == null ? '' : ` (${rate > 0 ? '+' : ''}${rate.toFixed(1)}°/min)`) +
      (eta == null ? '' : `, about ${mmss(eta)} left`)
    );
  };

  async function check(name, fn) {
    const t0 = clock.now();
    log(`… ${name}`);
    let ok;
    let detail;
    try {
      [ok, detail] = await fn();
    } catch (err) {
      [ok, detail] = [false, err.message];
    }
    report.checks.push({name, ok, detail, seconds: (clock.now() - t0) / 1000});
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    return ok;
  }

  // Sets controls and waits for the machine to echo them (just these: one
  // bad control mustn't fail every later check). Reports how many sends it
  // took (more than 1 means the machine dropped some).
  async function settle(values, ms = 15_000) {
    const before = {...machine.sent};
    const keys = Object.keys(values);
    machine.set(values);
    const ok = await waitFor(() => machine.settled(keys), ms);
    const sends = Object.keys(values)
      .map((k) => `${k}×${(machine.sent[k] ?? 0) - (before[k] ?? 0)}`)
      .join(' ');
    return [
      ok,
      ok ? `echoed (sends: ${sends})` : `not echoed: ${mismatch(keys)}`,
    ];
  }
  const mismatch = (keys) =>
    Object.entries(machine.desired)
      .filter(([k]) => !keys || keys.includes(k))
      .filter(([k]) => machine.owns(k) && !machine.matches(k))
      .map(([k, v]) => `${k} wants ${v}, reads ${machine.state[k] ?? '-'}`)
      .join(', ');

  let heated = false;
  let skippedCooling = false;
  let connectedOnce = false;
  try {
    // 1
    const connected = await check(
      'connects and reads temperatures',
      async () => {
        const up = await waitFor(
          () => machine.connected && latest,
          20_000,
          250,
          (t) => `waiting for the roaster… ${mmss(t)}`,
        );
        if (!up)
          return [false, 'no connection (is the cable in? is Artisan closed?)'];
        const {BT, ET, AT} = latest;
        const sane = (x) => typeof x === 'number' && x > -10 && x < 300;
        if (![BT, ET, AT].every(sane))
          return [false, `odd readings BT ${BT} ET ${ET} AT ${AT}`];
        report.observations.serial = machine.state.SN ?? null;
        return [true, `BT ${BT} ET ${ET} AT ${AT}`];
      },
    );
    if (!connected) return finish(report);
    connectedOnce = true;

    // 2
    await check('heater safely off', () => settle(SAFE));
    for (const [name, values] of [
      ['air', {FC: 40}],
      ['drum', {RC: 50}],
      ['cooling fan on', {CS: 1}],
      ['cooling fan off', {CS: 0}],
      ['setpoint', {TS: 150}],
      ['auto mode on (heater still off)', {AH: 1}],
      ['auto mode off', {AH: 0}],
      ['heater switch on (burner at 0)', {HS: 1}],
      ['heater switch off', {HS: 0}],
      ['drum back to 90, air 30', {RC: 90, FC: 30}],
    ])
      await check(`control: ${name}`, () => settle(values));

    // 3-5
    if (heat) {
      await ask(
        'The drum must be EMPTY. The next checks fire the burner. Press Enter to start.',
      );
      heated = true;
      const startBT = latest.BT;
      const target = Math.max(startBT + 20, 195);
      const burnerOK = await check('manual burner heats', async () => {
        const [ok, detail] = await settle({TS: 240, HS: 1, AH: 0, HP: 60});
        if (!ok) return [false, detail];
        report.observations.hpReadsInManual = machine.state.HP;
        const rising = await waitFor(
          () => latest.BT >= startBT + 5,
          4 * MIN,
          1000,
          (t) =>
            `burner at 60%, waiting for BT to rise: ${bt()} · ${mmss(t)} of 4:00`,
        );
        if (!rising)
          return [
            false,
            `BT only went ${startBT} → ${latest.BT} in 4 min at 60%`,
          ];
        return [true, `BT ${startBT} → ${latest.BT}`];
      });
      if (!burnerOK) machine.set(SAFE); // never leave a failed burner lit
      if (burnerOK)
        await check(`heats past the preheat SV (to ${target})`, async () => {
          const t0 = clock.now();
          const ok = await waitFor(
            () => latest.BT >= target,
            20 * MIN,
            1000,
            (t) => `heating to ${target}: ${bt(target)} · ${mmss(t)} elapsed`,
          );
          const mins = ((clock.now() - t0) / MIN).toFixed(1);
          return ok
            ? [true, `reached ${latest.BT} in ${mins} min`]
            : [false, `stuck at ${latest.BT} after ${mins} min`];
        });
      if (burnerOK) await watchdog();
      if (burnerOK) {
        // 4: with TS below BT, does the burner stop even in manual mode?
        const capBT = latest.BT;
        machine.set({TS: Math.round(capBT - 15)});
        await waitFor(() => machine.settled(), 15_000);
        await waitFor(
          () => false,
          90_000,
          1000,
          (t) =>
            `setpoint below BT, watching what the burner does: ${bt()} · ${mmss(90_000 - t)} left`,
        );
        report.observations.setpointCap = {
          note: 'manual mode, HP 60, TS 15 below BT, after 90 s',
          btChange: round1(latest.BT - capBT),
          hpReads: latest.HP,
        };
        log(
          `observed: setpoint cap → BT ${round1(latest.BT - capBT)} in 90 s, HP reads ${latest.HP}`,
        );
        // 5: auto mode, the PID should hold around the setpoint
        await check('auto mode (PID) takes over', async () => {
          const [ok, detail] = await settle({TS: 185, AH: 1});
          if (!ok) return [false, detail];
          const duties = [];
          for (let i = 0; i < 8; i++) {
            await waitFor(
              () => false,
              15_000,
              1000,
              (t) =>
                `auto mode: ${bt()}, burner ${latest.HP}% · ${mmss(2 * MIN - i * 15_000 - t)} left`,
            );
            duties.push(latest.HP);
          }
          report.observations.pidDuty = duties;
          return [true, `HP read ${duties.join(', ')} over 2 min`];
        });
      }
    }

    // Heater off before anything else (the PID check leaves it on).
    if (heat)
      await check('heater off after the heat checks', () => settle(SAFE));

    // 6
    await check('cooling fan', () => settle({CS: 1}));

    // 7
    if (cable)
      await check('survives a cable pull', async () => {
        let downs = 0;
        const onDown = () => downs++;
        machine.on('disconnected', onDown);
        try {
          if (pullCable) pullCable();
          else await ask('Unplug the USB cable now, then press Enter.');
          const noticed = await waitFor(
            () => downs > 0,
            MIN,
            250,
            (t) => `waiting to notice the cable is out… ${mmss(t)}`,
          );
          if (!noticed) return [false, 'never noticed the cable was out'];
          if (plugCable) plugCable();
          else await ask('Plug it back in, then press Enter.');
          const back = await waitFor(
            () => machine.connected,
            MIN,
            250,
            (t) => `reconnecting… ${mmss(t)}`,
          );
          if (!back) return [false, "didn't reconnect within a minute"];
          return settle({}, 20_000);
        } finally {
          machine.off('disconnected', onDown);
        }
      });
  } finally {
    // 8 (always, even after a failure, as long as there's a machine to talk to)
    if (connectedOnce) {
      await check('shutdown: heater off, cool down', async () => {
        const [ok, detail] = await settle({...SAFE, FC: 100, RC: 90});
        if (!ok) return [false, detail];
        if (!heated && !(latest?.BT >= 60)) return [true, 'nothing to cool'];
        const skip = offerSkip(
          "Cooling to 60 °C with the air at 100%. Press Enter to finish now; the air and drum keep running until you run 'node kaleido/server/stop.js --all'.",
        );
        const cooled = await waitFor(
          () => latest.BT < 60 || skip.skipped(),
          45 * MIN,
          1000,
          (t) =>
            `cooling to 60: ${bt(60)} · ${mmss(t)} elapsed · Enter finishes now (air and drum keep cooling)`,
        );
        if (skip.skipped()) {
          skippedCooling = true;
          return [true, `skipped at ${latest.BT}; air and drum left running`];
        }
        return cooled
          ? [true, `cooled to ${latest.BT}`]
          : [false, `still ${latest.BT} after 45 min`];
      });
      // Whatever happened above, end with everything off (except the air
      // and drum, if the person cut the cool-down short on a hot machine).
      if (skippedCooling)
        await check('heater off, air and drum left cooling', () =>
          settle({...SAFE, CS: 0}, 30_000),
        );
      else
        await check('all off', () =>
          settle({...SAFE, FC: 0, RC: 0, CS: 0}, 30_000),
        );
    }
  }
  return finish(report);

  // The roaster has no panel, so if the computer crashes mid-roast, does the
  // burner keep going? Go quiet for 45 s mid-heat (no goodbye, like a crash)
  // and look at what it did on its own before re-applying anything.
  async function watchdog() {
    const SILENT = 45_000;
    const saved = {...machine.desired};
    const before = {...latest};
    machine.desired = {}; // nothing to re-apply until we've looked
    machine.goSilent(SILENT);
    const back = await waitFor(
      () => machine.connected && latest.t > before.t + SILENT,
      SILENT + MIN,
      250,
      (t) =>
        t < SILENT
          ? `silent, like a crash, to see if the roaster stops heating by itself · ${mmss(SILENT - t)} left`
          : `reconnecting… ${mmss(t - SILENT)}`,
    );
    const after = {...latest};
    machine.set(saved);
    await waitFor(() => machine.settled(), 15_000);
    if (!back) {
      log("observed: watchdog: couldn't reconnect to look");
      return;
    }
    const change = round1(after.BT - before.BT);
    const verdict =
      after.HS === 0 || after.HP === 0 || change < -2
        ? 'the roaster cut the heat on its own'
        : 'the roaster KEPT HEATING with no computer';
    report.observations.watchdog = {
      silentSeconds: SILENT / 1000,
      before: {BT: before.BT, HP: before.HP, HS: before.HS, AH: before.AH},
      after: {BT: after.BT, HP: after.HP, HS: after.HS ?? null, AH: after.AH},
      verdict,
    };
    log(
      `observed: watchdog: BT ${before.BT} → ${after.BT} in ${SILENT / 1000} s of silence, then HS ${after.HS ?? '-'} HP ${after.HP}: ${verdict}`,
    );
  }

  function finish(r) {
    r.sends = {...machine.sent};
    r.passed = r.checks.every((c) => c.ok);
    return r;
  }
}

const round1 = (x) => Math.round(x * 10) / 10;
