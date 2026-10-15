// Writes each batch to logs/ as an Artisan .alog plus a .json sidecar with
// everything Artisan has no place for (procedure, step timings, overrides,
// alerts, tasting notes). Files are rewritten every 30 s during a roast and
// on every event, so a crash still leaves a usable log.
//
//   #38_colombian_supremo_espresso_26-10-04_1103.alog
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
import crypto from 'crypto';
import {buildAlog, readAlog, writeAlog, TEMPLATE_PATH} from './alog.js';

const WRITE_EVERY_MS = 30_000;
const pad = (n) => String(n).padStart(2, '0');
const round1 = (x) => (x == null ? x : Math.round(x * 10) / 10);

export class Recorder {
  constructor({session, dir, beans = {}}) {
    Object.assign(this, {session, dir, beans});
    this.template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    this.batchPos = 0;
    this.lastNumber = 0;
    this.lastWrite = 0;
    fs.mkdirSync(dir, {recursive: true});
    const write = (b) => this.write(b);
    session.on('charge', (b) => this.begin(b));
    for (const e of ['tp', 'step', 'fc', 'sc', 'drop', 'beansOut'])
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
    b.uuid = crypto.randomUUID().replace(/-/g, '');
    b.batchPos = ++this.batchPos;
    this.write(b);
  }

  paths(file) {
    const base = path.join(this.dir, file);
    return {alog: `${base}.alog`, json: `${base}.json`};
  }

  write(b) {
    if (!b?.file) return;
    this.lastWrite = b.samples.at(-1)?.t ?? 0;
    try {
      const {alog, json} = this.paths(b.file);
      const alogData = buildAlog(b, {
        beanName: this.beanName(b.bean),
        batchPos: b.batchPos,
        uuid: b.uuid,
        template: this.template,
      });
      writeAlog(alog, alogData);
      writeJSON(json, this.sidecar(b));
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

  // Everything about the roast that isn't in the .alog. Times are seconds
  // since charge.
  sidecar(b) {
    const c = b.charge.t;
    const at = (m) => m && {...m, t: round1((m.t - c) / 1000)};
    const {proc} = b;
    return {
      roast: b.number,
      bean: b.bean,
      beanName: this.beanName(b.bean),
      variant: b.variant,
      alog: `${b.file}.alog`,
      startedAt: new Date(b.samples[0].t).toISOString(),
      chargedAt: new Date(c).toISOString(),
      weightIn: b.weightIn ?? null,
      weightOut: b.weightOut ?? null,
      procedure: {
        version: proc.version,
        charge: proc.charge,
        steps: proc.steps,
        drop: proc.drop,
      },
      charge: {BT: round1(b.charge.BT)},
      tp: at(b.tp),
      fc: at(b.fc),
      sc: at(b.sc),
      drop: at(b.drop),
      beansOut: at(b.beansOut),
      steps: b.steps.map(at),
      overrides: b.overrides.map(at),
      alerts: b.alerts.map(at),
      pops: (b.pops ?? []).map(at),
      notes: b.notes ?? [],
    };
  }

  // Weight out and tasting notes usually come after the record is closed,
  // so these patch the files (or the live batch, if it's still open).
  setWeightOut(number, grams) {
    this.update(number, (b) => (b.weightOut = grams));
  }

  addNote(number, text, date = new Date()) {
    const note = {date: date.toISOString().slice(0, 10), text};
    this.update(number, (b) => (b.notes = [...(b.notes ?? []), note]));
  }

  update(number, change) {
    const live = this.session.batch;
    if (live?.number === number && live.file) {
      change(live);
      return this.write(live);
    }
    const file = fs
      .readdirSync(this.dir)
      .find((f) => f.startsWith(`#${number}_`) && f.endsWith('.alog'));
    if (!file) throw new Error(`no roast #${number} in ${this.dir}`);
    const {alog, json} = this.paths(file.slice(0, -'.alog'.length));
    const d = readAlog(alog);
    // An older Artisan-only roast gets a sidecar now, holding just these, so
    // its notes add up instead of each one replacing the last in the .alog.
    // Any cupping notes already typed into Artisan become the first note.
    const side = fs.existsSync(json)
      ? JSON.parse(fs.readFileSync(json, 'utf8'))
      : {
          roast: number,
          alog: file,
          notes: d.cuppingnotes ? [{date: null, text: d.cuppingnotes}] : [],
        };
    change(side);
    writeJSON(json, side);
    // Mirror into the .alog fields Artisan shows.
    if (side.weightOut != null) {
      d.weight[1] = side.weightOut;
      d.computed.weightout = side.weightOut;
      const wIn = d.weight[0];
      if (wIn)
        d.computed.weight_loss = round1(((wIn - side.weightOut) / wIn) * 100);
    }
    if (side.notes?.length)
      d.cuppingnotes = side.notes.map((n) => n.text).join('\n');
    writeAlog(alog, d);
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}
