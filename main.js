// Kaleido roaster UI. The server (server/main.js) does all the
// roasting; this page shows what's happening, speaks, and sends the person's
// actions back over the WebSocket.

import {createCharts} from './ui/charts.js';
import {say, chime, crack, unlock, busy} from './ui/sound.js';
import {listen, clusters} from './ui/pops.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const f = (v, d = 0) => (v == null ? '–' : Number(v).toFixed(d));

let state = null;
let samples = [];
let procedures = [];
const references = {}; // roast number or file → curve (null while loading)
let ws = null;
let mic = null; // {stop, pops: [ms]} while listening
let micState = 'off'; // off, starting, on, or the error that stopped it
let started = false; // the Start click: sound, and the mic, are allowed
let serverUp = false;
let lostServer = false; // a connection failed or dropped (not just loading)

// ---- server connection

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    serverUp = true;
    clearInterval(lostAlarm);
    lostAlarm = null;
    renderBar();
  };
  ws.onmessage = ({data}) => handle(JSON.parse(data));
  ws.onclose = () => {
    serverUp = false;
    lostServer = true;
    renderBar();
    if (!lostAlarm && sessionActive()) {
      lostSpeech();
      lostAlarm = setInterval(lostSpeech, 15_000);
    }
    setTimeout(connect, 1000);
  };
}

// The app server going away mid-session is silent otherwise: a crash turns
// the heater off on the way out, and its guardian says nothing then, while
// the beans sit in a drum with no heat. This page is the one thing left that
// can make a sound, so it does, until the server is back.
let lostAlarm = null;
const sessionActive = () =>
  ['PREHEAT', 'READY', 'ROASTING', 'SHUTDOWN'].includes(state?.phase);
function lostSpeech() {
  chime('alarm');
  say(
    'The roaster app stopped. The heater should be off. If beans are in the drum, take them out now, then start the app again.',
    true,
  );
}

function act(action, args = {}) {
  if (ws?.readyState !== WebSocket.OPEN)
    return toast("Not connected to the app server, so that didn't happen.");
  ws.send(JSON.stringify({type: 'action', action, args}));
}

// Things that can't be undone (ending a roast, turning everything off) take
// a second click within 3 s, so a stray click can't do them.
const confirming = new Set();
const confirmTimers = {};
function confirmed(key, rerender) {
  clearTimeout(confirmTimers[key]);
  if (confirming.has(key)) {
    confirming.delete(key);
    rerender();
    return true;
  }
  confirming.add(key);
  confirmTimers[key] = setTimeout(() => {
    confirming.delete(key);
    rerender();
  }, 3000);
  rerender();
  return false;
}
const rerenderSide = () => renderSide();

function handle(msg) {
  if (msg.type === 'state') {
    const phase = state?.phase;
    state = msg.state;
    if (state.phase !== phase && ['PREHEAT', 'READY'].includes(state.phase))
      loadProcedures();
    renderAll();
  } else if (msg.type === 'history') {
    samples = withRoR(msg.samples);
    scheduleChart();
  } else if (msg.type === 'sample') {
    samples.push(msg.sample);
    const cutoff = msg.sample.t - 3 * 3600_000;
    while (samples.length && samples[0].t < cutoff) samples.shift();
    renderReadouts(msg.sample);
    renderLive(msg.sample);
    scheduleChart();
  } else if (msg.type === 'say') {
    if (msg.urgent) chime('alarm');
    say(msg.text, msg.urgent);
  } else if (msg.type === 'chime') {
    chime(msg.kind);
  } else if (msg.type === 'simPops') {
    for (const {kind, delayMs} of msg.pops)
      setTimeout(() => crack(kind), delayMs);
  } else if (msg.type === 'error') {
    toast(msg.message);
  }
}

// The history the server sends on connect is raw readings; live ones come
// with their rate of rise. Fill it in the same way (a 30 s slope of BT).
function withRoR(xs) {
  let start = 0;
  return xs.map((s, i) => {
    if (s.ror != null) return s;
    while (s.t - xs[start].t > 30_000) start++;
    const window = xs.slice(start, i + 1).filter((x) => x.BT != null);
    return {...s, ror: slope(window, 'BT')};
  });
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'on';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = ''), 4000);
}

