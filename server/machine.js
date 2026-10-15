// Keeps the roaster in the state we want, over a connection that drops
// commands and sometimes drops entirely.
//
// Nobody sends control commands directly. Callers set the desired value of
// each control (machine.set({HP: 45})), and the reconciler resends anything
// the machine hasn't echoed back, every poll, until it matches. It also
// enforces the order the Kaleido needs when switching to manual:
//   TS first (the setpoint caps the burner even in manual mode),
//   then AH 0, and only then HP (in auto mode HP is the PID's, not ours).
//
// With no BT for silenceMs while the roaster still answers, the heater is
// held off (whatever is desired) until readings come back: heat with
// nothing watching the temperature is never safe.
//
// Events: 'connected', 'disconnected', 'sample' (every RD reply, with all the
// current readings), 'stuck' (a control hasn't matched for stuckMs),
// 'blind' (true: no readings, heater held off; false: readings are back),
// 'error'.

import {EventEmitter} from 'events';
import {encode, parse} from './protocol.js';

export const CONTROLS = ['TS', 'HS', 'AH', 'FC', 'RC', 'CS', 'HP'];

// The M1 LITE silently clamps the setpoint: asked for TS 250 it sets and
// echoes 240 (self-test, 2026-10-04). Clamp here, or the reconciler would
// chase a value the machine will never report, and AH 0 (which waits for TS)
// would never be sent.
export const MAX_TS = 240;

const HEAT_OFF = {HS: 0, AH: 0, HP: 0};

export class Machine extends EventEmitter {
  constructor({
    openTransport,
    clock,
    pollMs = 1500,
    writeGapMs = 100, // the M1 drops commands sent back-to-back
    silenceMs = 5000, // no reply for this long = connection is dead
    retryMs = 1000, // wait before reconnecting
    stuckMs = 8000,
  }) {
    super();
    Object.assign(this, {
      openTransport,
      clock,
      pollMs,
      writeGapMs,
      silenceMs,
      retryMs,
      stuckMs,
    });
    this.state = {}; // last values the machine reported
    this.desired = {}; // what we want the controls to be
    this.connected = false;
    this.lastSent = {};
    this.mismatchSince = {};
    this.queue = new Map(); // tag -> value; one pending write per tag
    this.sent = {}; // commands written per tag (resends included)
    this.stopped = false;
    this.blind = false; // no BT readings: heater held off (see target)
    this.awaitingReading = true; // every connection needs its own first BT
  }

  // Merge into the desired state and push the changes out right away.
  set(values) {
    for (let [k, v] of Object.entries(values)) {
      if (!CONTROLS.includes(k)) throw new Error(`unknown control ${k}`);
      // The protocol sends integers; 45.5 would go out as 46 and never match.
      if (v != null) v = Math.round(v);
      if (k === 'TS') v = Math.min(v, MAX_TS);
      if (this.heatLocked && k in HEAT_OFF) v = HEAT_OFF[k];
      if (this.desired[k] !== v) {
        this.desired[k] = v;
        delete this.lastSent[k];
        delete this.mismatchSince[k];
        // A write still waiting in the queue carries the old value; without
        // this, an HS 1 queued before heaterOff() went out after it.
        if (this.queue.has(k)) this.queue.set(k, this.target(k));
      }
    }
    this.reconcile();
  }

  // Heater off for good, for a process on its way out. Whatever sets the
  // desired state afterwards (a step firing, a click in the UI) can't turn
  // the heat back on; without this, a step that fired while main.js waited
  // for the heater-off to be confirmed turned it back on, and the wait then
  // "confirmed" that.
  heaterOff(others = {}) {
    this.heatLocked = true;
    this.heatLockedAt ??= this.clock.now();
    this.set({...HEAT_OFF, ...others});
  }

  // The roaster itself reports the heater off, and every desired control
  // matches, with a heater report received at least one poll after the lock
  // (unrelated replies mustn't make an older HS 0 count as confirmation).
  heaterConfirmedOff() {
    return (
      this.lastHeaterReport >= this.heatLockedAt + this.pollMs &&
      this.state.HS === 0 &&
      this.settled()
    );
  }

  // Event markers shown on the machine's display. Best effort, not reconciled.
  event(code) {
    this.enqueue('EV', code);
  }

  // What we actually drive a control to: the desired value, or off for the
  // heat controls while there are no readings.
  target(k) {
    const want = this.desired[k];
    // A monitor owns no controls: missing BT mustn't turn it into a writer.
    return (this.blind || this.awaitingReading) && k in HEAT_OFF && want != null
      ? HEAT_OFF[k]
      : want;
  }

  matches(k) {
    const want = this.target(k);
    const got = this.state[k];
    if (got == null) return false;
    return k === 'TS' ? Math.abs(got - want) < 0.6 : got === want;
  }

  // True once every desired control (that we're responsible for) matches,
  // or just the given ones.
  settled(keys = CONTROLS) {
    return keys.every(
      (k) => this.target(k) == null || !this.owns(k) || this.matches(k),
    );
  }

  // HP belongs to the machine's PID unless we're in manual mode.
  owns(k) {
    return k !== 'HP' || this.target('AH') === 0;
  }

