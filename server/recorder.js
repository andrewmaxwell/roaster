// Writes each batch to logs/ as one JSON file (roastlog.js): the procedure,
// events, steps, alerts, tasting notes, and every reading. It's
// rewritten every 30 s during a roast and on every event, so a crash still
// leaves a usable log.
//
//   #38_colombian_supremo_espresso_26-10-04_1103.json
//
// Roast numbers continue from the highest # in the directory.
//
// Saving is never allowed to stop a roast. The writes run inside the
// session's own events (charge, step, drop), so an exception here would
// otherwise reach main.js's crash handler, which turns the heater off. A
// failed write is reported as an alert instead, and the next write retries.

import fs from 'fs';
import path from 'path';
import {CHANNELS, readRoast, writeRoast, roastPath} from './roastlog.js';

const WRITE_EVERY_MS = 30_000;
// Dry end, as Artisan has it: the first BT at or above this after the TP.
const DRY_BT = 152;
const pad = (n) => String(n).padStart(2, '0');
const round = (x, d) => (x == null ? x : Math.round(x * 10 ** d) / 10 ** d);

export class Recorder {
  constructor({session, dir, beans = {}}) {
    Object.assign(this, {session, dir, beans});
    this.lastNumber = 0;
    this.lastWrite = 0;
    fs.mkdirSync(dir, {recursive: true});
    const write = (b) => this.write(b);
    session.on('charge', (b) => this.begin(b));
    for (const e of ['tp', 'step', 'fc', 'drop', 'beansOut'])
      session.on(e, write);
    session.on('batchComplete', write);
    session.on('sample', (s) => {
      const b = session.batch;
      if (b?.file && s.t - this.lastWrite >= WRITE_EVERY_MS) this.write(b);
    });
  }

  // The next roast number: one past the highest in the directory (or handed
  // out this session).
  nextRoastNumber() {
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^#(\d+)_/.exec(f);
        if (m) this.lastNumber = Math.max(this.lastNumber, Number(m[1]));
      }
    } catch (err) {
      this.failed(err);
    }
    return ++this.lastNumber;
  }

  begin(b) {
    const d = new Date(b.samples[0]?.t ?? b.charge.t);
    const date = `${String(d.getFullYear()).slice(2)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
    const parts = [`#${b.number}`, b.bean, b.variant, date, time];
    b.file = parts.filter(Boolean).join('_');
    this.write(b);
  }

  write(b) {
    if (!b?.file) return;
    this.lastWrite = b.samples.at(-1)?.t ?? 0;
    try {
      writeRoast(path.join(this.dir, `${b.file}.json`), this.record(b));
      this.failing = false;
    } catch (err) {
      this.failed(err);
    }
  }

  // Say so once per run of failures, not on every retry.
  failed(err) {
    if (this.failing) return;
    this.failing = true;
    console.error(`recorder: ${err.message}`);
    this.session.alert(
      'warn',
      `Couldn't save the roast log (${err.message}). The roast carries on.`,
    );
  }

  beanName(slug) {
    return this.beans[slug]?.name ?? slug;
  }

  // The roast as roastlog.js describes it. Times are seconds since charge,
  // to the millisecond like the readings, so each event sits exactly on (or
  // just after) the reading it came from.
  record(b) {
    const c = b.charge.t;
    const sec = (t) => round((t - c) / 1000, 3);
    const at = (m) => m && {...m, t: sec(m.t)};
    const {proc} = b;
    const S = b.samples;
    const samples = {t: S.map((s) => sec(s.t))};
    for (const k of [...CHANNELS, 'HS', 'CS'])
      samples[k] = S.map((s) => s[k] ?? null);
    let dry = null;
    if (b.tp)
      dry = S.find(
        (s) => s.t >= b.tp.t && (!b.drop || s.t <= b.drop.t) && s.BT >= DRY_BT,
      );
    return {
      roast: b.number,
      bean: b.bean,
      beanName: this.beanName(b.bean),
      variant: b.variant,
      startedAt: new Date(S[0].t).toISOString(),
      chargedAt: new Date(c).toISOString(),
      weightIn: b.weightIn ?? null,
      weightOut: b.weightOut ?? null,
      procedure: {
        version: proc.version,
        charge: proc.charge,
        steps: proc.steps,
        drop: proc.drop,
      },
      charge: {BT: round(b.charge.BT, 1)},
      tp: at(b.tp),
      dry: dry ? {t: sec(dry.t), BT: dry.BT} : null,
      fc: at(b.fc),
      drop: at(b.drop),
      beansOut: at(b.beansOut),
      steps: b.steps.map(at),
      alerts: b.alerts.map(at),
      pops: (b.pops ?? []).map(at),
      notes: b.notes ?? [],
      source: 'app',
      samples,
    };
  }

  // Weight out and tasting notes usually come after the record is closed,
  // so these patch the files (or the live batch, if it's still open).
  // `roast` is a roast number, or the file name when the number is shared
  // (old logs have two #7s and two #25s; see findRoast in roastlog.js).
  setWeightOut(roast, grams) {
    // (JSON would quietly save a NaN as null.)
    if (!(Number(grams) > 0)) throw new Error('weight out must be grams');
    this.update(roast, (b) => {
      // Roasting only loses weight: more out than in is a typo.
      if (b.weightIn && Number(grams) >= b.weightIn)
        throw new Error(`weight out must be under the ${b.weightIn} g in`);
      b.weightOut = Number(grams);
    });
  }

  addNote(roast, text, date = new Date()) {
    const note = {date: date.toISOString().slice(0, 10), text};
    this.update(roast, (b) => (b.notes = [...(b.notes ?? []), note]));
  }

  update(roast, change) {
    const live = this.session.batch;
    if (live?.file && (live.number === roast || live.file === roast)) {
      this.session.editBatch(change);
      return this.write(live);
    }
    const file = roastPath(this.dir, roast);
    const record = readRoast(file);
    change(record);
    writeRoast(file, record);
  }
}