// ---- top bar

const PHASES = {
  IDLE: 'Not started',
  NEW: 'Starting',
  PREHEAT: 'Preheating',
  READY: 'Ready for charge',
  ROASTING: 'Roasting',
  SHUTDOWN: 'Cooling down',
  OFF: 'All off',
};

function renderReadouts(s) {
  $('bt').textContent = s ? `${f(s.BT, 1)}°` : '–';
  $('et').textContent = s ? `${f(s.ET, 1)}°` : '–';
  $('ror').textContent = s?.ror != null ? `${f(s.ror, 1)}°/m` : '–';
  $('burner').textContent = s ? `${f(s.HP)}%` : '–';
  $('air').textContent = s ? `${f(s.FC)}%` : '–';
  const b = state?.batch;
  const end = b?.drop?.t ?? s?.t;
  $('timer').textContent = b?.charge && end ? mmss(end - b.charge.t) : '–';
  // The tab title, for when the page is behind another window.
  document.title = s?.BT != null ? `${f(s.BT)}° ${phaseName()}` : 'Kaleido';
  renderStop();
}

function phaseName() {
  if (!state) return '';
  const b = state.batch;
  if (b?.drop && !b.beansOut) return 'Drop now';
  if (state.pendingCharge) return 'Choose the beans';
  if (state.heatHeld) return 'Heater held off';
  if (state.phase === 'OFF' && !state.offConfirmed) return 'Turning off';
  return PHASES[state.phase] ?? state.phase;
}

// STOP is for when the heater might be on. Once the machine has confirmed
// it's off (and nothing is about to turn it on), there's nothing to stop.
function renderStop() {
  const btn = $('stop');
  const heating = ['PREHEAT', 'READY', 'ROASTING'].includes(state?.phase);
  const off = state && !heating && samples.at(-1)?.HS === 0;
  if (off) {
    confirming.delete('stop');
    btn.classList.remove('confirm');
  }
  btn.disabled = !!off;
  btn.textContent = off
    ? 'Heater off'
    : confirming.has('stop')
      ? 'Click again: heater off'
      : 'STOP';
  btn.classList.toggle('confirm', !off && confirming.has('stop'));
  btn.title = off
    ? 'The roaster reports the heater is off.'
    : 'Heater off now. Air and drum keep running.';
}

function renderBar() {
  const conn = $('conn');
  $('offline').className = !serverUp && lostServer ? 'on' : '';
  $('bar').classList.toggle('stale', !serverUp || !state?.connected);
  if (!serverUp) {
    if (lostServer) document.title = 'Not connected · Kaleido';
    conn.textContent = state ? 'APP SERVER NOT RUNNING' : 'connecting…';
    conn.className = state ? 'label down' : 'label';
    return;
  }
  if (!state) return;
  conn.textContent =
    (state.connected ? 'roaster connected' : 'ROASTER NOT CONNECTED') +
    (state.mode === 'sim' ? ' (simulator)' : '');
  conn.className = state.connected ? 'label' : 'label down';
  $('phaseText').textContent = phaseName();
  const b = state.batch;
  $('alarm').className = b?.drop && !b.beansOut ? 'on' : '';
  $('simBanner').className = state.mode === 'sim' ? 'on' : '';
  renderStop();
}

// ---- side panel

