// Artisan .alog files are a Python literal dict (what Python's repr() prints),
// not JSON: single-quoted strings, True/False/None, and occasionally tuples.

import fs from 'fs';

export function parseAlog(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const expect = (ch) => {
    ws();
    if (text[i] !== ch) throw new Error(`alog: expected ${ch} at ${i}`);
    i++;
  };
  const ESC = {n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"'};

  function str() {
    const q = text[i++];
    let out = '';
    while (text[i] !== q) {
      if (i >= text.length) throw new Error('alog: unterminated string');
      if (text[i] === '\\') {
        const c = text[i + 1];
        if (c === 'x' || c === 'u' || c === 'U') {
          const n = {x: 2, u: 4, U: 8}[c];
          out += String.fromCodePoint(
            parseInt(text.slice(i + 2, i + 2 + n), 16),
          );
          i += 2 + n;
        } else {
          out += ESC[c] ?? c;
          i += 2;
        }
      } else out += text[i++];
    }
    i++;
    return out;
  }

  function seq(close) {
    const out = [];
    for (;;) {
      ws();
      if (text[i] === close) return (i++, out);
      out.push(value());
      ws();
      if (text[i] === ',') i++;
    }
  }

  function value() {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const out = {};
      for (;;) {
        ws();
        if (text[i] === '}') return (i++, out);
        const k = value();
        expect(':');
        out[k] = value();
        ws();
        if (text[i] === ',') i++;
      }
    }
    if (c === '[') return (i++, seq(']'));
    if (c === '(') return (i++, seq(')'));
    if (c === "'" || c === '"') return str();
    for (const [word, v] of [
      ['True', true],
      ['False', false],
      ['None', null],
    ])
      if (text.startsWith(word, i)) return ((i += word.length), v);
    const m = /^-?(\d+\.?\d*(e[-+]?\d+)?|inf|nan)/i.exec(text.slice(i, i + 40));
    if (!m) throw new Error(`alog: unexpected ${JSON.stringify(c)} at ${i}`);
    i += m[0].length;
    return parseFloat(m[0].replace(/inf/i, 'Infinity'));
  }

  return value();
}

export const readAlog = (path) => parseAlog(fs.readFileSync(path, 'utf8'));

// The per-sample channels this machine setup records, by name. Artisan's
// Kaleido device stores burner/drum/air/AH in "extra device" slots whose
// names ({3}, {1}, {0}) refer to the event types Burner/Drum/Air.
export function channels(d) {
  const out = {t: d.timex, ET: d.temp1, BT: d.temp2};
  const names = {
    '{3}': 'HP',
    '{1}': 'RC',
    '{0}': 'FC',
    SV: 'TS',
    AT: 'AT',
    AH: 'AH',
  };
  d.extraname1.forEach((n, k) => (out[names[n] ?? n] = d.extratemp1[k]));
  d.extraname2.forEach((n, k) => (out[names[n] ?? n] = d.extratemp2[k]));
  return out;
}

// ---- writing

