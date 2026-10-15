// A roasting session: preheat, then batch after batch, until the user is done.
//
//   PREHEAT → READY → ROASTING → PREHEAT (next batch) → … → SHUTDOWN → OFF
//
// The machine settings for every phase come from one place, desiredState(),
// and are handed to the Machine reconciler, which keeps resending until the
// roaster matches. So after a phase change, a reconnect, or a restart from a
// saved state, the same call puts the roaster where it should be.
//
// The cooling fan (CS) is independent of the phase: it turns on 1 °C before
// the drop and stays on until the user turns it off.
//
// Events:
//   'phase' (phase)           'sample' (reading + ror, phase, roastMs)
//   'say' (text, {urgent})    speak this
//   'chime' (kind)            soft sound for an automatic change
//   'alert' ({level, text})   show this (urgent ones are also spoken)
//   'step', 'charge', 'tp', 'fc', 'sc', 'drop', 'beansOut'  (batch, detail)
//   'batchComplete' (batch)   a minute after drop; the record is final
//   'persist'                 state worth saving changed (see toJSON)
//   'off'                     shutdown finished; everything is off

import {EventEmitter} from 'events';
import {RoastTracker, preheatProgress, rateOfRise} from './procedure.js';

export const SHUTDOWN = {air: 100, coolBelowC: 60};
const KEEP_RECENT_MS = 10 * 60_000; // samples kept for stability/RoR checks
const READY_REPEAT_MS = 60_000; // repeat "ready for charge" this often
const DROP_REPEAT_MS = 5_000; // repeat "drop now" until the beans are out
// BT falling this much within BEANS_OUT_MS (since the drop) = the drum is
// empty. On the real logs that comes 12-24 s after the drop, the same or
// earlier than "10 °C under the drop temp". It has to be fast: a drum left
// closed cools 10 °C too, slowly (#1, dropped early: ~7 °C/min), and calling
// that "out" would turn the heat on with the beans inside.
const BEANS_OUT_FALL = 10;
const BEANS_OUT_MS = 30_000;
const RECORD_AFTER_DROP_MS = 60_000; // after the drop, once the beans are out
const DROP_WARNING_S = 30;
const COOL_BEFORE_DROP_C = 1; // cooling fan on this far below the drop temp
const STALL = {windowMs: 60_000, belowCPerMin: 1, repeatMs: 120_000};
const LONG_ROAST_MS = 16 * 60_000;
// A roast resumes after a restart only if the app was down less than this.
// Longer, and the beans have sat without heat (or are already out), so
// carrying on with the procedure would be roasting something else.
const RESUME_ROAST_WITHIN_MS = 2 * 60_000;
// A charge is a sudden BT fall from the temperature before it. In preheat
// (beans can go in before "ready": 3 of the 12 real roasts before #38 did)
// the fall must be bigger, because BT is still settling there: real preheats
// swing up to 8.5 °C in this window (cooling after the last drop), while every
// real charge fell 25 °C within 6-10 s.
const CHARGE = {
  fall: 5,
  preheatFall: 20,
  baselineMs: [30_000, 10_000],
  confirm: 2,
};
const NAMES = {
  TS: 'Setpoint',
  HS: 'Heater',
  AH: 'Auto mode',
  HP: 'Burner',
  FC: 'Air',
  RC: 'Drum',
  CS: 'Cooling fan',
};

export class Session extends EventEmitter {
  // preheat: the contents of preheat.json
  // loadProcedure(bean, variant): a resolved procedure (procedure.js)
  // nextRoastNumber(): the # for a new roast (optional)
  constructor({machine, clock, preheat, loadProcedure, nextRoastNumber}) {
    super();
    Object.assign(this, {machine, clock, preheat, loadProcedure});
    this.nextRoastNumber = nextRoastNumber ?? (() => null);
    this.phase = 'NEW';
    this.next = null; // {bean, variant, weightIn, proc}: the batch to charge next
    this.batch = null; // the roast in progress (until a minute after its drop)
    this.tracker = null;
    this.planned = {}; // procedure's current burner/air during a roast
    this.overrides = {}; // user's burner/air, which beat the procedure's
    this.cooling = false;
    this.doneRequested = false;
    this.recent = []; // last few minutes of samples
    this.log = []; // samples since the last batch was finalized
    this.alarms = {};
    this.onSample = this.onSample.bind(this);
    this.onStuck = this.onStuck.bind(this);
    this.onDisconnected = this.onDisconnected.bind(this);
    this.onBlind = this.onBlind.bind(this);
  }

