// Green beans on hand, computed rather than counted: inventory.json records
// what was bought and any recounts, and every real roast in logs/ uses up
// its weight in. Nothing to remember to subtract after a roast.
//
// inventory.json:
//   purchases [{date, bean, grams, supplier, order?, note?}]
//   counts    [{date, bean, grams, note?}]   what was actually there
// `date` is "YYYY-MM-DD" (the start of that day, local time) or a full
// ISO time. A bean's balance starts at its latest count, or else at its
// first purchase: purchases dated after that add, and roasts charged at or
// after it subtract. A purchase dated on or before the latest count is part
// of that count. So give a recount the time it was made if there was a
// roast earlier that day.
//
//   node server/inventory.js    grams left of each bean, and the batches

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {isRoastFile, readRoast} from './roastlog.js';

// For a roast with no weight in (none so far): a typical batch.
export const DEFAULT_BATCH_G = 155;

// "YYYY-MM-DD" is local midnight (Date.parse would make it UTC).
export function when(date) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return d ? new Date(d[1], d[2] - 1, d[3]).getTime() : Date.parse(date);
}

// Bean slug → {grams, since}: grams left, and when its balance starts.
// `roasts` are the real roasts: [{bean, at (ISO charge time), weightIn}].
export function stock(inventory, roasts) {
  const {purchases = [], counts = []} = inventory;
  const beans = new Set([...purchases, ...counts].map((e) => e.bean));
  const out = {};
  for (const bean of beans) {
    const count = counts
      .filter((c) => c.bean === bean)
      .sort((a, b) => when(a.date) - when(b.date))
      .at(-1);
    const bought = purchases.filter((p) => p.bean === bean);
    const since = count
      ? when(count.date)
      : Math.min(...bought.map((p) => when(p.date)));
    let grams = count ? count.grams : 0;
    for (const p of bought)
      if (!count || when(p.date) > since) grams += p.grams;
    for (const r of roasts)
      if (r.bean === bean && Date.parse(r.at) >= since)
        grams -= r.weightIn ?? DEFAULT_BATCH_G;
    out[bean] = {grams, since: new Date(since).toISOString()};
  }
  return out;
}

// The roasts in dir, as stock() wants them. Unreadable logs are skipped.
export function roastsIn(dir) {
  const roasts = [];
  for (const f of fs.readdirSync(dir).filter(isRoastFile)) {
    try {
      const r = readRoast(path.join(dir, f));
      roasts.push({
        bean: r.bean,
        at: r.chargedAt ?? r.startedAt,
        weightIn: r.weightIn,
      });
    } catch {
      // one bad log mustn't stop the rest
    }
  }
  return roasts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const beans = read('beans.json');
  const left = stock(read('inventory.json'), roastsIn(path.join(root, 'logs')));
  for (const [bean, {grams}] of Object.entries(left).sort(
    (a, b) => b[1].grams - a[1].grams,
  ))
    console.log(
      `${String(Math.round(grams)).padStart(5)} g  ` +
        `${(grams / DEFAULT_BATCH_G).toFixed(1).padStart(4)} batches  ` +
        (beans[bean]?.name ?? bean),
    );
}