// A value as a Python literal, the way Artisan writes .alog files (repr).
export function toPython(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`alog: can't write ${v}`);
    return String(v);
  }
  if (typeof v === 'string')
    return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
  if (Array.isArray(v)) return `[${v.map(toPython).join(', ')}]`;
  return `{${Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${toPython(k)}: ${toPython(x)}`)
    .join(', ')}}`;
}

// Writes atomically, so a crash mid-write never leaves half a file.
export function writeAlog(path, d) {
  fs.writeFileSync(`${path}.tmp`, toPython(d));
  fs.renameSync(`${path}.tmp`, path);
}

// Fields that describe one particular roast (or which Artisan build wrote
// it). Everything else in an Artisan .alog is display and device setup, which
// alogTemplate.json carries over from a real log so ours match it.
const PER_ROAST = [
  ...['timex', 'temp1', 'temp2', 'extratimex', 'extratemp1', 'extratemp2'],
  ...['timeindex', 'specialevents', 'specialeventstype', 'specialeventsvalue'],
  ...['specialeventsStrings', 'computed', 'anno_positions', 'flag_positions'],
  ...['recording_version', 'recording_revision', 'recording_build'],
  ...['version', 'revision', 'build', 'signature', 'hash'],
  ...['artisan_os', 'artisan_os_version', 'artisan_os_arch'],
  ...['title', 'beans', 'weight', 'roastingnotes', 'cuppingnotes'],
  ...['roastdate', 'roastisodate', 'roasttime', 'roastepoch', 'roasttzoffset'],
  ...['roastbatchnr', 'roastbatchprefix', 'roastbatchpos', 'roastUUID'],
  ...['xmin', 'xmax', 'ambientTemp', 'ambient_humidity', 'ambient_pressure'],
];

export function makeTemplate(d) {
  return Object.fromEntries(
    Object.entries(d).filter(([k]) => !PER_ROAST.includes(k)),
  );
}

export const TEMPLATE_PATH = new URL('./alogTemplate.json', import.meta.url);

// node kaleido/server/alog.js --make-template <some Artisan .alog>
if (process.argv[2] === '--make-template') {
  const t = makeTemplate(readAlog(process.argv[3]));
  fs.writeFileSync(TEMPLATE_PATH, JSON.stringify(t, null, 1) + '\n');
  console.log(`wrote ${Object.keys(t).length} fields`);
}

// ---- a batch record (session.js) as an Artisan profile

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const pad = (n) => String(n).padStart(2, '0');
const round = (x, d = 1) => (x == null ? x : Math.round(x * 10 ** d) / 10 ** d);
const or = (x, missing) => (x == null || !Number.isFinite(x) ? missing : x);

// Artisan's event types and how it stores a slider value: 0-100% as 1-11.
const EVENT_TYPES = {FC: 0, RC: 1, HP: 3};
const eventValue = (pct) => pct / 10 + 1;

// Index of the last sample at or before time t (ms), or null: the reading
// an event was based on. (A drop is marked a moment after the reading that
// triggered it; the next reading is 1.5 s later and ~0.5 °C hotter.)
function indexAt(samples, t) {
  if (t == null || !samples.length || samples[0].t > t) return null;
  let i = samples.length - 1;
  while (samples[i].t > t) i--;
  return i;
}

// batch: a session batch record. info: {beanName, batchPos, uuid, template}.
export function buildAlog(batch, {beanName, batchPos, uuid, template}) {
  const S = batch.samples;
  const t0 = S[0].t;
  const timex = S.map((s) => round((s.t - t0) / 1000, 3));
  const col = (k) => S.map((s) => or(s[k], -1)); // Artisan's "no reading" is -1

  // (On the charge write itself there may be no sample after the charge yet.)
  const ci = indexAt(S, batch.charge.t) ?? S.length - 1;
  const at = (mark) => (mark ? indexAt(S, mark.t) : null);
  const tpi = at(batch.tp);
  // Dry end: Artisan's rule, the first BT at/above phases[1] after the TP.
  const dryBT = template.phases?.[1] ?? 150;
  let dri = null;
  if (tpi != null)
    for (let i = tpi; i < S.length && i <= (at(batch.drop) ?? S.length); i++)
      if (S[i].BT >= dryBT) {
        dri = i;
        break;
      }
  const fci = at(batch.fc);
  const sci = at(batch.sc);
  const dpi = at(batch.drop);
  const timeindex = [ci, dri ?? 0, fci ?? 0, 0, sci ?? 0, 0, dpi ?? 0, 0];

  // Control changes as Artisan events. The burner reads back the PID's duty
  // in auto mode, so only burner changes in manual mode count, plus the
  // drop's burner-off (it arrives in the same reading as auto mode).
  const ev = {i: [], type: [], value: [], text: []};
  for (let i = 1; i < S.length; i++)
    for (const k of ['HP', 'FC', 'RC']) {
      const v = S[i][k];
      if (v == null || v === S[i - 1][k]) continue;
      const burnerOffLeavingManual = v === 0 && S[i - 1].AH === 0;
      if (k === 'HP' && S[i].AH !== 0 && !burnerOffLeavingManual) continue;
      ev.i.push(i);
      ev.type.push(EVENT_TYPES[k]);
      ev.value.push(eventValue(v));
      ev.text.push(`Q${v}`);
    }

  // Times relative to charge, as Artisan's computed block has them.
  const rel = (i) => (i == null ? undefined : round(timex[i] - timex[ci]));
  const point = (name, i) =>
    i == null
      ? {}
      : {
          [`${name}_time`]: rel(i),
          [`${name}_BT`]: round(S[i].BT),
          [`${name}_ET`]: round(S[i].ET),
        };
  const roastET = S.slice(ci, dpi ?? S.length)
    .map((s) => s.ET)
    .filter((x) => x != null);
  const {weightIn, weightOut} = batch;
  const computed = {
    CHARGE_BT: round(S[ci].BT),
    CHARGE_ET: round(S[ci].ET),
    ...(tpi != null && {TP_idx: tpi, ...point('TP', tpi)}),
    MET: roastET.length ? round(Math.max(...roastET)) : undefined,
    ...point('DRY', dri),
    ...point('FCs', fci),
    ...point('SCs', sci),
    ...point('DROP', dpi),
    totaltime: rel(dpi),
    dryphasetime: rel(dri),
    midphasetime:
      dri != null && fci != null ? round(timex[fci] - timex[dri]) : undefined,
    finishphasetime:
      fci != null && dpi != null ? round(timex[dpi] - timex[fci]) : undefined,
    weightin: weightIn ?? 0,
    weightout: weightOut ?? 0,
    weight_loss:
      weightIn && weightOut
        ? round(((weightIn - weightOut) / weightIn) * 100)
        : undefined,
  };
  for (const k of Object.keys(computed))
    if (computed[k] === undefined) delete computed[k];

  const start = new Date(t0);
  const title = batch.variant ? `${beanName} (${batch.variant})` : beanName;
  return {
    ...template,
    mode: 'C',
    title,
    beans: beanName,
    weight: [weightIn ?? 0, weightOut ?? 0, 'g'],
    roastingnotes:
      `Roasted by the kaleido controller with procedure ` +
      `${batch.bean}${batch.variant ? '/' + batch.variant : ''} v${batch.proc.version}.`,
    cuppingnotes: (batch.notes ?? []).map((n) => n.text).join('\n'),
    roastdate: `${DAYS[start.getDay()]} ${MONTHS[start.getMonth()]} ${start.getDate()} ${start.getFullYear()}`,
    roastisodate: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    roasttime: `${pad(start.getHours())}:${pad(start.getMinutes())}:${pad(start.getSeconds())}`,
    roastepoch: Math.floor(t0 / 1000),
    roasttzoffset: start.getTimezoneOffset() * 60,
    roastbatchnr: batch.number ?? 0,
    roastbatchprefix: '#',
    roastbatchpos: batchPos ?? 1,
    roastUUID: uuid,
    samplinginterval: 1.5,
    timex,
    temp1: col('ET'),
    temp2: col('BT'),
    extratimex: [timex, timex, timex],
    // Matches the template's extra devices: {3}=burner, SV, {1}=drum /
    // {0}=air, AT, AH.
    extratemp1: [col('HP'), col('TS'), col('RC')],
    extratemp2: [col('FC'), col('AT'), col('AH')],
    timeindex,
    specialevents: ev.i,
    specialeventstype: ev.type,
    specialeventsvalue: ev.value,
    specialeventsStrings: ev.text,
    flag_positions: [],
    xmin: round(timex[ci] - 40),
    xmax: round((dpi != null ? timex[dpi] : timex.at(-1)) - timex[ci] + 60),
    computed,
  };
}
