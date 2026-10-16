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
// the drop and off COOL_AFTER_OUT_MS after the beans are out.
//
// Events:
//   'phase' (phase)           'sample' (reading + ror, phase, roastMs)
//   'say' (text, {urgent})    speak this
//   'chime' (kind)            soft sound for an automatic change
//   'alert' ({level, text})   show this (urgent ones are also spoken)
//   'step', 'charge', 'tp', 'fc', 'drop', 'beansOut'  (batch, detail)
//   'batchComplete' (batch)   a minute after drop; the record is final
//   'persist'                 state worth saving changed (see toJSON)
//   'off'                     shutdown finished; everything is off

import {EventEmitter} from 'events';
import {RoastTracker, preheatProgress, rateOfRise} from './procedure.js';

export const SHUTDOWN = {air: 100, coolBelowC: 60};
const KEEP_RECENT_MS = 10 * 60_000; // samples kept for stability/RoR checks
const READY_REPEAT_MS = 60_000; // repeat "ready for charge" this often
const DROP_REPEAT_MS = 5_000; // repeat "drop now" until the beans are out
const UNCHOSEN_REPEAT_MS = 30_000; // beans charged with none chosen
// BT falling this much within BEANS_OUT_MS (since the drop) = the drum is
// empty. On the real logs that comes 12-24 s after the drop, the same or
// earlier than "10 °C under the drop temp". It has to be fast: a drum left
// closed cools 10 °C too, slowly (#1, dropped early: ~7 °C/min), and calling
// that "out" would turn the heat on with the beans inside.
const BEANS_OUT_FALL = 10;
const BEANS_OUT_MS = 30_000;
const RECORD_AFTER_DROP_MS = 60_000; // after the drop, once the beans are out
// The door opened mid-roast: BT this far under its peak of the last
// windowMs, on `confirm` readings in a row, after TP. That's how the person
// drops early (there's no button). Between TP and the drop of all 39 real
// roasts with both, BT never fell more than 0.7 °C within 30 s, except
// where the beans came out before Artisan's drop mark (#1, #4); after a real
// discharge it falls 5 °C in 7.5-22.5 s (median about 10).
const DOOR = {fall: 5, windowMs: 30_000, confirm: 2};
const DROP_WARNING_S = 30;
const COOL_BEFORE_DROP_C = 1; // cooling fan on this far below the drop temp
// Cooling fan off this long after the beans are out: the tray has them at
// room temperature well before then, so nobody has to remember to.
const COOL_AFTER_OUT_MS = 4 * 60_000;
// Drop no matter what at this BT. Procedures can't ask for more than
// MAX_DROP_C (procedure.js); this is the backstop for anything that gets past
// that, such as a batch resumed with an older procedure. Second crack starts
// at 202-207 °C on this probe.
export const MAX_BT_C = 218;
// A batch this far off the procedure's batchGrams roasts differently.
const WEIGHT_TOLERANCE = 0.05;
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
  // beanName(slug): what to call the beans out loud (optional)
  constructor({
    machine,
    clock,
    preheat,
    loadProcedure,
    nextRoastNumber,
    beanName,
  }) {
    super();
    Object.assign(this, {machine, clock, preheat, loadProcedure});
    this.nextRoastNumber = nextRoastNumber ?? (() => null);
    this.beanName = beanName ?? ((slug) => slug.replaceAll('_', ' '));
    this.phase = 'NEW';
    this.next = null; // {bean, variant, weightIn, proc}: the batch to charge next
    this.batch = null; // the roast in progress (until a minute after its drop)
    this.pendingCharge = null; // {t, BT}: a charge with no beans chosen
    this.tracker = null;
    this.planned = {}; // procedure's current burner/air during a roast
    this.cooling = false;
    this.coolUntil = null; // when the cooling fan turns itself off
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

  // Weight out or notes edited while the batch is still live (recorder.js).
  // A restart restores the batch from the saved session and rewrites its
  // roast log, so the edit has to be saved there too.
  editBatch(change) {
    change(this.batch);
    this.emit('persist');
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
          HP: this.planned.HP,
          FC: this.planned.FC,
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
    // (A NaN here would be saved as null: the weight lost.)
    if (!(Number(weightIn) > 0)) throw new Error('weight in must be grams');
    weightIn = Number(weightIn);
    const proc = this.loadProcedure(bean, variant);
    this.next = {bean, variant: proc.variant, weightIn, proc};
    this.doneRequested = false;
    // The steps and drop were worked out for one batch size; #41 was 140 g
    // on a 155 g procedure.
    const planned = proc.batchGrams;
    if (planned && Math.abs(weightIn - planned) > planned * WEIGHT_TOLERANCE)
      this.alert(
        'warn',
        `${weightIn} g is not the ${planned} g this procedure was made for, so it will roast faster or slower than its reference.`,
      );
    // The beans are already in: start their roast from when they went in.
    if (this.pendingCharge && this.phase !== 'ROASTING') {
      const next = this.next;
      this.startRoast(this.pendingCharge);
      return next;
    }
    if (this.phase === 'READY') this.promptCharge(true);
    this.emit('persist');
    return this.next;
  }

  // "That wasn't a charge": forget the unexplained fall (see checkCharge).
  dismissCharge() {
    if (!this.pendingCharge) return;
    this.pendingCharge = null;
    // The same fall would otherwise be detected again on the next reading:
    // ignore it until BT stops falling (a 2 °C rise from its lowest).
    this.chargeIgnore = {minBT: Infinity};
    this.alarms.unchosenCharge = null;
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

  // The person drops by opening the door (see doorOpened), so the UI has no
  // button for this; tests and the autopilot use it for an early drop.
  dropNow() {
    this.roasting('drop');
    this.drop('button');
  }

  beansOut() {
    const b = this.batch;
    if (!b?.drop || b.beansOut) return;
    b.beansOut = this.mark();
    this.coolUntil = b.beansOut.t + COOL_AFTER_OUT_MS;
    this.apply(); // preheat may heat now
    this.emit('beansOut', b, b.beansOut);
    this.emit('persist');
  }

  // The cooling fan: on from just before the drop until coolUntil.
  checkCooling(now) {
    if (!this.cooling || this.coolUntil == null || now < this.coolUntil) return;
    this.cooling = false;
    this.coolUntil = null;
    this.apply();
    this.emit('persist');
  }

  // STOP: heater off now, whatever is happening. Mid-roast that's a drop
  // (the beans have to come out) and then the end of the session; the air
  // and drum keep running to cool, as in any shutdown. Between batches it's
  // also how the day ends, so there it's no alarm, just the shutdown.
  emergencyStop() {
    if (this.phase === 'ROASTING') {
      this.doneRequested = true;
      this.drop('emergency stop');
      this.alert(
        'urgent',
        'Stopped: heater off. Air and drum keep running to cool.',
      );
    } else if (this.phase !== 'SHUTDOWN' && this.phase !== 'OFF')
      this.shutdown();
  }

  // Pops the browser's microphone heard ({intensity}); stamped on arrival.
  // Hints only: they're logged and shown, never acted on.
  addPop(intensity) {
    const b = this.batch;
    if (this.phase !== 'ROASTING' || !b) return;
    (b.pops ??= []).push({...this.mark(), intensity});
  }

  // Done for the day, between batches: the autopilot's end (the person
  // presses STOP, which is the same there).
  done() {
    if (this.phase === 'SHUTDOWN' || this.phase === 'OFF') return;
    if (this.phase === 'ROASTING')
      throw new Error("can't end the day mid-roast");
    this.shutdown();
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
    this.checkCooling(s.t);
    // (Counted separately: in OFF the log's length holds steady, and a
    // multiple of 20 would save on every reading.)
    this.samplesSinceSave = (this.samplesSinceSave ?? 0) + 1;
    if (this.samplesSinceSave >= 20) {
      this.samplesSinceSave = 0;
      this.emit('persist');
    }
  }

  onStuck({control, want, got}) {
    const text = `${NAMES[control]} isn't responding: wants ${want}, reads ${got ?? 'nothing'}.`;
    this.alert(this.phase === 'ROASTING' ? 'urgent' : 'warn', text);
  }

  onDisconnected() {
    if (this.machine.stopped) return; // we closed it on the way out
    // All off: unplugging the roaster is how the day ends.
    if (this.phase === 'OFF') return;
    if (this.phase === 'SHUTDOWN')
      this.alert(
        'urgent',
        'Roaster disconnected while it is still cooling down. If you unplugged it, plug it back in: the fans stop without power. Unplug once it says all off.',
      );
    else
      this.alert(
        this.phase === 'ROASTING' || this.batch?.drop ? 'urgent' : 'warn',
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
    if (this.pendingCharge) return; // the beans are in; see checkCharge
    const now = this.clock.now();
    if (!force && now - (this.alarms.ready ?? 0) < READY_REPEAT_MS) return;
    this.alarms.ready = now;
    this.say(
      this.next
        ? `Ready for charge: ${this.describe(this.next)}.`
        : 'Ready. Choose the next beans.',
    );
  }

  // "Honduran MWP Decaf, 140 grams": said at "ready", so a wrong choice is
  // heard before the beans go in.
  describe({bean, variant, weightIn}) {
    return [this.beanName(bean), variant, weightIn && `${weightIn} grams`]
      .filter(Boolean)
      .join(', ');
  }

  // Beans going in show up as a sudden BT drop from the steady preheat
  // temperature (see chargePoint).
  //
  // Beans that went in before any were chosen: don't guess what they are,
  // but keep saying so until they're chosen (which starts the roast from
  // the charge) or the person says it wasn't a charge (dismissCharge).
  // Giving up quietly would leave the beans roasting on the preheat PID
  // while the app kept calling for a charge.
  checkCharge(s, fall) {
    if (this.pendingCharge) return this.remindUnchosen(s.t);
    if (this.chargeIgnore) {
      const ig = this.chargeIgnore;
      ig.minBT = Math.min(ig.minBT, s.BT);
      if (s.BT < ig.minBT + 2) return;
      this.chargeIgnore = null;
    }
    const at = this.chargePoint(s, fall);
    if (!at) return;
    if (this.next) return this.startRoast(at);
    this.pendingCharge = at;
    this.alarms.unchosenCharge = s.t;
    this.alert(
      'urgent',
      'That looked like a charge, but no beans are chosen. Choose them now to start the roast.',
    );
    this.emit('persist');
  }

  remindUnchosen(now) {
    if (now - this.alarms.unchosenCharge < UNCHOSEN_REPEAT_MS) return;
    this.alarms.unchosenCharge = now;
    this.say(
      'Beans are in, but none are chosen. Choose them to start the roast.',
      {urgent: true},
    );
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
    this.pendingCharge = null;
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
      alerts: [],
    };
    this.tracker = new RoastTracker(proc);
    this.planned = {
      HP: proc.charge.burner,
      FC: proc.charge.air ?? this.preheat.air,
    };
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
    if (b.tp) {
      const at = this.doorOpened(s);
      if (at) {
        this.drop('door', at);
        return this.beansOut();
      }
    }
    // The backstop: as many readings as a trigger needs, past any sane drop.
    this.overCount = s.BT >= MAX_BT_C ? (this.overCount ?? 0) + 1 : 0;
    if (this.overCount >= this.tracker.confirm) {
      this.overCount = 0;
      this.alert(
        'urgent',
        `BT is over ${MAX_BT_C} °C, past any planned drop. Dropping now.`,
      );
      return this.drop('over temperature');
    }
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

  // The reading the door opened at (BT's peak just before the fall), if it
  // has: see DOOR.
  doorOpened(s) {
    const since = this.recent.filter(
      (x) =>
        x.BT != null && s.t - x.t <= DOOR.windowMs && x.t >= this.batch.tp.t,
    );
    if (!since.length) return null;
    const peak = since.reduce((a, x) => (x.BT >= a.BT ? x : a));
    const last = this.recent.slice(-DOOR.confirm);
    if (last.length < DOOR.confirm) return null;
    if (!last.every((x) => x.BT != null && x.BT <= peak.BT - DOOR.fall))
      return null;
    return {t: peak.t, BT: peak.BT};
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
    const entry = {index, t: s.t, BT: s.BT, ...step};
    this.batch.steps.push(entry);
    this.apply();
    this.chime('step');
    this.emit('step', this.batch, entry);
    this.emit('persist');
  }

  // at: when it happened, if earlier than now (the door: see doorOpened).
  drop(reason, at = null) {
    const b = this.batch;
    if (b.drop) return;
    b.drop = {...(at ?? this.mark()), reason};
    this.tracker.dropped = true;
    // Burner to 0 while still in manual mode, then back to preheating, with
    // the heater off until the beans are out (see desiredState).
    this.machine.set({HP: 0});
    this.machine.event(8);
    this.cooling = true;
    this.coolUntil = null; // counted from when the beans are out
    // The door: the person dropped them, so there's nothing to call for.
    if (reason === 'door') this.say('Dropped.');
    else this.say('Drop now!', {urgent: true});
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
    this.cooling = true;
    this.coolUntil = null;
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
    this.pendingCharge = null;
    this.doneRequested = false;
    this.setPhase('SHUTDOWN');
    this.say('Shutting down. Cooling the machine.');
  }

  checkShutdown(s) {
    if (s.BT == null || s.BT >= SHUTDOWN.coolBelowC) return;
    if (this.batch) return; // let the last record finish first
    this.cooling = false;
    this.coolUntil = null;
    this.setPhase('OFF');
  }

  // Only announce "off" once the roaster confirms everything is off.
  checkOff() {
    if (this.offAnnounced || !this.machine.settled()) return;
    this.offAnnounced = true;
    this.say('All off. You can unplug the roaster.');
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
      pendingCharge: this.pendingCharge,
      batch: this.batch && {...this.batch, samples: undefined}, // = log
      tracker: this.tracker?.toJSON() ?? null,
      planned: this.planned,
      cooling: this.cooling,
      coolUntil: this.coolUntil,
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
      cooling: saved.cooling,
      coolUntil: saved.coolUntil ?? null,
      doneRequested: saved.doneRequested,
      alarms: saved.alarms ?? {},
      log: saved.log,
      batch: saved.batch,
      pendingCharge: saved.pendingCharge ?? null,
    });
    if (this.batch) {
      this.batch.samples = this.log;
      this.tracker = new RoastTracker(this.batch.proc, {}, saved.tracker);
    }
    if (saved.next) {
      const {bean, variant, weightIn} = saved.next;
      // Procedures get edited between batches. One that no longer loads
      // costs only the choice of beans, not the resume (and the roast).
      try {
        const proc = this.loadProcedure(bean, variant);
        this.next = {bean, variant, weightIn, proc};
      } catch (err) {
        this.alert(
          'warn',
          `Couldn't load the procedure for the next beans (${err.message}). Choose them again.`,
        );
      }
    }
    // Old samples would make preheat look stable or fake a charge; start the
    // recent window fresh.
    this.recent = [];
  }
}