  // ---- lifecycle

  // saved: from toJSON(). downMs: how long ago it was saved.
  start(saved = null, {downMs = 0} = {}) {
    if (saved) this.restore(saved);
    this.machine.on('sample', this.onSample);
    this.machine.on('stuck', this.onStuck);
    this.machine.on('disconnected', this.onDisconnected);
    this.machine.on('blind', this.onBlind);
    if (this.phase === 'NEW') {
      this.setPhase('PREHEAT');
      this.say('Preheating.');
    } else if (this.phase === 'ROASTING' && downMs > RESUME_ROAST_WITHIN_MS)
      this.endInterruptedRoast(downMs);
    else this.apply();
  }

  detach() {
    this.machine.off('sample', this.onSample);
    this.machine.off('stuck', this.onStuck);
    this.machine.off('disconnected', this.onDisconnected);
    this.machine.off('blind', this.onBlind);
  }

  setPhase(phase) {
    this.phase = phase;
    this.apply();
    this.emit('phase', phase);
    this.emit('persist');
  }

  // What the roaster should be doing right now.
  desiredState() {
    const p = this.preheat;
    const CS = this.cooling ? 1 : 0;
    switch (this.phase) {
      case 'PREHEAT':
      case 'READY': {
        // Heater off until the dropped beans are out: an early drop (BT
        // under the preheat SV) would otherwise have the PID heat them.
        const HS = this.batch?.drop && !this.batch.beansOut ? 0 : 1;
        return {TS: p.sv, HS, AH: 1, FC: p.air, RC: p.drum, CS};
      }
      case 'ROASTING':
        return {
          TS: this.batch.proc.charge.sv,
          HS: 1,
          AH: 0,
          HP: this.overrides.HP ?? this.planned.HP,
          FC: this.overrides.FC ?? this.planned.FC,
          RC: p.drum,
          CS,
        };
      case 'SHUTDOWN':
        return {HS: 0, AH: 0, HP: 0, FC: SHUTDOWN.air, RC: p.drum, CS};
      case 'OFF':
        return {HS: 0, AH: 0, HP: 0, FC: 0, RC: 0, CS: 0};
      default:
        return {};
    }
  }

  apply() {
    this.machine.set(this.desiredState());
  }

  // ---- user actions

  // Choose the beans for the next batch (mid-roast too: it's the one after).
  selectBatch({bean, variant, weightIn}) {
    if (this.phase === 'SHUTDOWN' || this.phase === 'OFF')
      throw new Error('the session is shutting down');
    const proc = this.loadProcedure(bean, variant);
    this.next = {bean, variant: proc.variant, weightIn, proc};
    this.doneRequested = false;
    if (this.phase === 'READY') this.promptCharge(true);
    this.emit('persist');
    return this.next;
  }

  // The weight of the batch being roasted, or else of the next one.
  setWeightIn(grams) {
    const target = this.batch && !this.batch.drop ? this.batch : this.next;
    if (!target) throw new Error('no batch to set the weight of');
    target.weightIn = grams;
    this.emit('persist');
  }

  markFC() {
    const b = this.roasting('mark first crack');
    if (b.fc) return;
    b.fc = this.mark();
    this.machine.event(4);
    this.chime('event');
    this.emit('fc', b, b.fc);
    this.emit('persist');
  }

  // Second crack means drop now.
  markSC() {
    const b = this.roasting('mark second crack');
    if (b.sc) return;
    b.sc = this.mark();
    this.machine.event(6);
    this.emit('sc', b, b.sc);
    this.drop('second crack');
  }

  dropNow() {
    this.roasting('drop');
    this.drop('button');
  }

  beansOut() {
    const b = this.batch;
    if (!b?.drop || b.beansOut) return;
    b.beansOut = this.mark();
    this.apply(); // preheat may heat now
    this.emit('beansOut', b, b.beansOut);
    this.emit('persist');
  }

  setCooling(on) {
    this.cooling = !!on;
    this.apply();
    this.emit('persist');
  }

