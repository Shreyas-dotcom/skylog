import { createMap } from './map.js';
import { fromFR24CSV, toFR24CSV, SEAT_TYPES, CLASSES, REASONS, flightKey, newId, parseAirline, parseAircraft } from './fr24.js';
import {
  enrich, summarize, firsts, journeys, achievements, healthCheck, byCount, haversine, flightTimes,
  estimateDuration, EARTH_KM, MOON_KM, KM_PER_MI, HAULS, HAUL_RANGES,
} from './stats.js';
import { COUNTRIES } from './airports.js';

// ---------- small helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('skylog.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('skylog.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(v => `var(${v})`);

const state = {
  db: null, all: [], ap: null, issues: [], issueBy: new Map(),
  filter: { year: null, airport: null, airline: null, route: null, aircraft: null, q: '' },
  tab: store.get('tab', 'overview'), units: store.get('units', 'km'), theme: store.get('theme', 'auto'),
  mapMode: store.get('mapMode', 'flat'), colorBy: store.get('colorBy', 'frequency'),
  sort: { key: 'sortTime', dir: -1 }, undo: [], showAll: {}, healthSev: 'all', tripsAll: false,
};

const n0 = n => Math.round(n).toLocaleString();
const dist = km => km == null ? '—' : state.units === 'mi' ? `${n0(km / KM_PER_MI)} mi` : `${n0(km)} km`;
const distNum = km => state.units === 'mi' ? km / KM_PER_MI : km;
const dur = m => m == null ? '—' : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
const durLong = m => { const d = Math.floor(m / 1440), h = Math.round((m % 1440) / 60); return d ? `${d}d ${h}h` : `${h}h`; };
const date = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const fname = f => f.flightNumber || (f.heli ? 'Helicopter' : 'Flight');

// ---------- tooltip & toast
const tipEl = $('#tooltip');
const tooltip = {
  show(ev, html) {
    tipEl.innerHTML = html; tipEl.classList.add('on');
    const r = tipEl.getBoundingClientRect();
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  },
  hide() { tipEl.classList.remove('on'); },
};
document.addEventListener('mousemove', ev => {
  const t = ev.target.closest?.('[data-tip]');
  if (t) tooltip.show(ev, t.dataset.tip);
  else if (!ev.target.closest?.('#map')) tooltip.hide();
});

let toastTimer;
function toast(msg, undoable = false) {
  $('#toast-msg').textContent = msg;
  $('#toast-undo').classList.toggle('hidden', !undoable);
  $('#toast').classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('on'), undoable ? 7000 : 3500);
}
$('#toast-undo').onclick = () => { undo(); $('#toast').classList.remove('on'); };

// ---------- persistence
// The logbook lives in this browser's storage. It can also be mirrored to a JSON file you pick
// once, which survives clearing browser data and restores on any machine.
const DB_KEY = 'skylog.db';
let saveTimer;
const backup = { handle: null, state: 'off' }; // off | on | reconnect
const fsSupported = 'showSaveFilePicker' in window;
function setSave(text, err = false) { const el = $('#save-state'); el.textContent = text; el.classList.toggle('err', err); }
function save() {
  state.db.savedAt = new Date().toISOString();
  try { localStorage.setItem(DB_KEY, JSON.stringify(state.db)); setSave('Saved'); }
  catch { setSave('Not saved: browser storage unavailable. Use Export.', true); }
  clearTimeout(saveTimer);
  if (backup.state === 'on') saveTimer = setTimeout(writeBackup, 400);
}
// Another Skylog window saved: pick up its changes.
addEventListener('storage', e => {
  if (e.key !== DB_KEY || !e.newValue) return;
  try { state.db = JSON.parse(e.newValue); recompute(); } catch { /* ignore partial writes */ }
});

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('skylog', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode), req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const kvGet = k => idb('readonly', s => s.get(k));
const kvSet = (k, v) => idb('readwrite', s => s.put(v, k));

