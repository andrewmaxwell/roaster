import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {stock, when} from '../server/inventory.js';

const roast = (bean, at, weightIn = 155) => ({bean, at, weightIn});

test('a purchase less the roasts since it is what is left', () => {
  const inv = {
    purchases: [{date: '2026-10-14', bean: 'bali', grams: 454}],
  };
  const left = (roasts) => stock(inv, roasts).bali.grams;
  assert.equal(left([]), 454);
  assert.equal(left([roast('bali', '2026-10-21T15:00:00Z', 150)]), 304);
  // Another bean's roast, and this bean's from before the purchase.
  assert.equal(left([roast('png', '2026-10-21T15:00:00Z')]), 454);
  assert.equal(left([roast('bali', '2026-09-01T15:00:00Z')]), 454);
  // A roast with no weight in counts as a typical batch.
  assert.equal(left([roast('bali', '2026-10-21T15:00:00Z', null)]), 299);
});

test('a recount replaces everything before it', () => {
  const inv = {
    purchases: [
      {date: '2026-09-01', bean: 'sup', grams: 2268},
      {date: '2026-10-25', bean: 'sup', grams: 454},
    ],
    counts: [
      {date: '2026-10-01', bean: 'sup', grams: 900},
      {date: '2026-10-20T13:27:00-05:00', bean: 'sup', grams: 930},
    ],
  };
  const roasts = [
    roast('sup', '2026-10-13T17:19:48Z'), // before the latest count
    roast('sup', '2026-10-20T19:00:00Z'), // after it, the same day
    roast('sup', '2026-10-26T19:00:00Z'),
  ];
  const s = stock(inv, roasts).sup;
  assert.equal(s.grams, 930 + 454 - 2 * 155);
  assert.equal(s.since, '2026-10-20T18:27:00.000Z');
});

test('a bare date is the start of that day here, not in UTC', () => {
  assert.equal(when('2026-10-14'), new Date(2026, 9, 14).getTime());
  assert.equal(when('2026-10-14T08:00:00Z'), Date.parse('2026-10-14T08:00Z'));
});

test('inventory.json is well formed, for beans in beans.json', () => {
  const read = (f) =>
    JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
  const beans = read('beans.json');
  const {purchases, counts} = read('inventory.json');
  for (const e of [...purchases, ...counts]) {
    assert.ok(beans[e.bean], `${e.bean} is in beans.json`);
    assert.ok(Number.isFinite(when(e.date)), `${e.bean}: date ${e.date}`);
    assert.ok(e.grams > 0, `${e.bean}: grams`);
  }
  for (const p of purchases) assert.ok(p.supplier, `${p.bean}: supplier`);
});