  // control: 'burner' or 'air'. Takes that control away from the procedure
  // until release().
  override(control, value) {
    const b = this.roasting('override');
    const key = {burner: 'HP', air: 'FC'}[control];
    if (!key) throw new Error(`can't override ${control}`);
    if (!(value >= 0 && value <= 100)) throw new Error('0-100%');
    this.overrides[key] = value;
    b.overrides.push({...this.mark(), control, value});
    this.apply();
    this.emit('persist');
  }

  release(control) {
    const b = this.roasting('release');
    const key = {burner: 'HP', air: 'FC'}[control];
    delete this.overrides[key];
    b.overrides.push({...this.mark(), control, value: null});
    this.apply();
    this.emit('persist');
  }

  // STOP: heater off now, whatever is happening. Mid-roast that's a drop
  // (the beans have to come out) and then the end of the session; the air
  // and drum keep running to cool, as in any shutdown.
  emergencyStop() {
    if (this.phase === 'ROASTING') {
      this.doneRequested = true;
      this.drop('emergency stop');
    } else if (this.phase !== 'SHUTDOWN' && this.phase !== 'OFF')
      this.shutdown();
    this.alert(
      'urgent',
      'Stopped: heater off. Air and drum keep running to cool.',
    );
  }

  // Ends the cool-down early: everything off now, at whatever temperature.
  offNow() {
    if (this.phase !== 'SHUTDOWN') throw new Error('not shutting down');
    if (this.batch?.drop && !this.batch.beansOut) this.beansOut();
    if (this.batch) this.finishBatch();
    this.cooling = false;
    this.setPhase('OFF');
  }

  // Pops the browser's microphone heard ({intensity}); stamped on arrival.
  // Hints only: they're logged and shown, never acted on.
  addPop(intensity) {
    const b = this.batch;
    if (this.phase !== 'ROASTING' || !b) return;
    (b.pops ??= []).push({...this.mark(), intensity});
  }

  // Done for the day. Mid-roast, this takes effect at the drop.
  done() {
    if (this.phase === 'SHUTDOWN' || this.phase === 'OFF') return;
    this.next = null;
    if (this.phase === 'ROASTING') {
      this.doneRequested = true;
      this.say('Shutting down after this batch.');
      this.emit('persist');
    } else this.shutdown();
  }

  // ---- machine events

  onSample(r) {
    const s = {
      t: r.t,
      BT: r.BT,
      ET: r.ET,
      AT: r.AT,
      TS: r.TS,
      HP: r.HP,
      FC: r.FC,
      RC: r.RC,
      AH: r.AH,
      HS: r.HS,
      CS: r.CS,
    };
    this.recent.push(s);
    while (this.recent.length && s.t - this.recent[0].t > KEEP_RECENT_MS)
      this.recent.shift();
    this.log.push(s);
    // All off, the log only feeds the chart; don't let it grow all night.
    if (this.phase === 'OFF')
      while (s.t - this.log[0].t > KEEP_RECENT_MS) this.log.shift();
    const ror = rateOfRise(this.recent);
    const roastMs = this.batch?.charge ? s.t - this.batch.charge.t : null;
    const preheat = this.phase === 'PREHEAT' ? this.preheatStatus() : null;
    this.emit('sample', {...s, ror, phase: this.phase, roastMs, preheat});

    // (A sample listener can change the phase, so the status computed above
    // may not exist.)
    if (this.phase === 'PREHEAT') {
      // (Not while the last batch's record is open: its beans coming out
      // look like a charge.)
      if (!this.batch) this.checkCharge(s, CHARGE.preheatFall);
      if (this.phase === 'PREHEAT')
        this.checkPreheat(preheat ?? this.preheatStatus());
    } else if (this.phase === 'READY') {
      this.promptCharge(false);
      this.checkCharge(s, CHARGE.fall);
    } else if (this.phase === 'ROASTING') this.checkRoast(s, ror);
    else if (this.phase === 'SHUTDOWN') this.checkShutdown(s);
    else if (this.phase === 'OFF') this.checkOff();
    if (this.batch?.drop) this.checkAfterDrop(s);
    if (this.log.length % 20 === 0) this.emit('persist');
  }