async function writeBackup() {
  try {
    const w = await backup.handle.createWritable();
    await w.write(JSON.stringify(state.db, null, 1)); await w.close();
  } catch { backup.state = 'reconnect'; }
  renderBackup();
}
async function readBackup() {
  const data = JSON.parse(await (await backup.handle.getFile()).text());
  return Array.isArray(data?.flights) ? data : null;
}
async function linkBackup() {
  try {
    const handle = await showSaveFilePicker({ suggestedName: 'skylog-data.json', types: [{ description: 'Skylog data', accept: { 'application/json': ['.json'] } }] });
    Object.assign(backup, { handle, state: 'on' });
    await kvSet('backup', handle); await writeBackup();
    toast(`Every change now also saves to ${handle.name}`);
  } catch (e) { if (e.name !== 'AbortError') toast('Could not set up the backup file'); }
}
async function reconnectBackup() {
  try { if (await backup.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return; }
  catch { backup.state = 'off'; return renderBackup(); }
  backup.state = 'on';
  // Keep whichever copy is newer.
  const file = await readBackup().catch(() => null);
  if (file && (file.savedAt || '') > (state.db.savedAt || '')) {
    state.db = file; localStorage.setItem(DB_KEY, JSON.stringify(file)); recompute();
    toast(`Loaded newer data from ${backup.handle.name}`);
  } else await writeBackup();
  renderBackup();
}
function renderBackup() {
  const b = $('#btn-backup');
  b.classList.toggle('hidden', !fsSupported);
  b.textContent = { off: 'Set up backup file', on: `Backup ✓ ${backup.handle?.name}`, reconnect: 'Reconnect backup file' }[backup.state];
  b.title = backup.state === 'on' ? 'Every change is also written to this file. Click to choose a different file.'
    : backup.state === 'reconnect' ? 'Click to allow Skylog to keep writing to your backup file'
    : 'Mirror your logbook to a JSON file on disk, so it survives clearing browser data';
  b.classList.toggle('warn', backup.state === 'reconnect');
}
$('#btn-backup').onclick = () => backup.state === 'reconnect' ? reconnectBackup() : linkBackup();
function commit(mutate, msg) {
  state.undo.push(JSON.stringify(state.db));
  if (state.undo.length > 30) state.undo.shift();
  mutate(state.db);
  save(); recompute();
  if (msg) toast(msg, true);
}
function undo() {
  const prev = state.undo.pop();
  if (!prev) return toast('Nothing to undo');
  state.db = JSON.parse(prev); save(); recompute(); toast('Undone');
}

// ---------- derived data
function recompute() {
  state.db.dismissed ||= [];
  const e = enrich(state.db);
  state.all = e.flights; state.ap = e.ap;
  const dismissed = new Set(state.db.dismissed);
  state.issues = healthCheck(state.all).map(i => ({ ...i, dismissed: dismissed.has(i.id) }));
  state.issueBy = new Map();
  for (const i of state.issues) if (!i.dismissed) for (const id of i.ids) if (!state.issueBy.has(id)) state.issueBy.set(id, i);
  for (const f of state.all) f.search = [f.date, f.flightNumber, f.from, f.to, f.A.label, f.B.label, f.A.countryName, f.B.countryName,
    f.airline, f.airlineIata, f.aircraft, f.aircraftCode, f.registration, f.note, SEAT_TYPES[f.seatType], CLASSES[f.cls], REASONS[f.reason]].join(' ').toLowerCase();
  fillDatalists();
  refresh();
}

function filtered() {
  const { year, airport, airline, route, aircraft, q } = state.filter;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return state.all.filter(f => (!year || f.year === year) && (!airport || f.from === airport || f.to === airport)
    && (!airline || f.airline === airline) && (!route || f.routeKey === route)
    && (!aircraft || (f.aircraftCode || f.aircraft) === aircraft) && terms.every(t => f.search.includes(t)));
}

let current = { list: [], s: null };
function refresh() {
  const list = filtered(), s = summarize(list);
  current = { list, s };
  renderFilterBar(); renderHud(s); updateMap(s); renderTabs(); renderView();
}

function setFilter(patch) {
  Object.assign(state.filter, patch);
  refresh();
}

// ---------- header, filters, HUD
function renderFilterBar() {
  const years = [...new Set(state.all.map(f => f.year))].sort((a, b) => b - a);
  const cnt = y => state.all.filter(f => f.year === y).length;
  const f = state.filter;
  const pills = [];
  if (f.airport) pills.push(['airport', `Airport: ${f.airport}`]);
  if (f.airline) pills.push(['airline', `Airline: ${f.airline}`]);
  if (f.route) pills.push(['route', `Route: ${f.route.replace('–', ' ⇄ ')}`]);
  if (f.aircraft) pills.push(['aircraft', `Aircraft: ${f.aircraft}`]);
  if (f.q) pills.push(['q', `“${f.q}”`]);
  $('#filterbar').innerHTML = `
    <div class="chips">
      <button class="chip ${!f.year ? 'on' : ''}" data-act="year" data-v="">All time<span class="c">${state.all.length}</span></button>
      ${years.map(y => `<button class="chip ${f.year === y ? 'on' : ''}" data-act="year" data-v="${y}">${y}<span class="c">${cnt(y)}</span></button>`).join('')}
    </div>
    ${pills.map(([k, l]) => `<span class="pill">${esc(l)}<button data-act="unfilter" data-v="${k}" aria-label="Remove filter">✕</button></span>`).join('')}
    ${pills.length > 1 ? `<button class="btn small ghost" data-act="clear-filters">Clear all</button>` : ''}`;
}

function renderHud(s) {
  const scope = state.filter.year || (Object.values(state.filter).some(Boolean) ? 'Filtered' : 'All time');
  $('#hud').innerHTML = [
    [plural(s.count, 'flight').split(' ')[0], `Flights · ${scope}`],
    [n0(distNum(s.km)), `${state.units} · ${(s.km / EARTH_KM).toFixed(1)}× Earth`],
    [durLong(s.minutes), 'In the air'],
    [s.airports.size, 'Airports'],
    [s.countries.size, 'Countries'],
  ].map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
}

// ---------- map
const map = createMap($('#map'), {
  tooltip,
  onRoute: r => setFilter({ route: state.filter.route === r.key ? null : r.key }),
  onAirport: a => setFilter({ airport: state.filter.airport === a.code ? null : a.code }),
});
function updateMap(s) {
  const years = state.all.map(f => f.year);
  const yearRange = years.length ? [Math.min(...years), Math.max(...years)] : [0, 0];
  const routes = byCount(s.routes).filter(r => !r.a.unknown && !r.b.unknown);
  map.update({
    routes, fmtDist: dist,
    airports: byCount(s.airports).filter(a => !a.a.unknown),
    countries: [...s.countries.values()].map(c => c.id).filter(Boolean),
    yearRange,
  });
  const lg = $('#legend');
  if (state.colorBy === 'recency') {
    const [y0, y1] = yearRange;
    lg.innerHTML = `Last flown<div class="ramp" style="background:linear-gradient(90deg,var(--route-old),var(--route-new))"></div><div class="ends"><span>${y0}</span><span>${y1}</span></div>`;
  } else lg.innerHTML = `Line weight = times flown · <span class="muted">click map, then scroll to zoom</span>`;
  document.querySelectorAll('#seg-mode button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === state.mapMode));
  document.querySelectorAll('#seg-color button').forEach(b => b.setAttribute('aria-pressed', b.dataset.color === state.colorBy));
}
$('#seg-mode').onclick = e => { const m = e.target.dataset.mode; if (!m) return; state.mapMode = m; store.set('mapMode', m); map.setMode(m); updateMap(current.s); };
$('#seg-color').onclick = e => { const c = e.target.dataset.color; if (!c) return; state.colorBy = c; store.set('colorBy', c); map.setColorBy(c); updateMap(current.s); };
$('#btn-reset').onclick = () => map.reset();
$('#btn-zin').onclick = () => map.zoomBy(1.5);
$('#btn-zout').onclick = () => map.zoomBy(1 / 1.5);

// Replay
const speeds = [1, 2, 4, 0.5];
let speedIx = 0;
$('#btn-replay').onclick = () => {
  if (map.replaying) return stopReplay();
  const list = current.list.filter(f => f.path).map(f => ({ ...f, a: f.A, b: f.B }));
  if (!list.length) return toast('No mappable flights in this view');
  $('#replay').classList.remove('hidden'); $('#legend').classList.add('hidden');
  $('#btn-replay').textContent = '■ Stop';
  let km = 0, lastI = -1;
  map.replay(list, {
    speed: () => speeds[speedIx],
    onFrame: ({ i, t }) => {
      const f = list[Math.min(i, list.length - 1)];
      if (i !== lastI) { km = list.slice(0, i).reduce((a, x) => a + x.dist, 0); lastI = i; }
      $('#rp-date').textContent = date(f.date);
      $('#rp-leg').innerHTML = `${esc(fname(f))} ${f.from} → ${f.to} · ${Math.min(i + 1, list.length)}/${list.length} · ${n0(distNum(km + f.dist * Math.min(t, 1)))} ${state.units}`;
      $('#rp-bar').style.width = ((i + t) / list.length * 100) + '%';
    },
    onEnd: () => { $('#btn-replay').textContent = '▶ Replay'; setTimeout(stopReplay, 1800); },
  });
};
function stopReplay() {
  map.stopReplay();
  $('#replay').classList.add('hidden'); $('#legend').classList.remove('hidden');
  $('#btn-replay').textContent = '▶ Replay'; $('#rp-pause').textContent = 'Pause';
}
$('#rp-stop').onclick = stopReplay;
$('#rp-pause').onclick = e => { const p = e.target.textContent === 'Pause'; map.pauseReplay(p); e.target.textContent = p ? 'Resume' : 'Pause'; };
$('#rp-speed').onclick = e => { speedIx = (speedIx + 1) % speeds.length; e.target.textContent = speeds[speedIx] + '×'; };

// ---------- tabs
function renderTabs() {
  const open = state.issues.filter(i => !i.dismissed && i.severity !== 'info').length;
  document.querySelectorAll('.tab').forEach(t => {
    t.setAttribute('aria-selected', t.dataset.tab === state.tab);
    if (t.dataset.tab === 'health') t.innerHTML = `Data health${open ? `<span class="badge warn">${open}</span>` : ''}`;
    if (t.dataset.tab === 'flights') t.innerHTML = `Flights<span class="badge">${current.list.length}</span>`;
  });
}
$('#tabs').onclick = e => {
  const t = e.target.closest('.tab'); if (!t) return;
  state.tab = t.dataset.tab; store.set('tab', state.tab); renderTabs(); renderView();
};

function renderView() {
  const { list, s } = current;
  const v = $('#view');
  if (!state.all.length) {
    v.innerHTML = `<div class="empty"><h2>No flights yet</h2><p>Import a myFlightradar24 CSV export or add your first flight.</p>
      <button class="btn primary" data-act="add">+ Add flight</button> <button class="btn" data-act="import">Import</button></div>`;
    return;
  }
  const views = { overview, flights: flightsView, places, fleet, trips, achievements: achievementsView, health };
  v.innerHTML = (views[state.tab] || overview)(list, s);
}

// ---------- chart building blocks (plain HTML)
function colChart(items, { values = items.length <= 14, height = 160 } = {}) {
  const max = Math.max(1, ...items.map(i => i.value));
  const step = niceStep(max), top = Math.ceil(max / step) * step;
  const lines = []; for (let v = step; v <= top; v += step) lines.push(v);
  return `<div class="cols-chart" style="height:${height}px">
    ${lines.map(v => `<div class="gridline" style="bottom:${v / top * (height - 18)}px"></div>`).join('')}
    ${items.map(i => `<div class="col ${i.act ? 'click' : ''} ${i.sel ? 'sel' : ''} ${i.faded ? 'faded' : ''}" data-tip="${esc(i.tip)}" ${i.act || ''}>
      ${values && i.value ? `<span class="val">${i.value}</span>` : ''}
      <div class="bar" style="height:${i.value / top * (height - 18 - (values ? 16 : 0))}px"></div></div>`).join('')}
  </div><div class="cols-axis">${items.map(i => `<span>${i.label}</span>`).join('')}</div>`;
}
function niceStep(max) {
  const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
}
function hbars(items, { limit = 8, key } = {}) {
  const max = Math.max(1, ...items.map(i => i.value));
  const all = key && state.showAll[key];
  const shown = all ? items : items.slice(0, limit);
  return `<div class="hbars">${shown.map(i => `<div class="hbar" ${i.act || ''} data-tip="${esc(i.tip || '')}">
      <div class="lbl">${i.label}</div><div class="track"><div class="fill" style="width:${i.value / max * 100}%"></div></div><div class="n">${i.display ?? i.value}</div></div>`).join('')}</div>
    ${key && items.length > limit ? `<button class="btn small ghost more" data-act="showall" data-v="${key}">${all ? 'Show fewer' : `Show all ${items.length}`}</button>` : ''}`;
}
function split(name, entries) {
  const total = entries.reduce((t, e) => t + e.value, 0) || 1;
  const live = entries.filter(e => e.value);
  return `<div class="split"><div class="name">${name}</div>
    <div class="stack">${live.map((e, i) => `<div style="flex:${e.value};background:${e.color || SERIES[i]}" data-tip="<b>${esc(e.label)}</b> · ${e.value} (${pct(e.value, total)}%)${e.sub ? `<div class='t-sub'>${esc(e.sub)}</div>` : ''}"></div>`).join('')}</div>
    <div class="keys">${live.map((e, i) => `<span><i style="background:${e.color || SERIES[i]}"></i>${esc(e.label)} <b>${pct(e.value, total)}%</b></span>`).join('')}</div></div>`;
}
const codeSplit = (obj, labels) => Object.entries(obj).filter(([k]) => +k && labels[k]).sort((a, b) => +a[0] - +b[0])
  .map(([k, v]) => ({ label: labels[k], value: v }))
  .concat(obj[0] ? [{ label: 'Not set', value: obj[0], color: 'var(--axis)' }] : []);
const tile = (v, k, x = '') => `<div class="card tile"><div class="v">${v}</div><div class="k">${k}</div>${x ? `<div class="x">${x}</div>` : ''}</div>`;
const flightRef = f => `<button class="tag mono" data-act="edit" data-id="${f.id}" data-tip="${esc(`${f.A.label} → ${f.B.label}<div class='t-sub'>${date(f.date)} · ${f.airline || ''}</div>`)}">${esc(fname(f))} ${f.from}→${f.to}</button>`;

// ---------- views
function overview(list, s) {
  if (!list.length) return `<div class="empty">No flights match these filters.</div>`;
  const out = [];
  if (state.filter.year) out.push(yearReview(list, s));
  const topRoute = byCount(s.routes)[0], topAp = byCount(s.airports)[0], topAl = byCount(s.airlines)[0], topAc = byCount(s.aircraft)[0];
  out.push(`<div class="grid g-tiles">
    ${tile(s.count.toLocaleString(), 'Flights', `${(s.count / Math.max(1, new Set(list.map(f => f.year)).size)).toFixed(1)} per year`)}
    ${tile(dist(s.km), 'Distance flown', `${(s.km / EARTH_KM).toFixed(2)}× around Earth · ${pct(s.km, MOON_KM)}% to the Moon`)}
    ${tile(durLong(s.minutes), 'Time in the air', `${(s.minutes / 60).toFixed(0)} hours · avg ${dur(s.minutes / s.count)}`)}
    ${tile(s.airports.size, 'Airports', `${s.countries.size} countries · ${s.continents.size} continents`)}
    ${tile(s.airlines.size, 'Airlines', `${Object.keys(s.alliance).filter(k => k !== 'Unaffiliated').length} alliances`)}
    ${tile(s.aircraft.size, 'Aircraft types', `${s.regs.size} tails logged`)}
    ${tile(s.routes.size, 'Unique routes', `${list.filter(f => f.dateline).length} date-line crossings`)}
    ${tile(`${(s.co2 / 1000).toFixed(1)} t`, 'CO₂ (rough estimate)', 'per-passenger, distance & class based')}
  </div>`);
  const rec = (k, v, d, f) => `<div class="record"><div class="k">${k}</div><div><div class="v">${v}</div><div class="d">${d}</div></div>${f ? '' : ''}</div>`;
  out.push(`<h3 class="section-title">Records</h3><div class="card"><div class="records">
    ${s.longest ? rec('Longest flight', `${fname(s.longest)} ${s.longest.from} → ${s.longest.to}`, `${dist(s.longest.dist)} · ${date(s.longest.date)}`) : ''}
    ${s.longestTime ? rec('Longest in the air', `${dur(s.longestTime.dur)}`, `${fname(s.longestTime)} ${s.longestTime.from} → ${s.longestTime.to} · ${date(s.longestTime.date)}`) : ''}
    ${s.shortest ? rec('Shortest flight', `${fname(s.shortest)} ${s.shortest.from} → ${s.shortest.to}`, `${dist(s.shortest.dist)} · ${date(s.shortest.date)}`) : ''}
    ${s.north ? rec('Farthest north', `${s.north.maxLat.toFixed(1)}°N`, `over the route ${s.north.from} → ${s.north.to}`) : ''}
    ${s.south ? rec('Farthest south', `${Math.abs(s.south.minLat).toFixed(1)}°${s.south.minLat < 0 ? 'S' : 'N'}`, `${s.south.from} → ${s.south.to}`) : ''}
    ${topRoute ? rec('Most-flown route', `${topRoute.a.iata} ⇄ ${topRoute.b.iata}`, `${plural(topRoute.count, 'flight')} · ${topRoute.a.city} – ${topRoute.b.city}`) : ''}
    ${topAp ? rec('Home base', `${topAp.code}`, `${topAp.a.label} · ${plural(topAp.count, 'visit')}`) : ''}
    ${topAl ? rec('Favorite airline', esc(topAl.name), `${plural(topAl.count, 'flight')} · ${dist(topAl.km)}`) : ''}
    ${topAc ? rec('Favorite aircraft', esc(topAc.name), `${plural(topAc.count, 'flight')}`) : ''}
  </div></div>`);

  // Charts
  const allYears = summarize(state.all.filter(f => matchesExceptYear(f))).years;
  const ys = [...allYears.keys()].sort();
  const yr = ys.length ? Array.from({ length: ys.at(-1) - ys[0] + 1 }, (_, i) => ys[0] + i) : [];
  const yearItems = yr.map(y => {
    const d = allYears.get(y) || { count: 0, km: 0, minutes: 0 };
    return { label: `’${String(y).slice(2)}`, value: d.count, sel: state.filter.year === y, faded: state.filter.year && state.filter.year !== y,
      tip: `<b>${y}</b> · ${plural(d.count, 'flight')}<div class='t-sub'>${dist(d.km)} · ${durLong(d.minutes)} in the air</div>`, act: `data-act="year" data-v="${state.filter.year === y ? '' : y}"` };
  });
  out.push(`<h3 class="section-title">When you fly</h3><div class="grid g-2">
    <div class="card"><h3>Flights per year</h3><div class="sub">Click a year to see its review</div>${colChart(yearItems)}</div>
    <div class="card"><h3>Activity</h3><div class="sub">Flights per month, every year</div>${heatmap(state.all.filter(f => matchesExceptYear(f)))}</div>
  </div><div class="grid g-3" style="margin-top:16px">
    <div class="card"><h3>Month</h3><div class="sub">All years combined</div>${colChart(s.months.map((v, i) => ({ label: MONTHS[i][0], value: v, tip: `<b>${MONTHS[i]}</b> · ${plural(v, 'flight')}` })))}</div>
    <div class="card"><h3>Day of week</h3><div class="sub">By departure date</div>${colChart(s.dows.map((v, i) => ({ label: DOWS[i], value: v, tip: `<b>${DOWS[i]}</b> · ${plural(v, 'flight')}` })))}</div>
    <div class="card"><h3>Departure hour</h3><div class="sub">Local time at origin</div>${colChart(s.hours.map((v, i) => ({ label: i % 6 === 0 ? String(i).padStart(2, '0') : '', value: v, tip: `<b>${String(i).padStart(2, '0')}:00–${String(i).padStart(2, '0')}:59</b> · ${plural(v, 'departure')}` })), { values: false })}</div>
  </div>`);
  out.push(`<h3 class="section-title">How you fly</h3><div class="grid g-2">
    <div class="card">
      ${split('Seat', codeSplit(s.seatType, SEAT_TYPES))}
      ${split('Class', codeSplit(s.cls, CLASSES))}
      ${split('Reason', codeSplit(s.reason, REASONS))}
      ${split('Haul', HAULS.map(h => ({ label: h, value: s.haul[h] || 0, sub: HAUL_RANGES[h] })))}
      ${split('Alliance', ['Star Alliance', 'SkyTeam', 'oneworld', 'Unaffiliated'].map((k, i) => ({ label: k, value: s.alliance[k] || 0, color: i === 3 ? 'var(--axis)' : SERIES[i] })))}
    </div>
    <div class="card"><h3>Top routes</h3><div class="sub">Both directions combined</div>
      ${hbars(byCount(s.routes).map(r => ({ label: `<span class="mono">${r.a.iata} ⇄ ${r.b.iata}</span> <span class="muted">${esc(r.a.city)} – ${esc(r.b.city)}</span>`, value: r.count, tip: `${dist(r.km)} each way`, act: `data-act="route" data-v="${r.key}"` })), { limit: 10, key: 'ov-routes' })}
    </div>
  </div>`);
  return out.join('');
}

function matchesExceptYear(f) {
  const y = state.filter.year; state.filter.year = null;
  const ok = filteredOne(f); state.filter.year = y; return ok;
}
function filteredOne(f) {
  const { year, airport, airline, route, aircraft, q } = state.filter;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (!year || f.year === year) && (!airport || f.from === airport || f.to === airport) && (!airline || f.airline === airline)
    && (!route || f.routeKey === route) && (!aircraft || (f.aircraftCode || f.aircraft) === aircraft) && terms.every(t => f.search.includes(t));
}

function heatmap(list) {
  const counts = new Map();
  for (const f of list) counts.set(`${f.year}-${f.month}`, (counts.get(`${f.year}-${f.month}`) || 0) + 1);
  const years = [...new Set(list.map(f => f.year))].sort();
  if (!years.length) return '';
  const all = Array.from({ length: years.at(-1) - years[0] + 1 }, (_, i) => years[0] + i);
  const max = Math.max(1, ...counts.values());
  const step = v => v === 0 ? 0 : Math.min(5, 1 + Math.floor((v - 1) / max * 5));
  return `<div class="heat" style="grid-template-columns:36px repeat(12,1fr)">
    <span></span>${MONTHS.map(m => `<span class="h">${m[0]}</span>`).join('')}
    ${all.map(y => `<span class="y" data-act="year" data-v="${y}">${y}</span>${MONTHS.map((m, i) => {
      const v = counts.get(`${y}-${i}`) || 0;
      return `<span class="c" style="background:var(--seq-${step(v)})" data-tip="<b>${m} ${y}</b> · ${plural(v, 'flight')}"></span>`;
    }).join('')}`).join('')}
  </div><div class="heat-legend">Fewer ${[0, 1, 2, 3, 4, 5].map(i => `<i style="background:var(--seq-${i})"></i>`).join('')} More</div>`;
}

function yearReview(list, s) {
  const y = state.filter.year, fr = firsts(state.all, list);
  const prev = state.all.filter(f => f.year === y - 1), prevKm = prev.reduce((t, f) => t + (f.dist || 0), 0);
  const delta = prev.length ? Math.round((s.km - prevKm) / prevKm * 100) : null;
  const tags = arr => arr.length ? `<div class="tagrow">${arr.slice(0, 18).map(t => `<span class="tag">${esc(t)}</span>`).join('')}${arr.length > 18 ? `<span class="muted">+${arr.length - 18}</span>` : ''}</div>` : '<span class="muted">None</span>';
  const topRoute = byCount(s.routes)[0];
  return `<div class="review">
    <h2>${y} in the air</h2>
    <div class="lede">${plural(s.count, 'flight')} · ${dist(s.km)} · ${durLong(s.minutes)} airborne${delta != null ? ` · <span data-tip="Distance vs ${y - 1}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs ${y - 1}</span>` : ''}</div>
    <div class="cols">
      <div><div class="k">New airports</div>${tags(fr.airports)}</div>
      <div><div class="k">New countries</div>${tags(fr.countries)}</div>
      <div><div class="k">New airlines</div>${tags(fr.airlines)}</div>
      <div><div class="k">New aircraft types</div>${tags(fr.aircraft)}</div>
      <div><div class="k">Most-flown route</div>${topRoute ? `<b>${topRoute.a.iata} ⇄ ${topRoute.b.iata}</b> <span class="muted">×${topRoute.count}</span>` : '—'}</div>
      <div><div class="k">Longest flight</div>${s.longest ? `<b>${esc(fname(s.longest))} ${s.longest.from}→${s.longest.to}</b> <span class="muted">${dist(s.longest.dist)}</span>` : '—'}</div>
    </div></div>`;
}

const COLS = [
  ['sortTime', 'Date'], ['flightNumber', 'Flight'], ['from', 'From'], ['to', 'To'], ['depTime', 'Dep'], ['arrTime', 'Arr'],
  ['dur', 'Duration', 'r'], ['dist', 'Distance', 'r'], ['airline', 'Airline'], ['aircraft', 'Aircraft'], ['registration', 'Reg'],
  ['seat', 'Seat'], ['cls', 'Class'], ['reason', 'Reason'], ['note', 'Note'],
];
function flightsView(list) {
  const { key, dir } = state.sort;
  const rows = [...list].sort((a, b) => {
    const x = a[key] ?? '', y = b[key] ?? '';
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir || (a.sortTime - b.sortTime) * dir;
  });
  const sevColor = { error: 'var(--critical)', warn: 'var(--warning)', info: 'var(--muted)' };
  let lastYear = null;
  const body = rows.map(f => {
    let sep = '';
    if (key === 'sortTime' && f.year !== lastYear) {
      lastYear = f.year;
      const n = rows.filter(r => r.year === f.year);
      sep = `<tr class="year-sep"><td colspan="${COLS.length}">${f.year} · ${plural(n.length, 'flight')} · ${dist(n.reduce((t, r) => t + (r.dist || 0), 0))}</td></tr>`;
    }
    const iss = state.issueBy.get(f.id);
    const seat = [f.seat, SEAT_TYPES[f.seatType]].filter(Boolean).join(' · ');
    return sep + `<tr data-act="edit" data-id="${f.id}" data-route="${f.routeKey}">
      <td class="num">${f.date}${iss ? `<span class="flag-dot" style="background:${sevColor[iss.severity]}" data-tip="${esc(iss.title)}<div class='t-sub'>See Data health</div>"></span>` : ''}</td>
      <td class="mono">${esc(f.flightNumber)}</td>
      <td data-tip="${esc(f.A.label)}"><span class="mono">${f.from}</span> <span class="muted">${esc(f.A.city)}</span></td>
      <td data-tip="${esc(f.B.label)}"><span class="mono">${f.to}</span> <span class="muted">${esc(f.B.city)}</span></td>
      <td class="num">${f.depTime || ''}</td><td class="num">${f.arrTime || ''}</td>
      <td class="r num ${f.durSource !== 'logged' ? 'est' : ''}" ${f.durSource !== 'logged' ? `data-tip="${f.durSource === 'timezones' ? 'Computed from times & time zones' : 'Estimated from distance'}"` : ''}>${f.durSource === 'estimate' ? '~' : ''}${dur(f.dur)}</td>
      <td class="r num">${dist(f.dist)}</td>
      <td>${esc(f.airline)}</td><td data-tip="${esc(f.aircraftCode)}">${esc(f.aircraft)}</td>
      <td class="mono">${esc(f.registration)}</td><td>${esc(seat)}</td><td>${CLASSES[f.cls] || ''}</td><td>${REASONS[f.reason] || ''}</td>
      <td class="muted">${esc(f.note)}</td></tr>`;
  }).join('');
  return `<div class="toolbar"><span class="count">${plural(list.length, 'flight')} · ${dist(list.reduce((t, f) => t + (f.dist || 0), 0))}</span>
    <div class="spacer"></div><span class="muted">Click a row to edit · <kbd>N</kbd> new · <kbd>/</kbd> search</span>
    <button class="btn primary small" data-act="add">+ Add flight</button></div>
    <div class="table-wrap"><table><thead><tr>${COLS.map(([k, l, c]) => `<th class="${c || ''} ${key === k ? 'sorted' + (dir > 0 ? ' asc' : '') : ''}" data-act="sort" data-v="${k}">${l}</th>`).join('')}</tr></thead>
    <tbody>${body || `<tr><td colspan="${COLS.length}" class="empty">No flights match.</td></tr>`}</tbody></table></div>`;
}

function places(list, s) {
  const aps = byCount(s.airports);
  const ctry = [...s.countries.values()].sort((a, b) => b.count - a.count);
  const cont = {}; for (const a of aps) if (a.a.continent) cont[a.a.continent] = (cont[a.a.continent] || 0) + a.count;
  const custom = Object.values(state.db.customAirports || {});
  return `<div class="grid g-2">
    <div class="card"><div class="card-head"><h3>Airports</h3><span class="muted">${aps.length} visited · click to filter</span></div>
      ${hbars(aps.map(a => ({ label: `<span class="mono">${a.code}</span> <span class="muted">${esc(a.a.label)}${a.a.unknown ? ' ⚠' : ''}</span>`, value: a.count,
        tip: `<b>${a.code}</b> · ${esc(a.a.label)}<div class='t-sub'>${a.deps} departures · ${a.arrs} arrivals · first ${a.first}, last ${a.last}</div>`, act: `data-act="airport" data-v="${a.code}"` })), { limit: 15, key: 'aps' })}
    </div>
    <div>
      <div class="card"><div class="card-head"><h3>Countries &amp; territories</h3><span class="muted">${ctry.length} visited</span></div>
        ${hbars(ctry.map(c => ({ label: `${esc(c.name)} <span class="muted">${c.airports.size} airport${c.airports.size > 1 ? 's' : ''}</span>`, value: c.count, tip: `Airports: ${[...c.airports].join(', ')}` })), { limit: 12, key: 'ctry' })}
        <div style="margin-top:16px">${split('Continents (airport visits)', Object.entries(cont).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v })))}</div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h3>Custom airports</h3><button class="btn small" data-act="add-airport">+ Add airport</button></div>
        ${custom.length ? custom.map(a => `<div class="record"><div class="k mono">${esc(a.iata)}</div><div><div class="v">${esc(a.city)} / ${esc(a.name)}</div><div class="d">${a.lat}, ${a.lon} · ${esc(a.tz || 'no time zone')}</div></div><div class="spacer"></div><button class="btn small" data-act="edit-airport" data-v="${esc(a.iata)}">Edit</button></div>`).join('')
        : '<div class="muted">Airports outside the built-in list can be added here, with coordinates and time zone.</div>'}
      </div>
    </div></div>`;
}

function fleet(list, s) {
  const airlines = byCount(s.airlines), aircraft = byCount(s.aircraft);
  const tails = new Map();
  for (const f of list) if (f.registration) {
    if (!tails.has(f.registration)) tails.set(f.registration, { reg: f.registration, count: 0, f, dates: [] });
    const t = tails.get(f.registration); t.count++; t.dates.push(f.date);
  }
  const tl = [...tails.values()].sort((a, b) => b.count - a.count || b.f.sortTime - a.f.sortTime);
  return `<div class="grid g-2">
    <div class="card"><div class="card-head"><h3>Airlines</h3><span class="muted">${airlines.length} flown · click to filter</span></div>
      ${hbars(airlines.map(a => ({ label: `${esc(a.name)} <span class="muted mono">${esc(a.iata)}</span>`, value: a.count, tip: `${dist(a.km)} · first flown ${a.first}`, act: `data-act="airline" data-v="${esc(a.name)}"` })), { limit: 12, key: 'airlines' })}
    </div>
    <div class="card"><div class="card-head"><h3>Aircraft types</h3><span class="muted">${aircraft.length} types</span></div>
      ${hbars(aircraft.map(a => ({ label: `${esc(a.name)} <span class="muted mono">${esc(a.code)}</span>`, value: a.count, tip: `${dist(a.km)}${a.regs.size ? ` · tails: ${[...a.regs].join(', ')}` : ''}`, act: `data-act="aircraft" data-v="${esc(a.code || a.name)}"` })), { limit: 12, key: 'aircraft' })}
    </div>
    <div class="card">
      ${split('Manufacturer', byCount(s.manufacturer).slice(0, 7).map(m => ({ label: m.name, value: m.count })))}
      ${split('Alliance', ['Star Alliance', 'SkyTeam', 'oneworld', 'Unaffiliated'].map((k, i) => ({ label: k, value: s.alliance[k] || 0, color: i === 3 ? 'var(--axis)' : SERIES[i] })))}
      <div style="margin-top:16px">${split('Wide-body vs narrow-body', [
        { label: 'Wide-body', value: list.filter(f => /^(A3[3-5]|A38|B7[4-8]|B77|B78)/.test(f.aircraftCode)).length },
        { label: 'Narrow-body', value: list.filter(f => /^(A2|A3[12]|A19|A20|A21|A22|B7[1-3]|B3|B75|E1|E7|E9|CRJ|C[0-9]|BCS)/.test(f.aircraftCode)).length },
        { label: 'Turboprop & other', value: list.filter(f => f.aircraftCode && !/^(A3[3-5]|A38|B7|B3|A2|A3[12]|A19|A20|A21|A22|E1|E7|E9|CRJ|BCS)/.test(f.aircraftCode)).length },
      ])}</div>
    </div>
    <div class="card"><div class="card-head"><h3>Tail numbers</h3><span class="muted">${tl.length} logged · ${pct(list.filter(f => f.registration).length, list.length)}% of flights</span></div>
      ${tl.length ? `<div class="table-wrap" style="max-height:360px"><table><thead><tr><th>Registration</th><th>Type</th><th>Airline</th><th class="r">Flown</th><th>Last</th></tr></thead><tbody>
        ${tl.map(t => `<tr data-act="edit" data-id="${t.f.id}"><td class="mono">${esc(t.reg)}</td><td>${esc(t.f.aircraftCode)}</td><td>${esc(t.f.airline)}</td><td class="r">${t.count > 1 ? `<b>${t.count}×</b>` : '1×'}</td><td class="num">${t.dates.at(-1)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="muted">Add registrations to your flights to track individual aircraft.</div>'}
    </div></div>`;
}

function trips(list, s) {
  const js = journeys(list);
  const multi = js.filter(j => j.legs.length > 1);
  const shown = (state.tripsAll ? js : multi).slice().reverse();
  const longest = [...js].sort((a, b) => b.total - a.total)[0];
  return `<div class="grid g-tiles" style="margin-bottom:16px">
    ${tile(js.length, 'Journeys', 'legs joined when you connect within 24 h')}
    ${tile(multi.length, 'With connections', `${pct(multi.length, js.length)}% of journeys`)}
    ${tile(longest ? durLong(longest.total) : '—', 'Longest door-to-door', longest ? `${longest.legs[0].from} → ${longest.legs.at(-1).to}` : '')}
    ${tile(s.routes.size, 'Unique routes', `${[...s.routes.values()].filter(r => r.count > 1).length} flown more than once`)}
  </div>
  <div class="grid g-2">
    <div class="card"><div class="card-head"><h3>Journeys</h3>
      <button class="btn small" data-act="trips-all">${state.tripsAll ? 'Only connections' : 'Show single legs too'}</button></div>
      ${shown.map(j => {
        const codes = [j.legs[0].from, ...j.legs.map(f => f.to)];
        const detour = j.direct ? j.km / j.direct : null;
        return `<div class="journey" data-act="edit" data-id="${j.legs[0].id}" data-route="${j.legs.map(f => f.routeKey).join(' ')}">
          <div class="num">${j.legs[0].date}</div>
          <div class="legs">${codes.map((c, i) => `<span class="code">${c}</span>${i < codes.length - 1 ? `<span class="arrow" data-tip="${esc(fname(j.legs[i]))} · ${dur(j.legs[i].dur)}">→</span>` : ''}`).join('')}</div>
          <div class="meta">${dist(j.km)} · ${durLong(j.total)} door-to-door${detour && j.legs.length > 1 ? `<br><span class="muted" data-tip="Distance flown vs. a direct flight">${detour.toFixed(2)}× direct</span>` : ''}</div></div>`;
      }).join('') || '<div class="muted">No multi-leg journeys in this view.</div>'}
    </div>
    <div class="card"><div class="card-head"><h3>Routes</h3><span class="muted">click to filter</span></div>
      ${hbars(byCount(s.routes).map(r => ({ label: `<span class="mono">${r.a.iata} ⇄ ${r.b.iata}</span> <span class="muted">${dist(r.km)}</span>`, value: r.count, act: `data-act="route" data-v="${r.key}"`, tip: `${esc(r.a.label)} – ${esc(r.b.label)}` })), { limit: 20, key: 'routes' })}
    </div></div>`;
}

function achievementsView() {
  const s = summarize(state.all), list = achievements(state.all, s);
  const got = list.filter(a => a.got).length;
  return `<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>${got} of ${list.length} unlocked</h3><span class="muted">All-time, regardless of filters</span></div>
    <div class="meter"><i style="width:${pct(got, list.length)}%"></i></div></div>
    <div class="ach-grid">${list.sort((a, b) => b.got - a.got || (b.progress || 0) - (a.progress || 0)).map(a => `<div class="ach ${a.got ? '' : 'locked'}">
      <div class="ic">${a.icon}</div><div style="flex:1"><div class="t">${a.title}</div><div class="d">${a.desc}</div>
      ${a.got ? '<div class="got">✓ Unlocked</div>' : a.progress != null ? `<div class="prog"><i style="width:${a.progress * 100}%"></i></div><div class="d">${Math.round(a.progress * 100)}%</div>` : ''}
      </div></div>`).join('')}</div>`;
}

function health() {
  const all = state.all, n = all.length;
  const fields = [
    ['Departure & arrival times', f => f.depTime && f.arrTime && !(f.depTime === '00:00' && f.arrTime === '00:00')],
    ['Airline', f => f.airline], ['Aircraft type', f => f.aircraft || f.aircraftCode], ['Registration', f => f.registration],
    ['Seat number', f => f.seat], ['Seat type', f => f.seatType], ['Flight reason', f => f.reason],
  ];
  const sevLabel = { error: ['!', 'Error'], warn: ['!', 'Warning'], info: ['i', 'Info'] };
  const visible = state.issues.filter(i => (state.healthSev === 'all' ? !i.dismissed : state.healthSev === 'dismissed' ? i.dismissed : i.severity === state.healthSev && !i.dismissed));
  const count = sev => state.issues.filter(i => i.severity === sev && !i.dismissed).length;
  const byId = new Map(all.map(f => [f.id, f]));
  const fixBtn = i => {
    if (!i.fix) return '';
    if (i.fix.kind === 'airport') return `<button class="btn small primary" data-act="fix-airport" data-v="${i.fix.code}">Add airport</button>`;
    return `<button class="btn small primary" data-act="fix" data-v="${esc(i.id)}">${esc(i.fix.label)}</button>`;
  };
  return `<div class="grid g-2" style="margin-bottom:16px">
    <div class="card"><h3>Logbook completeness</h3><div class="sub">Share of all ${n} flights with each field filled in</div>
      ${fields.map(([l, fn]) => { const c = all.filter(fn).length; return `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${l}</span><span class="num ink2">${pct(c, n)}% <span class="muted">(${c})</span></span></div><div class="meter"><i style="width:${pct(c, n)}%"></i></div></div>`; }).join('')}
    </div>
    <div class="card"><h3>What gets checked</h3><div class="sub">Each check runs on every save</div>
      <ul style="margin:0;padding-left:18px;color:var(--ink-2);line-height:1.7">
        <li>Logged duration vs. local times converted through both airports' time zones</li>
        <li>Implausible block speed for the great-circle distance</li>
        <li>Overlapping flights and impossible hops between consecutive flights</li>
        <li>Same flight number and direction twice with no return, which is often a mis-logged return leg</li>
        <li>Exact duplicates, unknown airports, placeholder times</li>
      </ul></div>
  </div>
  <div class="card"><div class="card-head"><h3>Findings</h3>
    <div class="chips">${[['all', 'All open'], ['error', `Errors ${count('error')}`], ['warn', `Warnings ${count('warn')}`], ['info', `Info ${count('info')}`], ['dismissed', `Dismissed ${state.issues.filter(i => i.dismissed).length}`]]
      .map(([k, l]) => `<button class="chip ${state.healthSev === k ? 'on' : ''}" data-act="health-sev" data-v="${k}">${l}</button>`).join('')}</div></div>
    ${visible.map(i => `<div class="issue">
      <div class="sev ${i.severity}"><i>${sevLabel[i.severity][0]}</i>${sevLabel[i.severity][1]}</div>
      <div><div class="t">${esc(i.title)}</div><div class="d">${esc(i.detail)}</div>
        <div class="tagrow" style="margin-top:6px">${[...new Set(i.ids)].map(id => byId.get(id)).filter(Boolean).map(flightRef).join('')}</div></div>
      <div class="acts">${fixBtn(i)}<button class="btn small" data-act="${i.dismissed ? 'undismiss' : 'dismiss'}" data-v="${esc(i.id)}">${i.dismissed ? 'Restore' : 'Dismiss'}</button></div>
    </div>`).join('') || '<div class="empty">✓ Nothing to review here.</div>'}
  </div>`;
}

// ---------- global click handling
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('dialog')) return;
  const v = el.dataset.v, act = el.dataset.act;
  const toggle = (k, val) => setFilter({ [k]: state.filter[k] === val ? null : val });
  switch (act) {
    case 'year': setFilter({ year: v ? +v : null }); break;
    case 'unfilter': if (v === 'q') $('#search').value = ''; setFilter({ [v]: v === 'q' ? '' : null }); break;
    case 'clear-filters': $('#search').value = ''; setFilter({ year: null, airport: null, airline: null, route: null, aircraft: null, q: '' }); break;
    case 'route': toggle('route', v); break;
    case 'airport': toggle('airport', v); break;
    case 'airline': toggle('airline', v); break;
    case 'aircraft': toggle('aircraft', v); break;
    case 'edit': openFlight(el.dataset.id); break;
    case 'add': openFlight(null); break;
    case 'import': openImport(); break;
    case 'sort': state.sort = { key: v, dir: state.sort.key === v ? -state.sort.dir : (v === 'sortTime' || v === 'dist' || v === 'dur' ? -1 : 1) }; renderView(); break;
    case 'showall': state.showAll[v] = !state.showAll[v]; renderView(); break;
    case 'trips-all': state.tripsAll = !state.tripsAll; renderView(); break;
    case 'health-sev': state.healthSev = v; renderView(); break;
    case 'dismiss': commit(db => db.dismissed.push(v), 'Finding dismissed'); break;
    case 'undismiss': commit(db => { db.dismissed = db.dismissed.filter(x => x !== v); }); break;
    case 'fix': applyFix(state.issues.find(i => i.id === v)); break;
    case 'fix-airport': openAirport(v); break;
    case 'add-airport': openAirport(null); break;
    case 'edit-airport': openAirport(v); break;
  }
});
$('#view').addEventListener('mouseover', e => {
  const r = e.target.closest('[data-route]');
  map.highlightRoutes(r ? r.dataset.route.split(' ') : null);
});
$('#view').addEventListener('mouseleave', () => map.highlightRoutes(null));

function applyFix(issue) {
  if (!issue?.fix) return;
  const { kind, id, patch } = issue.fix;
  if (kind === 'patch') commit(db => Object.assign(db.flights.find(f => f.id === id), patch), 'Fixed: ' + issue.fix.label);
  else if (kind === 'delete') commit(db => { db.flights = db.flights.filter(f => f.id !== id); }, 'Duplicate deleted');
  else if (kind === 'edit') openFlight(id, patch);
}

// ---------- top bar actions
let searchTimer;
$('#search').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => setFilter({ q: e.target.value }), 120); });
$('#btn-add').onclick = () => openFlight(null);
$('#btn-import').onclick = () => openImport();
$('#btn-units').onclick = () => { state.units = state.units === 'km' ? 'mi' : 'km'; store.set('units', state.units); $('#btn-units').textContent = state.units; refresh(); };
function applyTheme() {
  if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = state.theme;
  $('#btn-theme').textContent = { auto: 'Auto', light: 'Light', dark: 'Dark' }[state.theme];
  map.rerender();
}
$('#btn-theme').onclick = () => { state.theme = { auto: 'light', light: 'dark', dark: 'auto' }[state.theme]; store.set('theme', state.theme); applyTheme(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => map.rerender());

$('#btn-export').onclick = e => {
  e.stopPropagation();
  document.querySelector('.menu')?.remove();
  const r = e.target.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'menu';
  m.style.top = (r.bottom + 6 + scrollY) + 'px'; m.style.left = Math.min(r.left, innerWidth - 240) + 'px';
  m.innerHTML = `<button data-x="csv">CSV<small>myFlightradar24 format, re-importable</small></button>
    <button data-x="csv-f">CSV of current view<small>${current.list.length} flights with current filters</small></button>
    <button data-x="json">JSON backup<small>Everything, including custom airports</small></button>`;
  document.body.append(m);
  m.onclick = ev => {
    const x = ev.target.closest('button')?.dataset.x; if (!x) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const apInfo = code => { const a = state.ap(code); return { label: `${a.city} / ${a.name || a.city}`, icao: a.icao }; };
    const pick = x === 'csv-f' ? current.list.map(f => f.f) : state.db.flights;
    if (x === 'json') download(`skylog-${stamp}.json`, JSON.stringify(state.db, null, 1), 'application/json');
    else download(`skylog-${stamp}.csv`, toFR24CSV([...pick].sort((a, b) => a.date.localeCompare(b.date)), apInfo), 'text/csv');
    m.remove();
  };
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }));
};
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener('keydown', e => {
  if (e.target.closest?.('input,textarea,select,dialog')) { if (e.key === 'Escape' && e.target.id === 'search') { e.target.value = ''; setFilter({ q: '' }); e.target.blur(); } return; }
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openFlight(null); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  else if (e.key === 'Escape' && map.replaying) stopReplay();
});

// ---------- flight dialog
const dlg = $('#dlg-flight'), form = $('#flight-form');
const opts = obj => Object.entries(obj).map(([k, v]) => `<option value="${k}">${v || '—'}</option>`).join('');
$('#f-seattype').innerHTML = opts(SEAT_TYPES); $('#f-cls').innerHTML = opts(CLASSES); $('#f-reason').innerHTML = opts(REASONS);
let editing = null;

function fillDatalists() {
  const all = state.ap.all().sort((a, b) => a.iata.localeCompare(b.iata));
  $('#dl-airports').innerHTML = all.map(a => `<option value="${a.iata}">${esc(a.label)}, ${esc(a.countryName)}</option>`).join('');
  const uniq = arr => [...new Set(arr.filter(Boolean))].sort();
  $('#dl-airlines').innerHTML = uniq(state.db.flights.map(f => f.airline && `${f.airline} (${f.airlineIata}/${f.airlineIcao})`)).map(v => `<option value="${esc(v)}">`).join('');
  $('#dl-aircraft').innerHTML = uniq(state.db.flights.map(f => f.aircraft && `${f.aircraft} (${f.aircraftCode})`)).map(v => `<option value="${esc(v)}">`).join('');
}

const apCode = v => {
  v = (v || '').trim();
  const m = v.toUpperCase().match(/^([A-Z0-9]{3,4})\b/);
  if (m && (state.ap(m[1]) && !state.ap(m[1]).unknown)) return m[1];
  const hit = state.ap.all().find(a => a.city.toLowerCase() === v.toLowerCase() || a.label.toLowerCase() === v.toLowerCase());
  return hit ? hit.iata : m ? m[1] : v.toUpperCase();
};
const parseDur = v => {
  v = (v || '').trim(); if (!v) return null;
  let m = v.match(/^(\d{1,2})\s*[:h]\s*(\d{1,2})\s*m?$/i); if (m) return +m[1] * 60 + +m[2];
  m = v.match(/^(\d{1,2})\s*h$/i); if (m) return +m[1] * 60;
  m = v.match(/^(\d+)\s*m(in)?$/i); if (m) return +m[1];
  return NaN;
};
const durInput = m => m == null ? '' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

function openFlight(id, patch = null) {
  const f = id ? state.db.flights.find(x => x.id === id) : null;
  editing = f ? f.id : null;
  const v = { ...(f || { date: new Date().toISOString().slice(0, 10), seatType: 0, cls: 1, reason: 0 }), ...(patch || {}) };
  $('#flight-title').textContent = f ? `Edit ${f.flightNumber || 'flight'} · ${f.date}` : 'Add flight';
  form.date.value = v.date || ''; form.flightNumber.value = v.flightNumber || '';
  form.from.value = v.from || ''; form.to.value = v.to || '';
  form.depTime.value = v.depTime || ''; form.arrTime.value = v.arrTime || '';
  form.duration.value = durInput(v.duration);
  form.airline.value = v.airline ? `${v.airline} (${v.airlineIata || ''}/${v.airlineIcao || ''})` : '';
  form.aircraft.value = v.aircraft ? `${v.aircraft} (${v.aircraftCode || ''})` : '';
  form.registration.value = v.registration || ''; form.seat.value = v.seat || '';
  form.seatType.value = v.seatType || 0; form.cls.value = v.cls || 0; form.reason.value = v.reason || 0; form.note.value = v.note || '';
  $('#f-delete').classList.toggle('hidden', !f);
  updatePreview();
  dlg.showModal();
  if (patch) toast('Review the suggested change, then Save');
}

function updatePreview() {
  const from = apCode(form.from.value), to = apCode(form.to.value);
  const A = from && state.ap(from), B = to && state.ap(to);
  $('#h-from').textContent = A ? (A.unknown ? 'Unknown airport. Add it under Places.' : `${A.label}, ${A.countryName}`) : '';
  $('#h-to').textContent = B ? (B.unknown ? 'Unknown airport. Add it under Places.' : `${B.label}, ${B.countryName}`) : '';
  const bits = [];
  let tzDur = null;
  if (A && B && !A.unknown && !B.unknown) {
    const km = haversine(A, B);
    bits.push(`Distance <b>${dist(km)}</b>`, `Typical block time <b>${dur(estimateDuration(km))}</b>`);
    if (form.date.value && form.depTime.value && form.arrTime.value) {
      tzDur = flightTimes({ date: form.date.value, depTime: form.depTime.value, arrTime: form.arrTime.value }, A, B).tzDur ?? null;
      if (tzDur != null) bits.push(`From times &amp; time zones <b>${dur(tzDur)}</b>`);
    }
  }
  $('#f-preview').innerHTML = bits.join('<span class="muted">·</span>') || '<span class="muted">Pick airports to see distance and expected duration.</span>';
  const d = parseDur(form.duration.value);
  const h = $('#h-dur');
  if (Number.isNaN(d)) h.textContent = 'Use h:mm, e.g. 12:09';
  else if (tzDur != null && (d == null || Math.abs(d - tzDur) > 5)) h.innerHTML = `<button type="button" id="use-tz">Use ${dur(tzDur)}</button>${d == null ? ' (or leave blank: auto)' : ''}`;
  else h.textContent = d == null ? 'Blank = computed automatically' : '';
  $('#use-tz')?.addEventListener('click', () => { form.duration.value = durInput(tzDur); updatePreview(); });
}
form.addEventListener('input', updatePreview);

function readForm() {
  const al = parseAirline(form.airline.value), ac = parseAircraft(form.aircraft.value);
  const known = state.db.flights.find(f => f.airline && f.airline.toLowerCase() === al.name.toLowerCase());
  const knownAc = state.db.flights.find(f => f.aircraft && f.aircraft.toLowerCase() === ac.name.toLowerCase());
  const d = parseDur(form.duration.value);
  return {
    date: form.date.value, flightNumber: form.flightNumber.value.trim().toUpperCase().replace(/\s+/g, ''),
    from: apCode(form.from.value), to: apCode(form.to.value), depTime: form.depTime.value, arrTime: form.arrTime.value,
    duration: Number.isNaN(d) ? null : d,
    airline: al.name, airlineIata: al.iata || known?.airlineIata || '', airlineIcao: al.icao || known?.airlineIcao || '',
    aircraft: ac.name, aircraftCode: ac.code || knownAc?.aircraftCode || '',
    registration: form.registration.value.trim().toUpperCase(), seat: form.seat.value.trim().toUpperCase(),
    seatType: +form.seatType.value, cls: +form.cls.value, reason: +form.reason.value, note: form.note.value.trim(),
  };
}
function saveForm() {
  if (!form.reportValidity()) return null;
  const v = readForm();
  if (v.from === v.to) { toast('From and To are the same airport'); return null; }
  if (editing) commit(db => Object.assign(db.flights.find(f => f.id === editing), v), `Saved ${v.flightNumber || 'flight'} ${v.from}→${v.to}`);
  else {
    const dup = state.db.flights.some(f => flightKey(f) === flightKey(v));
    commit(db => db.flights.push({ id: newId(), ...v }), `${dup ? 'Added (possible duplicate)' : 'Added'} ${v.flightNumber || 'flight'} ${v.from}→${v.to}`);
  }
  return v;
}
form.addEventListener('submit', e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  if (saveForm()) dlg.close();
});
$('#f-return').onclick = () => {
  const v = saveForm(); if (!v) return;
  dlg.close();
  openFlight(null, { from: v.to, to: v.from, airline: v.airline, airlineIata: v.airlineIata, airlineIcao: v.airlineIcao, cls: v.cls, reason: v.reason, date: v.date });
};
$('#f-delete').onclick = () => {
  const f = state.db.flights.find(x => x.id === editing); if (!f) return;
  dlg.close();
  commit(db => { db.flights = db.flights.filter(x => x.id !== f.id); }, `Deleted ${f.flightNumber || 'flight'} ${f.from}→${f.to}`);
};

// ---------- import dialog
const dlgI = $('#dlg-import');
let pending = null;
function openImport() { pending = null; $('#import-summary').classList.add('hidden'); $('#import-go').disabled = true; $('#import-file').value = ''; dlgI.showModal(); }
async function readImport(file) {
  const text = await file.text();
  const sum = $('#import-summary'); sum.classList.remove('hidden');
  try {
    let flights, labels = {}, extra = {};
    if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
      const j = JSON.parse(text);
      if (!Array.isArray(j.flights)) throw new Error('JSON has no "flights" array');
      flights = j.flights.map(f => ({ ...f, id: f.id || newId() })); labels = j.airportLabels || {};
      extra = { customAirports: j.customAirports || {}, dismissed: j.dismissed || [] };
    } else ({ flights, airportsSeen: labels } = fromFR24CSV(text));
    const have = new Set(state.db.flights.map(flightKey));
    const fresh = flights.filter(f => !have.has(flightKey(f)));
    const unknown = [...new Set(flights.flatMap(f => [f.from, f.to]))].filter(c => state.ap(c).unknown && !extra.customAirports?.[c]);
    pending = { flights, fresh, labels, extra };
    sum.innerHTML = `<b>${file.name}</b>: ${plural(flights.length, 'flight')} found. <b>${fresh.length}</b> new, ${flights.length - fresh.length} already in your log.
      ${unknown.length ? `<br>⚠ Airports without coordinates: ${unknown.join(', ')}. You can add them after importing.` : ''}`;
    $('#import-go').disabled = false;
  } catch (e) { sum.innerHTML = `<span style="color:var(--critical)">Couldn't read this file: ${esc(e.message)}</span>`; }
}
$('#import-file').onchange = e => e.target.files[0] && readImport(e.target.files[0]);
const drop = $('#drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && readImport(e.dataTransfer.files[0]); });
$('#import-form').addEventListener('submit', e => {
  if (e.submitter?.value !== 'go' || !pending) return;
  e.preventDefault();
  dlgI.close();
  const mode = $('#import-form').mode.value, p = pending;
  commit(db => {
    db.airportLabels = { ...(db.airportLabels || {}), ...p.labels };
    if (p.extra.customAirports) db.customAirports = { ...(db.customAirports || {}), ...p.extra.customAirports };
    if (mode === 'replace') { db.flights = p.flights; if (p.extra.dismissed) db.dismissed = p.extra.dismissed; }
    else db.flights.push(...p.fresh);
  }, mode === 'replace' ? `Replaced log with ${p.flights.length} flights` : `Imported ${p.fresh.length} new flights`);
});

// ---------- airport dialog
const dlgA = $('#dlg-airport'), aform = $('#airport-form');
aform.country.innerHTML = '<option value="">—</option>' + Object.entries(COUNTRIES).sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('');
try { $('#dl-tz').innerHTML = Intl.supportedValuesOf('timeZone').map(z => `<option value="${z}">`).join(''); } catch { /* older browser */ }
function openAirport(code) {
  const a = code ? state.ap(code) : null;
  const custom = code && state.db.customAirports?.[code];
  aform.reset();
  if (a) {
    aform.iata.value = a.iata; aform.icao.value = a.icao || ''; aform.city.value = a.city || ''; aform.name.value = a.name || '';
    aform.country.value = a.country || ''; aform.lat.value = a.unknown ? '' : a.lat; aform.lon.value = a.unknown ? '' : a.lon; aform.tz.value = a.tz || '';
  }
  $('#a-delete').classList.toggle('hidden', !custom);
  dlgA.showModal();
}
aform.addEventListener('submit', e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  dlgA.close();
  const a = Object.fromEntries(new FormData(aform));
  a.iata = a.iata.trim().toUpperCase(); a.icao = a.icao.trim().toUpperCase(); a.lat = +a.lat; a.lon = +a.lon;
  if (a.tz) { try { new Intl.DateTimeFormat('en', { timeZone: a.tz }); } catch { toast(`Unknown time zone “${a.tz}”, saved without it`); a.tz = ''; } }
  commit(db => { db.customAirports = { ...(db.customAirports || {}), [a.iata]: a }; }, `Saved airport ${a.iata}`);
});
$('#a-delete').onclick = () => {
  const code = aform.iata.value.trim().toUpperCase();
  dlgA.close();
  commit(db => { delete db.customAirports[code]; }, `Removed custom airport ${code}`);
};

// ---------- boot
async function boot() {
  $('#btn-units').textContent = state.units;
  const tb = $('#topbar');
  new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px')).observe(tb);
  applyTheme();
  let db = null;
  try { db = JSON.parse(localStorage.getItem(DB_KEY)); } catch { /* storage blocked */ }
  const firstRun = !db;
  state.db = db || structuredClone(globalThis.SKYLOG_SEED || { flights: [], customAirports: {}, airportLabels: {} });
  if (firstRun) save(); else setSave('Saved');
  renderBackup();
  recompute();
  map.setMode(state.mapMode);
  // Reattach the backup file (if one was set up) without holding up the first render.
  if (!fsSupported) return;
  try {
    const handle = await Promise.race([kvGet('backup'), new Promise(r => setTimeout(r, 3000))]);
    if (!handle) return;
    backup.handle = handle;
    backup.state = await handle.queryPermission({ mode: 'readwrite' }) === 'granted' ? 'on' : 'reconnect';
    // Browser data was cleared but the backup file survived: restore from it.
    if (firstRun && backup.state === 'on') {
      const file = await readBackup().catch(() => null);
      if (file) { state.db = file; save(); recompute(); toast(`Restored your logbook from ${handle.name}`); }
    }
    renderBackup();
  } catch { /* IndexedDB unavailable */ }
}
boot();