// Only rebuilt when something it shows changes, so typing in it isn't
// interrupted by the readings arriving every 1.5 s. Things do change while
// you type (a step fires mid-roast, an alert comes in), so a rebuild keeps
// what's in the form fields and which one has the cursor.
let sideKey = '';
function renderSide() {
  const s = state;
  if (!s) return;
  const key = JSON.stringify([
    s.phase,
    s.mode,
    s.next,
    s.batch && [s.batch.number, s.batch.fc, s.batch.drop],
    s.batch && [s.batch.beansOut, s.batch.steps.length, s.batch.weightIn],
    s.pendingCharge,
    s.heatHeld,
    s.offConfirmed,
    s.lastBatch,
    s.alerts,
    procedures,
    micState,
    [...confirming],
  ]);
  if (key === sideKey) return;
  sideKey = key;
  const side = $('side');
  const fields = [...side.querySelectorAll('input[id], select[id]')].map(
    (el) => [el.id, el.value],
  );
  const focused = side.contains(document.activeElement)
    ? document.activeElement.id
    : null;
  // While roasting: the roast and its procedure. Between batches: what to
  // roast next (or done for today), its procedure, then the last roast.
  side.innerHTML = [
    statusSection(),
    roastSection(),
    nextSection(),
    stepsSection(),
    weightOutSection(),
    alertsSection(),
    simSection(),
    micSection(),
  ]
    .filter(Boolean)
    .join('');
  syncVariantsIfFresh();
  // Only put back what was really typed or chosen, and only a choice the
  // rebuilt list still has (the bean list may have just loaded).
  const restore = (id, value) => {
    const el = $(id);
    if (!el || value === '') return;
    if (
      el.tagName === 'SELECT' &&
      ![...el.options].some((o) => o.value === value)
    )
      return;
    el.value = value;
  };
  const kept = Object.fromEntries(fields);
  if (kept.bean) {
    restore('bean', kept.bean);
    syncVariants();
  }
  for (const [id, value] of fields) if (id !== 'bean') restore(id, value);
  if (focused) $(focused)?.focus();
}

const section = (title, body, cls = '') =>
  `<section>${title ? `<h2 class="${cls}">${title}</h2>` : ''}${body}</section>`;
const confirmClass = (key) => (confirming.has(key) ? 'confirm' : '');

// Why the heater is off when the phase wants it on (session.js noHeat).
const HELD = {
  overheated:
    'BT went over its limit, so the heater is off for the rest of this session. Press STOP to cool down.',
  drum: "The roaster says the drum isn't turning, so the heater is off until it does.",
  air: "The roaster says the air is off, so the heater is off until it's back.",
};

function statusSection() {
  const {phase, next, pendingCharge} = state;
  const held = state.heatHeld
    ? `<div class="alert urgent"><span class="icon">⚠</span><span>${HELD[state.heatHeld]}</span></div>`
    : '';
  return held + phaseStatus(phase, next, pendingCharge);
}

function phaseStatus(phase, next, pendingCharge) {
  if (pendingCharge && (phase === 'PREHEAT' || phase === 'READY'))
    return section(
      '',
      `<div class="alert urgent"><span class="icon">⚠</span><span>BT dropped like a charge at ${new Date(pendingCharge.t).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}, but no beans are chosen. Choose them below: the roast starts from that moment.</span></div>
       <button data-act="dismissCharge" class="${confirmClass('dismissCharge')}">${confirming.has('dismissCharge') ? 'Click again: it was not a charge' : 'Not a charge'}</button>`,
    );
  if (phase === 'IDLE' || phase === 'OFF')
    return section(
      '',
      `${
        phase !== 'OFF'
          ? ''
          : state.offConfirmed
            ? '<div class="ready">All off. You can unplug the roaster.</div>'
            : '<p class="note">Turning everything off… Don\'t unplug until it says all off.</p>'
      }
       <p class="note">Preheating takes 15–18 minutes from cold, less if the roaster is still warm.</p>
       <button class="big primary" data-act="startSession">Start preheating</button>`,
    );
  if (phase === 'PREHEAT')
    return section(
      'Preheat',
      `<div class="note" id="preheatInfo">Waiting for BT to hold steady…</div>`,
    );
  if (phase === 'READY')
    return section(
      '',
      next
        ? `<div class="ready">Ready for charge: pour in the beans.</div>
           <p class="note">The roast starts by itself when BT drops.</p>`
        : `<div class="ready">Ready. Choose the beans below.</div>`,
    );
  if (phase === 'SHUTDOWN')
    return section(
      'Cooling down',
      `<p class="note">Heater off. Air and drum run until BT is under 60 °C, then everything turns off. Keep the roaster plugged in until it says all off: the fans stop without power.</p>
       <p id="shutdownInfo"></p>`,
    );
  return '';
}