  onStuck({control, want, got}) {
    const text = `${NAMES[control]} isn't responding: wants ${want}, reads ${got ?? 'nothing'}.`;
    this.alert(this.phase === 'ROASTING' ? 'urgent' : 'warn', text);
  }

  onDisconnected() {
    const urgent = this.phase === 'ROASTING' || !!this.batch?.drop;
    this.alert(
      urgent ? 'urgent' : 'warn',
      'Roaster disconnected. Reconnecting.',
    );
    // Nobody knows what the drum did while we were gone (a power cut cools
    // it), so "ready" has to be proven again from fresh readings.
    if (this.phase === 'PREHEAT' || this.phase === 'READY') {
      this.recent = [];
      if (this.phase === 'READY') this.setPhase('PREHEAT');
    }
  }

  onBlind(blind) {
    if (blind)
      this.alert(
        'urgent',
        'No temperature readings from the roaster. Heater off until they come back.',
      );
    else this.alert('warn', 'Temperature readings are back.');
  }

  // ---- phase logic

  // How preheat stands (procedure.js: preheatProgress), plus anything else
  // it's waiting for. The UI shows this as is.
  preheatStatus() {
    const p = preheatProgress(
      this.recent,
      this.preheat.sv,
      this.preheat.stable,
    );
    const waitingFor = !this.machine.settled()
      ? 'the roaster to confirm its settings'
      : this.batch?.drop && !this.batch.beansOut
        ? 'the beans to come out'
        : null;
    return {...p, waitingFor, ready: p.ready && !waitingFor};
  }

  checkPreheat(status) {
    if (!status.ready) return;
    this.setPhase('READY');
    this.promptCharge(true);
  }

  promptCharge(force) {
    const now = this.clock.now();
    if (!force && now - (this.alarms.ready ?? 0) < READY_REPEAT_MS) return;
    this.alarms.ready = now;
    this.say(this.next ? 'Ready for charge.' : 'Ready. Choose the next beans.');
  }

  // Beans going in show up as a sudden BT drop from the steady preheat
  // temperature (see chargePoint).
  checkCharge(s, fall) {
    const at = this.chargePoint(s, fall);
    if (!at) return;
    if (this.next) return this.startRoast(at);
    // Beans went in before any were chosen. Don't guess what they are, but
    // say so loudly: choosing now (while the fall is fresh) still starts it.
    if (!this.alarms.unchosenCharge) {
      this.alarms.unchosenCharge = true;
      this.alert(
        'urgent',
        'That looked like a charge, but no beans are chosen. Choose them now to start the roast.',
      );
    }
  }

  // The reading just before a sudden BT fall of `fall` °C from the steady
  // temperature, if one is under way: the roast clock is backdated to it.
  chargePoint(s, fall) {
    const [from, to] = CHARGE.baselineMs;
    const base = this.recent.filter(
      (x) => s.t - x.t <= from && s.t - x.t >= to,
    );
    if (base.length < 3) return;
    const baseBT = base.reduce((a, x) => a + x.BT, 0) / base.length;
    const falling = this.recent.slice(-CHARGE.confirm);
    if (falling.length < CHARGE.confirm) return;
    if (!falling.every((x) => x.BT <= baseBT - fall)) return;
    let i = this.recent.length - 1;
    while (i > 0 && this.recent[i - 1].BT < baseBT - 1) i--;
    // Charge at the last reading before the fall, as if CHARGE had been
    // pressed as the beans went in (that's what Artisan would record).
    const at = this.recent[Math.max(0, i - 1)];
    return {t: at.t, BT: at.BT};
  }

  startRoast(charge) {
    const {bean, variant, weightIn, proc} = this.next;
    this.next = null;
    const number = this.nextRoastNumber();
    this.batch = {
      number,
      bean,
      variant,
      proc,
      weightIn,
      weightOut: null,
      samples: this.log, // from the end of the last batch through this one
      charge,
      tp: null,
      fc: null,
      sc: null,
      drop: null,
      beansOut: null,
      steps: [],
      overrides: [],
      alerts: [],
    };
    this.tracker = new RoastTracker(proc);
    this.planned = {
      HP: proc.charge.burner,
      FC: proc.charge.air ?? this.preheat.air,
    };
    this.overrides = {};
    this.alarms = {};
    this.setPhase('ROASTING');
    this.machine.event(1);
    this.say('Charge.');
    this.emit('charge', this.batch, this.batch.charge);
    // Catch up on the samples since the (backdated) charge.
    for (const s of this.log.filter((x) => x.t >= charge.t))
      this.handleTracker(s);
  }

