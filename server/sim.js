// A simulated M1 LITE that speaks the serial protocol, with the thermal model
// from physics.js and the real machine's quirks:
//  - it silently ignores a fraction of commands (dropRate)
//  - HS and CS don't appear in RD replies until they've been set once
//  - HP reads back the PID's burner duty in auto mode
//  - the TS setpoint cuts the burner in manual mode too
// The "machine" outlives connections: close() is a cable pull, and the
// roaster keeps running on its last settings until something reopens it.

import {EventEmitter} from 'events';
import fs from 'fs';
import * as physics from './physics.js';

const params = JSON.parse(
  fs.readFileSync(new URL('./simParams.json', import.meta.url), 'utf8'),
);
const DT = 0.5; // s, integration step

export class SimKaleido extends EventEmitter {
  // ambient: the machine's AT sensor reads ~27 in a typical session.
  constructor({clock, dropRate = 0, ambient = 27, random = Math.random} = {}) {
    super();
    this.clock = clock;
    this.dropRate = dropRate;
    this.random = random;
    this.isOpen = false;
    this.muted = false; // true = stops answering, like a hung USB adapter
    this.faults = {burner: false, ignore: []}; // burner: never lights; ignore: tags it never takes
    this.accepted = []; // commands the machine acted on, for tests
    this.m = {TS: 0, HP: 0, FC: 0, RC: 0, AH: 0, HS: 0, CS: 0};
    this.seen = new Set(); // vars that have been set (HS/CS show up after)
    this.s = physics.initialState(ambient, ambient, params);
    this.ambient = ambient;
    this.pid = {};
    this.duty = 0;
    this.t = clock.now();
  }

  async open() {
    if (this.unplugged) throw new Error('Roaster not found (sim: unplugged)');
    if (this.isOpen) throw new Error('sim: already open');
    // Like the real one: HS and CS go unreported again on every new
    // connection until they're set (seen after a reconnect, 2026-10-04).
    this.seen = new Set();
    this.isOpen = true;
    return this;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.emit('close');
  }

  // Bring the thermal state up to the current time.
  advance() {
    const now = this.clock.now();
    for (; this.t + DT * 1000 <= now; this.t += DT * 1000) {
      this.duty = this.faults.burner
        ? 0
        : physics.burnerDuty(this.m, this.s, this.pid, DT);
      // CS is the cooling tray's fan; it doesn't touch the drum.
      const u = {duty: this.duty, FC: this.m.FC, AT: this.ambient};
      physics.step(this.s, u, params, DT);
    }
  }

  chargeBeans(grams) {
    this.advance();
    physics.charge(this.s, grams, params);
  }

  discharge() {
    this.advance();
    physics.discharge(this.s, params, {FC: this.m.FC, AT: this.ambient});
  }

  reply(vars) {
    if (this.muted) return;
    const body = Object.entries(vars)
      .map(([k, v]) => `,${k}:${v}`)
      .join('');
    const line = `{0${body}}`;
    queueMicrotask(() => this.isOpen && this.emit('line', line));
  }

  write(msg) {
    if (!this.isOpen) throw new Error('sim: port closed');
    const m = /^\{\[(\w+)(?: (.+))?\]\}$/.exec(msg.trim());
    if (!m || this.muted) return;
    const [, tag, val] = m;
    if (tag === 'RD') return this.reply(this.readings());
    if (tag === 'PI') return this.reply({});
    if (tag === 'TU') return this.reply({TU: val});
    if (tag === 'SC' || tag === 'CL') return this.reply({SN: 'SIM'});
    if (tag === 'EV') return this.accept(tag, val);
    if (!(tag in this.m)) return;
    if (this.random() < this.dropRate) return; // silently dropped
    if (this.faults.ignore?.includes(tag)) return; // a control that never takes
    this.advance();
    this.m[tag] = Math.round(parseFloat(val));
    if (tag === 'TS') this.m.TS = Math.min(this.m.TS, 240); // like the real one
    this.seen.add(tag);
    if (tag === 'AH') this.pid = {};
    this.accept(tag, this.m[tag]);
    this.reply({[tag]: tag === 'TS' ? this.m.TS.toFixed(1) : this.m[tag]});
  }

  accept(tag, value) {
    this.accepted.push({tag, value, t: this.clock.now()});
  }

  readings() {
    this.advance();
    const {s, m} = this;
    const r = {
      BT: s.BT.toFixed(1),
      ET: s.ET.toFixed(1),
      AT: this.ambient.toFixed(1),
      TS: m.TS.toFixed(1),
      HP: m.AH && m.HS ? Math.round(this.duty) : m.HP,
      FC: m.FC,
      RC: m.RC,
      AH: m.AH,
    };
    if (this.seen.has('HS')) r.HS = m.HS;
    if (this.seen.has('CS')) r.CS = m.CS;
    return r;
  }
}