function roastSection() {
  const b = state.batch;
  if (state.phase !== 'ROASTING' || !b) return '';
  const variant = b.variant ? ` (${esc(b.variant)})` : '';
  // The one button: first crack. The drop is automatic, and dropping early
  // (second crack, smoke) is just opening the door, which the app sees.
  return section(
    `#${b.number ?? ''} ${esc(b.beanName)}${variant}, ${f(b.weightIn)} g`,
    `<div class="row" style="flex-direction: column; align-items: stretch">
       ${
         b.fc
           ? `<p class="note">First crack at ${mmss(b.fc.t - b.charge.t)}. <span id="devInfo"></span></p>`
           : '<button class="big" data-act="markFC">First crack</button>'
       }
       <p class="note">The drop is automatic. To drop early, just open the door.</p>
     </div>`,
    'batch',
  );
}

const what = (s) =>
  [s.burner != null && `burner ${s.burner}%`, s.air != null && `air ${s.air}%`]
    .filter(Boolean)
    .join(', ');
const beanName = (slug) =>
  procedures.find((p) => p.bean === slug)?.name ?? slug;

function stepsSection() {
  const b = state.batch;
  const proc = b?.proc ?? state.next?.proc;
  if (!proc) return '';
  const fired = new Map((b?.steps ?? []).map((s) => [s.index, s]));
  const at = (t) => (b?.charge ? mmss(t - b.charge.t) : '');
  let nextShown = false;
  const rows = (proc.steps ?? []).map((s, i) => {
    const done = fired.get(i);
    let cls = done ? 'done' : '';
    if (!done && b && !nextShown) {
      cls = 'next';
      nextShown = true;
    }
    return `<tr class="${cls}"><td>${s.bt}°</td><td>${what(s)}</td><td>${done ? `✓ ${at(done.t)}` : ''}</td></tr>`;
  });
  const dropDone = b?.drop;
  const dropCls = dropDone ? 'done' : b && !nextShown ? 'next' : '';
  const ref = proc.reference
    ? `<p class="note">Dashed line: roast #${proc.reference.roast} (FC ${proc.reference.fc}, drop ${proc.reference.drop}).</p>`
    : '';
  return section(
    b
      ? 'Procedure'
      : `Procedure: ${esc(beanName(state.next.bean))}${proc.variant ? ` (${esc(proc.variant)})` : ''}`,
    `<table class="steps">
       <tr class="${b ? 'done' : ''}"><td>charge</td><td>burner ${proc.charge.burner}%, SV ${proc.charge.sv}</td><td>${b ? '✓ 0:00' : ''}</td></tr>
       ${rows.join('')}
       <tr class="${dropCls}"><td>${proc.drop.bt}°</td><td>drop</td><td id="dropEta">${dropDone ? `✓ ${at(dropDone.t)}` : ''}</td></tr>
     </table>${ref}${proc.notes ? `<p class="note">${esc(proc.notes)}</p>` : ''}`,
  );
}