  reconcile() {
    if (!this.connected) return;
    const now = this.clock.now();
    for (const k of CONTROLS) {
      // Stuck is timed from when we start sending. A control that isn't
      // ours yet (HP in auto mode) or waits its turn (AH for TS, HP for AH)
      // isn't being sent, so its clock is reset: otherwise HP that sat in
      // the PID's hands since a drop alarmed the moment shutdown took it back.
      const waiting =
        this.target(k) == null ||
        !this.owns(k) ||
        this.matches(k) ||
        (k === 'AH' && this.target('TS') != null && !this.matches('TS')) ||
        (k === 'HP' && this.state.AH !== 0);
      if (waiting) {
        delete this.mismatchSince[k];
        continue;
      }
      this.mismatchSince[k] ??= now;
      if (now - this.mismatchSince[k] > this.stuckMs) {
        this.emit('stuck', {
          control: k,
          want: this.target(k),
          got: this.state[k],
        });
        this.mismatchSince[k] = now; // report again after another stuckMs
      }
      if (this.lastSent[k] == null || now - this.lastSent[k] >= this.pollMs) {
        this.lastSent[k] = now;
        this.enqueue(k, this.target(k));
      }
    }
  }

  enqueue(tag, value) {
    // A tag that's already waiting gets the new value but keeps its place.
    // (Moving it to the back starved the RD poll whenever commands arrived
    // faster than the write gap drains them: no readings, ever.)
    this.queue.set(tag, value);
    this.drain();
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.size && this.transport?.isOpen) {
      const [tag, value] = this.queue.entries().next().value;
      this.queue.delete(tag);
      try {
        this.transport.write(encode(tag, value));
        this.sent[tag] = (this.sent[tag] ?? 0) + 1;
      } catch (err) {
        this.emit('error', err);
      }
      await this.clock.sleep(this.writeGapMs);
    }
    this.draining = false;
  }

  onLine(line) {
    const msg = parse(line);
    if (!msg) return;
    this.lastRx = this.clock.now();
    // A BT that isn't a number (a probe fault) is no reading at all.
    if ('BT' in msg.vars && !Number.isFinite(msg.vars.BT)) delete msg.vars.BT;
    Object.assign(this.state, {sid: msg.sid}, msg.vars);
    if ('HS' in msg.vars) this.lastHeaterReport = this.lastRx;
    if ('BT' in msg.vars) {
      this.lastReading = this.lastRx;
      this.awaitingReading = false;
      this.setBlind(false);
      this.emit('sample', {t: this.lastRx, ...this.state});
    }
    this.reconcile();
  }

  setBlind(blind) {
    if (this.blind === blind) return;
    this.blind = blind;
    for (const k in HEAT_OFF) {
      delete this.lastSent[k];
      if (this.queue.has(k)) this.queue.set(k, this.target(k));
    }
    this.emit('blind', blind);
  }

  // Ping until the machine answers, then set Celsius and the start guard
  // (the same handshake Artisan does).
  async handshake() {
    const deadline = this.clock.now() + this.silenceMs * 2;
    while (this.state.sid == null) {
      if (this.clock.now() > deadline) throw new Error('No answer to ping');
      this.transport.write(encode('PI'));
      await this.clock.sleep(1000);
    }
    this.enqueue('TU', 'C');
    this.enqueue('SC', 'AR');
  }

  // Connect, keep the machine in the desired state, and reconnect forever
  // until stop(). After a reconnect the reconciler simply re-applies the
  // desired state, so an unplugged cable mid-roast isn't fatal.
  async run() {
    while (!this.stopped) {
      while (this.clock.now() < (this.silentUntil ?? 0))
        await this.clock.sleep(250);
      try {
        this.transport = await this.openTransport();
        const closed = new Promise((r) => this.transport.once('close', r));
        let isClosed = false;
        closed.then(() => (isClosed = true));
        this.transport.on('line', (l) => this.onLine(l));
        this.transport.on('error', (e) => this.emit('error', e));
        this.lastRx = this.lastReading = this.clock.now();
        await this.handshake();
        this.connected = true;
        this.emit('connected');
        this.reconcile();
        while (!this.stopped && !isClosed) {
          if (this.clock.now() - this.lastRx > this.silenceMs)
            throw new Error('Roaster stopped answering');
          if (this.clock.now() - this.lastReading > this.silenceMs) {
            this.setBlind(true);
            this.reconcile();
          }
          this.enqueue('RD', 'A0');
          await this.clock.sleep(this.pollMs);
        }
      } catch (err) {
        if (!this.stopped) this.emit('error', err);
      }
      this.teardown();
      if (!this.stopped) await this.clock.sleep(this.retryMs);
    }
  }

  // Drops the connection without the usual goodbye (no CL AR) and stays away
  // for ms, the way a crash would. The self-test uses it to see what the
  // roaster does on its own when the computer goes quiet.
  goSilent(ms) {
    this.silentUntil = this.clock.now() + ms;
    this.transport?.close();
  }

  teardown() {
    const t = this.transport;
    this.transport = null;
    this.queue.clear();
    if (t) {
      t.removeAllListeners('line');
      t.removeAllListeners('error');
      t.close();
    }
    // Readings from a dead connection must never be trusted.
    this.state = {};
    this.awaitingReading = true;
    this.lastHeaterReport = undefined;
    this.lastSent = {};
    this.mismatchSince = {};
    if (this.connected) {
      this.connected = false;
      this.emit('disconnected');
    }
  }

  // Ends the safety guard and closes the port. Turning things off first is
  // the session's job (it sets the desired state and waits for settled()).
  async stop() {
    this.stopped = true;
    if (this.transport?.isOpen) {
      this.enqueue('CL', 'AR');
      await this.clock.sleep(this.writeGapMs * 3);
    }
    this.teardown();
  }
}