  checkRoast(s, ror) {
    this.handleTracker(s);
    if (this.phase !== 'ROASTING') return; // dropped
    const b = this.batch;
    const now = s.t;
    // Heads-up before the drop, from the current rate of rise.
    if (!this.alarms.dropWarned && b.tp && ror > 0.5) {
      const secs = ((b.proc.drop.bt - s.BT) / ror) * 60;
      if (secs <= DROP_WARNING_S) {
        this.alarms.dropWarned = true;
        this.say('About thirty seconds to drop.');
      }
    }
    // Cooling fan on just before the drop, so it's already running when the
    // beans come out.
    if (!this.cooling && b.tp && s.BT >= b.proc.drop.bt - COOL_BEFORE_DROP_C) {
      this.cooling = true;
      this.apply();
      this.emit('persist');
    }
    // A stall gets flagged but never "fixed": the procedure decides heat.
    if (b.tp && now - b.tp.t > STALL.windowMs) {
      const r = rateOfRise(this.recent, STALL.windowMs);
      if (r != null && r < STALL.belowCPerMin) {
        if (now - (this.alarms.stall ?? -Infinity) >= STALL.repeatMs) {
          this.alarms.stall = now;
          this.alert(
            'urgent',
            `BT has stalled at ${s.BT.toFixed(0)}. Hold, or drop if it doesn't recover.`,
          );
        }
      }
    }
    if (!this.alarms.long && now - b.charge.t > LONG_ROAST_MS) {
      this.alarms.long = true;
      this.alert(
        'urgent',
        `This roast has run ${LONG_ROAST_MS / 60_000} minutes. Check it.`,
      );
    }
  }

  handleTracker(s) {
    for (const e of this.tracker.feed(s)) {
      if (e.type === 'tp') {
        this.batch.tp = {t: e.t, BT: e.BT};
        this.emit('tp', this.batch, this.batch.tp);
      } else if (e.type === 'step') this.applyStep(e.index, e.step, s);
      else if (e.type === 'drop') this.drop('temperature');
    }
  }

  applyStep(index, step, s) {
    if (step.burner != null) this.planned.HP = step.burner;
    if (step.air != null) this.planned.FC = step.air;
    const overridden = [];
    if (step.burner != null && 'HP' in this.overrides)
      overridden.push('burner');
    if (step.air != null && 'FC' in this.overrides) overridden.push('air');
    const entry = {index, t: s.t, BT: s.BT, ...step, overridden};
    this.batch.steps.push(entry);
    this.apply();
    this.chime('step');
    this.emit('step', this.batch, entry);
    this.emit('persist');
  }

  drop(reason) {
    const b = this.batch;
    if (b.drop) return;
    b.drop = {...this.mark(), reason};
    this.tracker.dropped = true;
    // Burner to 0 while still in manual mode, then back to preheating, with
    // the heater off until the beans are out (see desiredState).
    this.machine.set({HP: 0});
    this.machine.event(8);
    this.cooling = true;
    this.overrides = {};
    this.say('Drop now!', {urgent: true});
    this.alarms.drop = this.clock.now();
    if (this.doneRequested) this.shutdown();
    else this.setPhase('PREHEAT');
    this.emit('drop', b, b.drop);
  }

  // Closes a roast the app was down for too long (see RESUME_ROAST_WITHIN_MS)
  // where its record stops, then preheats (or shuts down, if asked to). The
  // record closes once the beans are out, like any drop.
  endInterruptedRoast(downMs) {
    const b = this.batch;
    const last = this.log.at(-1) ?? b.charge;
    const at = {t: last.t, BT: last.BT};
    b.drop = {...at, reason: 'interrupted'};
    // Not beansOut: they may still be in the drum, and preheat's heater
    // stays off until the button says otherwise (or a discharge is seen).
    this.tracker.dropped = true;
    this.overrides = {};
    this.cooling = true;
    this.alarms.drop = this.clock.now();
    const mins = Math.max(1, Math.round(downMs / 60_000));
    this.alert(
      'urgent',
      `The app was off for ${mins} minutes mid-roast, so roast #${b.number ?? ''} has ended. Take the beans out if they're still in, then press "Beans are out".`,
    );
    if (this.doneRequested) this.shutdown();
    else this.setPhase('PREHEAT');
    this.emit('drop', b, b.drop);
  }