// Between batches: the next beans. (Mid-roast it's left out: the next beans
// are picked during the preheat after the drop.) The day ends with STOP.
function nextSection() {
  const {phase, next} = state;
  if (phase !== 'PREHEAT' && phase !== 'READY') return '';
  const done = '<p class="note">Done for today? Press STOP.</p>';
  if (next && !nextSection.editing) {
    const planned = procedures.find((p) => p.bean === next.bean)?.batchGrams;
    const off =
      planned && Math.abs(next.weightIn - planned) > planned * 0.05
        ? ` <span class="tag">procedure is for ${planned} g</span>`
        : '';
    return section(
      'Next beans',
      `<div class="row">${esc(beanName(next.bean))}${next.variant ? ` (${esc(next.variant)})` : ''}, ${f(next.weightIn)} g${off}
         <button data-act="editNext">Change</button></div>
       ${done}`,
    );
  }
  // No bean chosen until someone chooses one: a default here is how #41's
  // decaf was roasted on the Colombian Supremo procedure. The server sends
  // only beans in stock, most recently roasted first.
  const options = procedures
    .map((p) => `<option value="${esc(p.bean)}">${esc(p.name)}</option>`)
    .join('');
  return section(
    'Next beans',
    `<div class="row">
       <select id="bean"><option value="">Choose beans…</option>${options}</select>
       <select id="variant"></select>
     </div>
     <div class="row" style="margin-top: 6px">
       <label>Weight in <input id="weightIn" type="number" min="50" max="250" step="0.1"> g</label>
       <button class="primary" data-act="selectBatch">Set</button>
       ${next ? '<button data-act="cancelEdit">Cancel</button>' : ''}
     </div>
     ${next ? '' : done}`,
  );
}

// The batch that just finished: how it went, and its weight out.
function weightOutSection() {
  const last = state.lastBatch;
  if (!last) return '';
  const variant = last.variant ? ` (${esc(last.variant)})` : '';
  const summary = [];
  if (last.drop)
    summary.push(
      `Dropped at ${mmss(last.drop.s * 1000)}, ${f(last.drop.BT, 1)}°`,
    );
  if (last.fc && last.drop) {
    const dev = last.drop.s - last.fc.s;
    summary.push(
      `FC ${mmss(last.fc.s * 1000)}, development ${mmss(dev * 1000)} (${f((dev / last.drop.s) * 100)}%)`,
    );
  }
  let weight;
  if (last.weightOut != null) {
    const loss = last.weightIn
      ? ` (${f(((last.weightIn - last.weightOut) / last.weightIn) * 100, 1)}% loss)`
      : '';
    weight = `<p class="note">${f(last.weightIn)} g → ${f(last.weightOut, 1)} g${loss}</p>`;
  } else
    weight = `<div class="row"><label>Weight out <input id="weightOut-${last.number}" type="number" min="0" step="0.1"> g</label>
       <button class="primary" data-act="saveWeightOut" data-number="${last.number}">Save</button></div>`;
  return section(
    `Last roast: #${last.number} ${esc(last.beanName ?? beanName(last.bean))}${variant}`,
    `${summary.map((x) => `<p class="note" style="margin: 0 0 4px">${x}</p>`).join('')}${weight}`,
  );
}

function alertsSection() {
  if (!state.alerts.length) return '';
  const icon = {urgent: '⚠', warn: '!', info: 'i'};
  // Newest first, with a repeat of the same alert folded into one line.
  const rows = [];
  for (const a of state.alerts.slice().reverse()) {
    const prev = rows.at(-1);
    if (prev && prev.text === a.text && prev.level === a.level) prev.count++;
    else rows.push({...a, count: 1});
  }
  const clock = (t) =>
    new Date(t).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  return section(
    'Alerts',
    rows
      .map(
        (a) =>
          `<div class="alert ${a.level}"><span class="icon">${icon[a.level] ?? 'i'}</span><span>${esc(a.text)}${a.count > 1 ? ` (×${a.count})` : ''}</span><span class="when">${a.t ? clock(a.t) : ''}</span></div>`,
      )
      .join(''),
  );
}

function simSection() {
  if (state.mode !== 'sim') return '';
  return section(
    'Simulator',
    `<div class="row">
       <button data-act="simCharge">Pour beans in</button>
       <button data-act="simDischarge">Open the door</button>
     </div>`,
  );
}

// Crack listening is on whenever a batch could be on the way, from the
// Start click (browsers allow the mic only after one) to the end of the day.
const ACTIVE = ['PREHEAT', 'READY', 'ROASTING'];

