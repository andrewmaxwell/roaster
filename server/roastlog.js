// Roast logs: one JSON file per roast in logs/,
//   #38_colombian_supremo_espresso_26-10-04_2001.json
// holding everything about it: bean, procedure, events, steps, alerts,
// tasting notes, and every reading. Times are seconds since the charge
// (negative before it: the preheat since the previous batch).
//
//   roast, bean, beanName, variant, startedAt, chargedAt (ISO)
//   weightIn, weightOut (g)
//   procedure                     app roasts: version, charge, steps, drop
//   charge {BT}, tp, dry, fc, fcEnd, sc, scEnd, drop, beansOut, cool
//                                 {t, BT} (drop also has a reason, in app
//                                 roasts); missing ones are null or absent
//   steps, overrides, alerts, pops   app roasts
//   notes [{date, text}]          tasting notes
//   source 'app' | 'artisan'      who recorded it; Artisan roasts (#1-#37)
//                                 keep Artisan's own numbers in `artisan`
//   samples {t, BT, ET, HP, FC, RC, TS, AT, AH, HS?, CS?}
//                                 one column per reading, null = none
//
// #1-#37 were recorded by Artisan, #38-#41 by the app as Artisan .alog
// files plus a sidecar; all were converted to this on 2026-10-15 (the
// .alog files and their reader, alog.js, are in git history).

import fs from 'fs';
import path from 'path';

export const CHANNELS = ['BT', 'ET', 'HP', 'FC', 'RC', 'TS', 'AT', 'AH'];

const ROAST_FILE = /^#(\d+)_.*\.json$/;
export const isRoastFile = (f) => ROAST_FILE.test(f);
export const roastNumber = (f) => Number(ROAST_FILE.exec(f)?.[1]);

export const readRoast = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Atomic, so a crash mid-write never leaves half a file. Indented like any
// JSON file, except each sample column stays on one line: a roast is about
// a thousand readings.
export function writeRoast(file, record) {
  const {samples, ...rest} = record;
  let text = JSON.stringify(rest, null, 2);
  if (samples) {
    const cols = Object.entries(samples)
      .map(([k, xs]) => `    ${JSON.stringify(k)}: ${JSON.stringify(xs)}`)
      .join(',\n');
    text = `${text.slice(0, -2)},\n  "samples": {\n${cols}\n  }\n}`;
  }
  fs.writeFileSync(`${file}.tmp`, text + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

// A roast's file name in dir: by number, or by file name (with or without
// .json) when the number isn't unique (old logs have two #7s and two #25s).
// Throws if there's none, or if the number names more than one.
export function findRoast(dir, roast) {
  const files = fs.readdirSync(dir).filter(isRoastFile);
  if (typeof roast === 'string' && !/^\d+$/.test(roast)) {
    const name = roast.endsWith('.json') ? roast : `${roast}.json`;
    if (!files.includes(name)) throw new Error(`no roast ${name} in ${dir}`);
    return name;
  }
  const matches = files.filter((f) => roastNumber(f) === Number(roast));
  if (!matches.length) throw new Error(`no roast #${roast} in ${dir}`);
  if (matches.length > 1)
    throw new Error(
      `roast #${roast} is ambiguous (${matches.join(', ')}): give the file name instead`,
    );
  return matches[0];
}

export const roastPath = (dir, roast) => path.join(dir, findRoast(dir, roast));

// Index of the last reading at or before t (seconds since charge), or null:
// the reading an event was based on.
export function indexAt(ts, t) {
  if (t == null || !ts.length || ts[0] > t) return null;
  let i = ts.length - 1;
  while (ts[i] > t) i--;
  return i;
}
