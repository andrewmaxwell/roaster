// Kaleido serial protocol (see Artisan's artisanlib/kaleido.py).
//   to machine:   {[TAG VALUE]}\n   or {[TAG]}\n for a query
//   from machine: {sid,VAR:value,...}\n   (a command's reply echoes one VAR)

export const INT_VARS = new Set([
  'sid',
  'HP',
  'FC',
  'RC',
  'AH',
  'HS',
  'EV',
  'CS',
]);
export const STR_VARS = new Set(['TU', 'SC', 'CL', 'SN']);

// Numbers are sent as integers, as Artisan does (it sends even the TS
// setpoint without decimals). Strings like "A0" or "AR" go as-is.
export function encode(tag, value) {
  if (value == null) return `{[${tag}]}\n`;
  const v = typeof value === 'number' ? String(Math.round(value)) : value;
  return `{[${tag} ${v}]}\n`;
}

// Returns {sid, vars} or null for anything that isn't a machine message.
export function parse(line) {
  line = line.trim();
  if (!line.startsWith('{') || !line.endsWith('}')) return null;
  const [first, ...parts] = line.slice(1, -1).split(',');
  const sid = Math.round(parseFloat(first));
  if (isNaN(sid)) return null;
  const vars = {};
  for (const part of parts) {
    const colon = part.indexOf(':');
    if (colon < 1) continue;
    const key = part.slice(0, colon);
    const raw = part.slice(colon + 1);
    if (STR_VARS.has(key)) vars[key] = raw;
    else {
      const n = parseFloat(raw);
      if (isNaN(n)) vars[key] = raw;
      else vars[key] = INT_VARS.has(key) ? Math.round(n) : n;
    }
  }
  return {sid, vars};
}