function micSection() {
  if (!ACTIVE.includes(state.phase)) return '';
  const text = {
    off: 'Off until you click Start.',
    starting: 'Starting…',
    on: 'Listening. Hints only: you still press First crack. <span id="micInfo"></span>',
  };
  return section(
    'Crack listening',
    `<p class="note">${text[micState] ?? `Off: ${esc(micState)}`}</p>`,
  );
}

async function startMic() {
  if (mic || micState === 'starting') return;
  micState = 'starting';
  const pops = [];
  try {
    const stop = await listen({
      onPop: (intensity) => {
        if (busy()) return; // our own speech or chime, not the beans
        pops.push(Date.now());
        act('pop', {intensity});
        renderHint();
      },
      onLevel: (level) => {
        const el = $('micInfo');
        if (el) el.textContent = `(background ${(level * 1000).toFixed(1)})`;
      },
    });
    mic = {stop, pops};
    micState = 'on';
    // The session may have ended while the mic was starting.
    if (!ACTIVE.includes(state?.phase)) stopMic();
  } catch (err) {
    micState =
      err.name === 'NotAllowedError'
        ? 'the microphone is blocked for this page'
        : err.message;
  }
  renderSide();
}

function stopMic() {
  mic?.stop();
  mic = null;
  micState = 'off';
}

// On for an active session, off otherwise. (A mic that failed to start
// isn't retried until the next session.)
function syncMic() {
  const want = started && ACTIVE.includes(state?.phase);
  if (want && micState === 'off') startMic();
  else if (!want && micState !== 'starting') stopMic();
}

// Fill in the variant list for the chosen bean.
function syncVariants() {
  const bean = $('bean');
  if (!bean) return;
  const p = procedures.find((x) => x.bean === bean.value);
  $('variant').innerHTML = (p?.variants ?? [])
    .map((v) => `<option>${esc(v)}</option>`)
    .join('');
  $('variant').style.display = p?.variants.length ? '' : 'none';
  if (p?.batchGrams && !$('weightIn').value) $('weightIn').value = p.batchGrams;
}

const HANDLERS = {
  startSession: () => act('startSession'),
  markFC: () => act('markFC'),
  simCharge: () => act('simCharge'),
  simDischarge: () => act('simDischarge'),
  editNext: () => {
    nextSection.editing = true;
    loadProcedures();
    sideKey = '';
    renderSide();
    // Start from the current choice, not the first bean in the list.
    const {next} = state;
    if (next) {
      $('bean').value = next.bean;
      syncVariants();
      if (next.variant) $('variant').value = next.variant;
      $('weightIn').value = next.weightIn ?? '';
    }
  },
  cancelEdit: () => {
    nextSection.editing = false;
    sideKey = '';
    renderSide();
  },
  selectBatch: () => {
    if (!$('bean').value) return toast('Choose the beans first.');
    const weightIn = Number($('weightIn').value);
    if (!(weightIn > 0)) return toast('Enter the weight in grams.');
    nextSection.editing = false;
    act('selectBatch', {
      bean: $('bean').value,
      variant: $('variant').value || null,
      weightIn,
    });
  },
  saveWeightOut: (el) => {
    const grams = Number($(`weightOut-${el.dataset.number}`).value);
    if (!(grams > 0)) return toast('Enter the weight in grams.');
    act('setWeightOut', {number: Number(el.dataset.number), grams});
  },
  dismissCharge: () =>
    confirmed('dismissCharge', rerenderSide) && act('dismissCharge'),
};

$('side').addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) HANDLERS[el.dataset.act]?.(el);
});
$('side').addEventListener('change', (e) => {
  if (e.target.id === 'bean') {
    $('weightIn').value = '';
    syncVariants();
  }
});
$('beansOut').onclick = () => act('beansOut');

// STOP takes two clicks within 3 s, so a stray click can't end a roast.
$('stop').onclick = () => {
  if (ws?.readyState !== WebSocket.OPEN)
    return toast(
      "The app server isn't running, so STOP can't reach the roaster. Run node server/stop.js",
    );
  if (confirmed('stop', renderStop)) act('emergencyStop');
};

// ---- live numbers inside the side panel (updated every reading)