  // Keep calling for the drop until the beans are out, then finalize the
  // batch record a minute after the drop.
  checkAfterDrop(s) {
    const b = this.batch;
    if (!b.beansOut) {
      const since = this.recent.filter(
        (x) => x.t >= b.drop.t && s.t - x.t <= BEANS_OUT_MS && x.BT != null,
      );
      const peak = Math.max(...since.map((x) => x.BT));
      if (s.BT != null && s.BT <= peak - BEANS_OUT_FALL) this.beansOut();
      else if (s.t - this.alarms.drop >= DROP_REPEAT_MS) {
        this.alarms.drop = s.t;
        this.say('Drop now!', {urgent: true});
      }
    }
    // The record (and with it the drop alarm) stays open until the beans are
    // actually out, however long that takes.
    if (b.beansOut && s.t - b.drop.t >= RECORD_AFTER_DROP_MS)
      this.finishBatch();
  }

  finishBatch() {
    const b = this.batch;
    this.batch = null;
    this.tracker = null;
    this.log = [];
    this.emit('batchComplete', b);
    this.emit('persist');
  }

  shutdown() {
    this.next = null;
    this.doneRequested = false;
    this.setPhase('SHUTDOWN');
    this.say('Shutting down. Cooling the machine.');
  }

  checkShutdown(s) {
    if (s.BT == null || s.BT >= SHUTDOWN.coolBelowC) return;
    if (this.batch) return; // let the last record finish first
    this.cooling = false;
    this.setPhase('OFF');
  }

  // Only announce "off" once the roaster confirms everything is off.
  checkOff() {
    if (this.offAnnounced || !this.machine.settled()) return;
    this.offAnnounced = true;
    this.say('All off.');
    this.emit('off');
  }

  // ---- helpers

  roasting(what) {
    if (this.phase !== 'ROASTING') throw new Error(`can't ${what} now`);
    return this.batch;
  }

  mark() {
    const last = this.recent.at(-1);
    return {t: this.clock.now(), BT: last?.BT ?? null};
  }

  say(text, opts = {}) {
    this.emit('say', text, opts);
  }

  chime(kind) {
    this.emit('chime', kind);
  }

  alert(level, text) {
    this.batch?.alerts.push({...this.mark(), level, text});
    this.emit('alert', {level, text});
    if (level === 'urgent') this.say(text, {urgent: true});
  }

  // ---- saving and resuming (so a crash or restart mid-roast isn't fatal)

  toJSON() {
    const next = this.next && {...this.next, proc: undefined};
    return {
      phase: this.phase,
      next,
      batch: this.batch && {...this.batch, samples: undefined}, // = log
      tracker: this.tracker?.toJSON() ?? null,
      planned: this.planned,
      overrides: this.overrides,
      cooling: this.cooling,
      doneRequested: this.doneRequested,
      log: this.log,
      alarms: this.alarms,
    };
  }

  restore(saved) {
    Object.assign(this, {
      // The heater was off while we were gone, so "ready" has to be proven
      // again: charging a drum that cooled off would ruin the batch.
      phase: saved.phase === 'READY' ? 'PREHEAT' : saved.phase,
      planned: saved.planned,
      overrides: saved.overrides,
      cooling: saved.cooling,
      doneRequested: saved.doneRequested,
      alarms: saved.alarms ?? {},
      log: saved.log,
      batch: saved.batch,
    });
    if (this.batch) {
      this.batch.samples = this.log;
      this.tracker = new RoastTracker(this.batch.proc, {}, saved.tracker);
    }
    if (saved.next) {
      const {bean, variant, weightIn} = saved.next;
      const proc = this.loadProcedure(bean, variant);
      this.next = {bean, variant, weightIn, proc};
    }
    // Old samples would make preheat look stable or fake a charge; start the
    // recent window fresh.
    this.recent = [];
  }
}