function renderLive(s) {
  if (!state) return;
  const b = state.batch;
  const pre = $('preheatInfo');
  if (pre) pre.textContent = preheatText(s);
  const shut = $('shutdownInfo');
  if (shut) {
    const eta = coolingEta(60);
    shut.textContent = `BT ${f(s.BT, 1)}°${eta ? `, about ${mmss(eta)} to go` : ''}`;
  }
  const dev = $('devInfo');
  if (dev && b?.fc) {
    const since = s.t - b.fc.t;
    const total = s.t - b.charge.t;
    dev.textContent = `Development ${mmss(since)} (${f((since / total) * 100)}% of the roast)`;
  }
  const eta = $('dropEta');
  if (eta && b && !b.drop && s.ror > 0.5 && b.tp) {
    const secs = ((b.proc.drop.bt - s.BT) / s.ror) * 60;
    eta.textContent = secs < 900 ? `in ~${mmss(secs * 1000)}` : '';
  }
  renderHint();
}

// How close preheat is to "ready", exactly as the server counts it (the
// reading's `preheat`, from session.js preheatStatus). After a server
// restart its count starts over, and so does this.
function preheatText(s) {
  const p = s.preheat;
  if (!p) return '';
  const {sv, forSeconds, maxEtRiseCPerMin} = state.preheat;
  const forMs = forSeconds * 1000;
  const et =
    p.etRise == null
      ? ''
      : p.etRise > maxEtRiseCPerMin
        ? ` · ET still rising ${f(p.etRise, 2)}°/min, ready at ${maxEtRiseCPerMin} (drum soaking up heat)`
        : ' · ET steady';
  const waiting = p.waitingFor ? ` · waiting for ${p.waitingFor}` : '';
  return `BT ${f(s.BT, 1)}°, steady at ${sv}° for ${mmss(Math.min(p.heldMs, forMs))} of ${mmss(forMs)}${et}${waiting}`;
}

// Roughly how long (ms) until BT cools to target: exponential decay toward
// the room, at the rate of the last minute. Null if it can't tell yet.
function coolingEta(target, ambient = 25) {
  const last = samples.at(-1);
  if (last?.BT == null) return null;
  const rate = slope(
    samples.filter((x) => last.t - x.t <= 60_000 && x.BT != null),
    'BT',
  );
  if (rate == null || rate > -0.2 || last.BT <= target) return null;
  const k = -rate / (last.BT - ambient);
  const ms = (Math.log((last.BT - ambient) / (target - ambient)) / k) * 60_000;
  return ms < 3600_000 ? ms : null;
}

function slope(xs, key) {
  if (xs.length < 3) return null;
  const t0 = xs[0].t;
  const n = xs.length;
  let st = 0,
    sv = 0,
    stt = 0,
    stv = 0;
  for (const x of xs) {
    const t = (x.t - t0) / 60_000;
    st += t;
    sv += x[key];
    stt += t * t;
    stv += t * x[key];
  }
  const d = n * stt - st * st;
  return d ? (n * stv - st * sv) / d : null;
}

function renderHint() {
  const el = $('hint');
  const b = state?.batch;
  const last = samples.at(-1);
  let text = '';
  if (mic && b && !b.drop && last && clusters(mic.pops, Date.now())) {
    if (!b.fc && last.BT > 170)
      text =
        '🔊 Pops: first crack? Press First crack if you hear several close together.';
    else if (b.fc && last.BT > b.fc.BT + 8)
      text = '🔊 Pops: second crack? Open the door if you want them out.';
  }
  el.textContent = text;
  el.className = text ? 'on' : '';
}

// ---- charts

let charts = null;
let chartQueued = false;
function scheduleChart() {
  if (chartQueued) return;
  chartQueued = true;
  requestAnimationFrame(() => {
    chartQueued = false;
    renderChart();
  });
}

function reference(proc) {
  // By file name when the roast number isn't unique (#7, #25).
  const n = proc?.reference?.file ?? proc?.reference?.roast;
  if (n == null) return null;
  if (!(n in references)) {
    references[n] = null;
    fetch(`/api/roast/${encodeURIComponent(n)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((curve) => {
        references[n] = curve;
        scheduleChart();
      });
  }
  return references[n];
}

function renderChart() {
  if (!state || !samples.length) return;
  charts ??= createCharts($('charts'));
  const b = state.batch;
  const last = samples.at(-1);
  const zero = b?.charge ? b.charge.t : last.t; // x = seconds from here
  const x = samples.map((s) => (s.t - zero) / 1000);
  const ref = reference(b?.proc ?? state.next?.proc);
  let range;
  if (b?.charge) {
    const end = Math.max(600, (ref?.drop?.t ?? 0) + 60, x.at(-1) + 60);
    range = [-60, end];
  } else range = [-20 * 60, 0];

  const markers = [];
  const guides = [];
  if (b?.charge) {
    const rel = (m) => (m.t - zero) / 1000;
    markers.push({x: 0, label: 'charge', strong: true});
    if (b.tp) markers.push({x: rel(b.tp), label: `TP ${f(b.tp.BT)}°`});
    for (const s of b.steps)
      markers.push({x: rel(s), label: s.burner != null ? `${s.burner}%` : ''});
    if (b.fc) markers.push({x: rel(b.fc), label: 'FC', strong: true});
    if (b.drop) markers.push({x: rel(b.drop), label: 'drop', strong: true});
    // Just the next step: guides for all of them crowd into each other.
    const firedIdx = new Set(b.steps.map((s) => s.index));
    const next = b.drop
      ? null
      : (b.proc.steps ?? []).find((s, i) => !firedIdx.has(i));
    if (next)
      guides.push({y: next.bt, label: `next: ${what(next)} at ${next.bt}°`});
    if (!b.drop)
      guides.push({
        y: b.proc.drop.bt,
        label: `drop ${b.proc.drop.bt}°`,
        strong: true,
      });
  } else if (state.phase === 'PREHEAT' || state.phase === 'READY')
    guides.push({y: state.preheat.sv, label: `preheat ${state.preheat.sv}°`});
  const pops = (b?.charge && mic ? mic.pops : []).map(
    (t) => (t - Date.now() + last.t - zero) / 1000,
  );

  charts.update(
    {
      x,
      BT: samples.map((s) => s.BT ?? null),
      ET: samples.map((s) => s.ET ?? null),
      // RoR is a 30 s slope, so it means nothing until 30 s past the
      // turning point (before that it still sees the plunge at charge).
      ror: samples.map((s) =>
        b?.charge && s.t >= b.charge.t && s.t < (b.tp?.t ?? Infinity) + 30_000
          ? null
          : (s.ror ?? null),
      ),
      HP: samples.map((s) => s.HP ?? null),
      FC: samples.map((s) => s.FC ?? null),
    },
    ref && {x: ref.t, BT: ref.BT},
    range,
    {markers, guides, pops},
  );
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  charts?.destroy();
  charts = null;
  $('charts').innerHTML = '';
  scheduleChart();
});

// ---- render everything

function renderAll() {
  syncMic();
  renderBar();
  renderSide();
  renderReadouts(samples.at(-1));
  if (samples.length) renderLive(samples.at(-1));
  scheduleChart();
}

// The bean form was just (re)built: fill its variant list.
function syncVariantsIfFresh() {
  const v = $('variant');
  if (v && !v.options.length) syncVariants();
}

// ---- start

// The beans to choose from. Fetched again whenever a batch could be chosen,
// so a procedure added while the page was open shows up.
function loadProcedures() {
  fetch('/api/procedures')
    .then((r) => r.json())
    .then((list) => {
      procedures = list;
      sideKey = '';
      if (state) renderAll();
    })
    .catch(() => {}); // the server's down; the banner says so
}

$('start').querySelector('button').onclick = () => {
  unlock();
  started = true;
  $('start').remove();
  if (state) renderAll();
};
loadProcedures();
connect();
