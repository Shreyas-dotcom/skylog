import { createMap, FREQ, freqColor } from './map.js';
import { fromFR24CSV, toFR24CSV, SEAT_TYPES, CLASSES, REASONS, flightKey, newId, parseAirline, parseAircraft } from './fr24.js';
import { enrich, summarize, healthCheck, byCount, journeys, haversine, flightTimes, estimateDuration, EARTH_KM, MOON_KM, KM_PER_MI, HAULS, HAUL_RANGES } from './stats.js';
import { COUNTRIES } from './airports.js';
import { VAULT_FILE, newSession, seal, openVault, exportSession, importSession, detectRepo, githubStore } from './vault.js';

// ---------- small helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('skylog.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('skylog.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem('skylog.' + k); } catch { /* storage unavailable */ } },
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const GRAYS = ['#2f2f2f', '#5c5c5c', '#8a8a8a', '#b4b4b4', '#d9d9d9', '#ececec'];

const state = {
  db: null, all: [], ap: null, issues: [], issueBy: new Map(),
  filter: { year: null, airport: null, airline: null, route: null, aircraft: null, q: '' },
  page: store.get('page', 'profile'), units: store.get('units', 'km'), mapMode: store.get('mapMode', 'flat'),
  cardMetric: {}, sort: { key: 'sortTime', dir: -1 }, undo: [], healthSev: 'all',
};

const n0 = n => Math.round(n).toLocaleString();
const dist = km => km == null ? '—' : state.units === 'mi' ? `${n0(km / KM_PER_MI)} mi` : `${n0(km)} km`;
const dur = m => m == null ? '—' : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
const date = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const fname = f => f.flightNumber || (f.heli ? 'Helicopter' : 'Flight');

// Airline tail logos (the brand marks painted on tails), loaded by IATA code from Google Flights'
// public image set, which itself serves a blank gray tail for airlines it doesn't know. Flights with
// no airline code, or images that fail to load, get the same blank tail drawn locally.
const LOGO_URL = code => `https://www.gstatic.com/flights/airline_logos/70px/${code}.png`;
const BLANK_TAIL = '<svg class="blank" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21C10 19.5 13.5 13 15.2 3H20v18z" fill="#8e9094"/></svg>';
function airlineLogo(name, iata, size = '') {
  const img = iata ? `<img src="${LOGO_URL(iata)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('nologo');this.remove()">` : '';
  return `<span class="tail ${size} ${iata ? '' : 'nologo'}" title="${esc(name || 'No airline')}">${img}${BLANK_TAIL}</span>`;
}
const flightLogo = (f, size) => airlineLogo(f.airline, f.airlineIata, size);

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

// ---------- storage
// Hosted on GitHub Pages: the log is an encrypted file in the repository (see vault.js).
// Opened any other way (e.g. a downloaded file): it lives in this browser's storage.
const where = detectRepo();
const hosted = !!where;
const gh = hosted ? githubStore(where) : null;
const sync = { session: null, sha: null, token: null, timer: null, busy: false, rev: 0, saved: 0 };
const KEY = 'skylog.key';

function setSync(text, kind = '') { const el = $('#sync'); el.textContent = text; el.className = 'sync ' + kind; }
const unsynced = () => hosted && sync.rev !== sync.saved;

function save() {
  state.db.savedAt = new Date().toISOString();
  if (!hosted) {
    try { localStorage.setItem('skylog.db', JSON.stringify(state.db)); setSync('Saved in this browser', 'ok'); }
    catch { setSync('Not saved: browser storage unavailable. Use Export.', 'err'); }
    return;
  }
  sync.rev++;
  setSync('Saving…');
  clearTimeout(sync.timer);
  sync.timer = setTimeout(push, 1000);
}

async function push() {
  if (sync.busy) { sync.timer = setTimeout(push, 700); return; }
  sync.busy = true;
  const rev = sync.rev;
  try {
    const sealed = await seal(sync.session, { db: state.db, token: sync.token });
    // Keep an encrypted copy on this device until GitHub confirms the save, so nothing is lost
    // if the tab closes or the connection drops.
    store.set('pending', { vault: sealed, baseSha: sync.sha });
    if (!sync.token) { setSync('Not synced: add a GitHub token (menu → Security & sync)', 'err'); return; }
    sync.sha = await gh.write(sync.token, sealed, sync.sha);
    store.set('cache', { vault: sealed, sha: sync.sha });
    if (sync.rev === rev) { sync.saved = rev; store.del('pending'); setSync('Saved to GitHub', 'ok'); }
  } catch (e) {
    if (e.conflict) await resolveConflict();
    else if (e.auth) setSync('GitHub rejected the token. Update it in Security & sync.', 'err');
    else { setSync('Offline: changes kept on this device, retrying…', 'err'); clearTimeout(sync.timer); sync.timer = setTimeout(push, 15000); }
  } finally { sync.busy = false; }
}
addEventListener('online', () => { if (unsynced()) push(); });
addEventListener('beforeunload', e => { if (unsynced()) e.preventDefault(); });

// Someone saved from another device since this one loaded.
async function resolveConflict() {
  let remote, theirs = null;
  try { remote = await gh.read(sync.token); theirs = (await openVault(remote.vault, sync.session)).payload; } catch { /* unreadable */ }
  if (!theirs) { setSync('The log was re-encrypted elsewhere (new password?). Reload to unlock again.', 'err'); return; }
  sync.sha = remote.sha;
  const keepMine = confirm(`Your flight log was also changed on another device (${theirs.db.flights.length} flights there, ${state.db.flights.length} here).\n\n` +
    'OK: keep the version on this device (replaces the other one)\nCancel: switch to the other version (discards changes made here)');
  if (keepMine) { sync.timer = setTimeout(push, 0); return; }
  state.db = theirs.db; sync.saved = sync.rev; store.del('pending');
  recompute(); setSync('Loaded the latest version', 'ok');
}

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

// ---------- lock & setup screens (hosted mode)
const gate = $('#gate');
function showGate(msg, form = null) {
  gate.classList.remove('hidden');
  $('#gate-msg').textContent = msg;
  $('#unlock-form').classList.toggle('hidden', form !== 'unlock');
  $('#setup-form').classList.toggle('hidden', form !== 'setup');
  (form === 'unlock' ? $('#u-pass') : form === 'setup' ? $('#s-pass') : null)?.focus();
}

async function bootHosted() {
  showGate('Loading…');
  let remote = null, offline = false;
  try { remote = await gh.read(); } catch { offline = true; }
  if (!remote && !offline) {
    $('#s-token-link').href = 'https://github.com/settings/personal-access-tokens/new';
    return showGate(`Set up your private flight log. It will be stored encrypted in ${where.owner}/${where.repo}.`, 'setup');
  }
  const src = remote || store.get('cache', null);
  if (!src) return showGate("Can't reach GitHub right now, and this device has no saved copy yet. Check your connection and reload.");
  sync.sha = src.sha;
  gate.dataset.vault = JSON.stringify(src.vault);
  const saved = sessionStorage.getItem(KEY) || localStorage.getItem(KEY);
  if (saved) {
    try { return await enter(src.vault, await importSession(saved)); }
    catch { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); }
  }
  showGate(offline ? 'Offline: unlocking the copy saved on this device.' : 'This flight log is private.', 'unlock');
}

async function enter(v, passwordOrSession, remember) {
  const { session, payload } = await openVault(v, passwordOrSession);
  Object.assign(sync, { session, token: payload.token || null });
  state.db = payload.db;
  const key = await exportSession(session);
  sessionStorage.setItem(KEY, key);
  if (remember) localStorage.setItem(KEY, key);
  // Changes made on this device that never reached GitHub?
  const pend = store.get('pending', null);
  if (pend) {
    try {
      const mine = (await openVault(pend.vault, session)).payload.db;
      const keep = pend.baseSha === sync.sha || confirm('This device has changes that were never uploaded, but the log has since changed elsewhere.\n\nOK: keep this device\'s version\nCancel: discard them');
      if (keep) { state.db = mine; sync.rev++; sync.timer = setTimeout(push, 300); }
      else store.del('pending');
    } catch { store.del('pending'); }
  }
  gate.classList.add('hidden');
  delete gate.dataset.vault;
  start();
  if (!unsynced()) setSync(sync.token ? 'Saved to GitHub' : 'Read-only: no GitHub token', sync.token ? 'ok' : 'err');
}

$('#unlock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#u-go'); btn.disabled = true; btn.textContent = 'Unlocking…'; $('#u-err').textContent = '';
  try { await enter(JSON.parse(gate.dataset.vault), $('#u-pass').value, $('#u-remember').checked); $('#u-pass').value = ''; }
  catch (err) { $('#u-err').textContent = err.message === 'bad-password' ? 'Wrong password.' : 'Could not open the log: ' + err.message; }
  finally { btn.disabled = false; btn.textContent = 'Unlock'; }
});

const strengthOf = pw => {
  let s = Math.min(1, pw.length / 16) * 0.6 + [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter(r => r.test(pw)).length * 0.1;
  if (/^(.)\1+$/.test(pw) || /password|123456|qwerty/i.test(pw)) s = 0.1;
  return Math.min(1, s);
};
$('#s-pass').addEventListener('input', e => {
  const s = strengthOf(e.target.value), m = $('#s-meter');
  m.style.width = s * 100 + '%';
  m.style.background = s < 0.45 ? 'var(--critical)' : s < 0.75 ? 'var(--warning)' : 'var(--good)';
});
$('#setup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#s-err'), btn = $('#s-go'), pw = $('#s-pass').value, token = $('#s-token').value.trim();
  err.textContent = '';
  if (pw !== $('#s-pass2').value) return void (err.textContent = "Passwords don't match.");
  if (strengthOf(pw) < 0.45) return void (err.textContent = 'Choose a stronger password: longer, or a few random words.');
  btn.disabled = true; btn.textContent = 'Checking token…';
  try {
    const check = await gh.checkToken(token);
    if (!check.ok) throw new Error(check.reason);
    let db = { version: 1, flights: [], customAirports: {}, airportLabels: {}, dismissed: [] };
    const file = $('#s-csv').files[0];
    if (file) db = { ...db, ...parseImport(await file.text(), file.name).asDb };
    btn.textContent = 'Encrypting…';
    const session = await newSession(pw);
    db.savedAt = new Date().toISOString();
    const sealed = await seal(session, { db, token });
    sync.sha = await gh.write(token, sealed, null, 'Create encrypted flight log');
    store.set('cache', { vault: sealed, sha: sync.sha });
    await enter(sealed, session);
    toast(file ? `Your log is set up with ${db.flights.length} flights` : 'Your log is set up. Add or import flights to begin.');
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = 'Create my flight log'; }
});

// ---------- derived data
function recompute() {
  state.db.dismissed ||= [];
  const e = enrich(state.db);
  state.all = e.flights; state.ap = e.ap;
  // Flights dated after today are "upcoming": shown on the map and in the list, but not counted
  // in stats, records or milestones until they've happened.
  const today = new Date().toLocaleDateString('en-CA');
  for (const f of state.all) f.upcoming = f.date > today;
  state.past = state.all.filter(f => !f.upcoming);
  state.upcoming = state.all.filter(f => f.upcoming);
  const dismissed = new Set(state.db.dismissed);
  state.issues = healthCheck(state.all).map(i => ({ ...i, dismissed: dismissed.has(i.id) }));
  state.issueBy = new Map();
  for (const i of state.issues) if (!i.dismissed) for (const id of i.ids) if (!state.issueBy.has(id)) state.issueBy.set(id, i);
  for (const f of state.all) f.search = [f.date, f.flightNumber, f.from, f.to, f.A.label, f.B.label, f.A.countryName, f.B.countryName,
    f.airline, f.airlineIata, f.aircraft, f.aircraftCode, f.registration, f.note, SEAT_TYPES[f.seatType], CLASSES[f.cls], REASONS[f.reason]].join(' ').toLowerCase();
  fillDatalists();
  refresh();
}

const inYear = f => !state.filter.year || f.year === state.filter.year;
const byYear = () => state.past.filter(inYear);
function flightsFiltered() {
  const { airport, airline, route, aircraft, q } = state.filter;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return state.all.filter(inYear).filter(f => (!airport || f.from === airport || f.to === airport) && (!airline || f.airline === airline)
    && (!route || f.routeKey === route) && (!aircraft || (f.aircraftCode || f.aircraft) === aircraft) && terms.every(t => f.search.includes(t)));
}

let current = { list: [], s: null };
function refresh() {
  const list = byYear(), s = summarize(list);
  current = { list, s };
  renderNav(); renderYearSelect(); updateMap(s);
  if (state.page === 'profile') renderProfile(list, s);
  if (state.page === 'flights') renderFlights();
  if (state.page === 'records') renderRecords(list, s);
  if (state.page === 'check') renderCheck();
}
const setFilter = patch => { Object.assign(state.filter, patch); refresh(); };

function go(page) {
  state.page = page; store.set('page', page);
  for (const p of ['profile', 'flights', 'records', 'check']) $('#page-' + p).classList.toggle('hidden', p !== page);
  refresh();
  if (page === 'profile') map.rerender();
  scrollTo(0, 0);
}
function renderNav() {
  const open = state.issues.filter(i => !i.dismissed && i.severity !== 'info').length;
  document.querySelectorAll('#nav button').forEach(b => {
    if (b.dataset.page === 'check') b.innerHTML = `Data check${open ? `<span class="badge">${open}</span>` : ''}`;
    b.setAttribute('aria-current', b.dataset.page === state.page ? 'page' : 'false');
  });
}
$('#nav').onclick = e => { const b = e.target.closest('button[data-page]'); if (b) go(b.dataset.page); };

function renderYearSelect() {
  const years = [...new Set(state.all.map(f => f.year))].sort((a, b) => b - a);
  const html = `<option value="">All years</option>` + years.map(y => `<option value="${y}">${y}</option>`).join('');
  for (const sel of document.querySelectorAll('select[data-year], #year')) {
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    sel.value = state.filter.year || '';
  }
}
document.addEventListener('change', e => { if (e.target.matches('#year, select[data-year]')) setFilter({ year: +e.target.value || null }); });

// ---------- map
const map = createMap($('#map'), {
  tooltip,
  onRoute: r => { state.filter.route = r.key; go('flights'); },
  onAirport: a => { state.filter.airport = a.code; go('flights'); },
  onUpcoming: f => openFlight(f.id),
});
function updateMap(s) {
  map.update({
    routes: byCount(s.routes).filter(r => !r.a.unknown && !r.b.unknown), fmtDist: dist,
    airports: byCount(s.airports).filter(a => !a.a.unknown),
    upcoming: state.upcoming.filter(inYear).filter(f => f.path).map(f => ({ key: f.id, a: f.A, b: f.B, f })),
    countries: [...s.countries.values()].map(c => c.id).filter(Boolean),
  });
  $('#legend').innerHTML = `<b>Times flown</b>${FREQ.map(b => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join('')}`
    + (state.upcoming.length ? `<span><i class="dash"></i>Upcoming</span>` : '');
  document.querySelectorAll('#seg-mode button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === state.mapMode));
}
$('#seg-mode').onclick = e => { const m = e.target.dataset.mode; if (!m) return; state.mapMode = m; store.set('mapMode', m); map.setMode(m); updateMap(current.s); };
$('#btn-reset').onclick = () => map.reset();
$('#btn-zin').onclick = () => map.zoomBy(1.5);
$('#btn-zout').onclick = () => map.zoomBy(1 / 1.5);

const speeds = [1, 2, 4, 0.5];
let speedIx = 0;
$('#btn-replay').onclick = () => {
  if (map.replaying) return stopReplay();
  const counts = new Map([...current.s.routes.values()].map(r => [r.key, r.count]));
  const list = current.list.filter(f => f.path).map(f => ({ ...f, a: f.A, b: f.B, routeCount: counts.get(f.routeKey) }));
  if (!list.length) return toast('No flights to replay');
  $('#replay').classList.remove('hidden'); $('#legend').classList.add('hidden');
  $('#btn-replay').textContent = '■ Stop';
  let km = 0, lastI = -1;
  map.replay(list, {
    speed: () => speeds[speedIx],
    onFrame: ({ i, t }) => {
      const f = list[Math.min(i, list.length - 1)];
      if (i !== lastI) { km = list.slice(0, i).reduce((a, x) => a + x.dist, 0); lastI = i; }
      $('#rp-date').textContent = date(f.date);
      $('#rp-leg').textContent = `${fname(f)} ${f.from} → ${f.to} · ${Math.min(i + 1, list.length)}/${list.length} · ${dist(km + f.dist * Math.min(t, 1))}`;
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

// ---------- profile page
function renderProfile(list, s) {
  const dom = list.filter(f => f.A.country && f.A.country === f.B.country).length;
  const mins = s.minutes, days = mins / 1440;
  const km = state.units === 'mi' ? s.km / KM_PER_MI : s.km, other = state.units === 'mi' ? s.km : s.km / KM_PER_MI;
  $('#big-stats').innerHTML = `
    <div class="big"><div class="v">${s.count.toLocaleString()}<small>flight${s.count === 1 ? '' : 's'}</small></div>
      <div class="s"><b>${dom}</b> domestic<br><b>${s.count - dom}</b> international${state.upcoming.filter(inYear).length ? `<br><b class="up">${state.upcoming.filter(inYear).length}</b> upcoming` : ''}</div></div>
    <div class="big"><div class="v">${n0(km)}<small>${state.units}</small></div>
      <div class="s"><b>${n0(other)}</b> ${state.units === 'mi' ? 'km' : 'miles'}<br><b>${(s.km / EARTH_KM).toFixed(1)}×</b> around the Earth · <b>${(s.km / MOON_KM).toFixed(2)}×</b> to the Moon</div></div>
    <div class="big"><div class="v">${Math.floor(mins / 60).toLocaleString()}<small>h</small> ${Math.round(mins % 60)}<small>min</small></div>
      <div class="s"><b>${days.toFixed(1)}</b> days<br><b>${(days / 365.25).toFixed(3)}</b> years</div></div>
    <div class="big"><div class="v">${(s.co2 / 1000).toFixed(1)}<small>tons CO₂</small></div>
      <div class="s"><b>${s.count ? n0(s.co2 / s.count) : 0}</b> kg per flight<br>rough per-passenger estimate</div></div>`;

  const conts = {};
  for (const a of s.airports.values()) if (a.a.continent) conts[a.a.continent] = (conts[a.a.continent] || 0) + a.count;
  const code = (obj, order, labels) => order.map(k => ({ label: labels[k].toLowerCase(), value: obj[k] || 0 }));
  // Manufacturers: the top three by flights, the rest folded into "other".
  const makers = byCount(s.manufacturer), top3 = makers.slice(0, 3);
  const makerItems = top3.map(m => ({ label: m.name, value: m.count }))
    .concat(makers.length > 3 ? [{ label: 'other', value: makers.slice(3).reduce((t, m) => t + m.count, 0), sub: makers.slice(3).map(m => m.name).join(', ') }] : []);
  $('#pies').innerHTML = [
    ['Seat', code(s.seatType, [1, 2, 3], SEAT_TYPES).concat(s.seatType[4] || s.seatType[5] ? code(s.seatType, [4, 5], SEAT_TYPES) : [])],
    ['Reason', code(s.reason, [1, 2, 3, 4], REASONS)],
    ['Continents', ['Europe', 'Asia', 'North America', 'Oceania', 'South America', 'Africa'].map(c => ({ label: c.replace('North ', 'N ').replace('South ', 'S '), value: conts[c] || 0 }))],
    ['Haul', HAULS.map(h => ({ label: h.toLowerCase(), value: s.haul[h] || 0, sub: HAUL_RANGES[h] }))],
    ['Manufacturer', makerItems],
  ].map(([t, items]) => `<div class="pie-block"><h4>${t}</h4><div class="pie-row">${pie(items)}
      <div class="pie-legend">${items.map(i => `<div class="${i.value ? '' : 'z'}" ${i.sub ? `data-tip="${esc(i.sub)}"` : ''}><b>${i.value}</b> ${esc(i.label)}</div>`).join('')}</div></div></div>`).join('')
    + milestones();

  $('#stats').innerHTML = `<div class="cards">${CARDS.map(c => topCard(c, list)).join('')}</div>
    <div class="card trend blue"><div class="head"><h3>Flights per year</h3></div><div class="plot" id="ch-year"></div>
      <div class="foot"><div class="v">${yearsFlying()}</div><div class="k">years of flying</div></div></div>
    <div class="trend-row">
      <div class="card trend pink"><div class="head"><h3>Flights per month</h3></div><div class="plot" id="ch-month"></div></div>
      <div class="card trend pink"><div class="head"><h3>Flights per weekday</h3></div><div class="plot" id="ch-dow"></div></div>
    </div>`;
  drawTrends(s);
  growBars($('#stats'));
  setTimeout(() => document.querySelectorAll('.ms-bar i[data-w]').forEach(b => { b.style.width = b.dataset.w + '%'; }), 30);
}

function pie(items) {
  const total = items.reduce((t, i) => t + i.value, 0);
  if (!total) return `<svg viewBox="-1 -1 2 2"><circle r="1" fill="#eee"/></svg>`;
  let a0 = -Math.PI / 2;
  const live = items.map((it, ix) => ({ ...it, color: GRAYS[ix] })).filter(i => i.value);
  if (live.length === 1) return `<svg viewBox="-1 -1 2 2"><circle r="1" fill="${live[0].color}" data-tip="<b>${esc(live[0].label)}</b> · 100%"/></svg>`;
  return `<svg viewBox="-1 -1 2 2">${live.map(i => {
    const a1 = a0 + i.value / total * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0;
    const d = `M0,0 L${Math.cos(a0)},${Math.sin(a0)} A1,1 0 ${large} 1 ${Math.cos(a1)},${Math.sin(a1)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${i.color}" stroke-width="0.02" data-tip="<b>${esc(i.label)}</b> · ${i.value} (${pct(i.value, total)}%)"/>`;
  }).join('')}</svg>`;
}

// Progress toward the next round-number goals, always counted over all years.
function milestones() {
  const all = summarize(state.past);
  const next = (v, steps) => steps.find(x => x > v) ?? Math.ceil((v + 1) / steps.at(-1)) * steps.at(-1);
  const flights = next(all.count, [10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000]);
  const moons = Math.floor(all.km / MOON_KM) + 1;
  const countries = next(all.countries.size, [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 195]);
  const hours = next(all.minutes / 60, [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000]);
  const rows = [
    ['green', `${flights} flights`, all.count / flights, `${flights - all.count} to go`],
    ['yellow', moons === 1 ? 'To the Moon' : `${moons}× to the Moon`, all.km / (moons * MOON_KM), `${dist(moons * MOON_KM - all.km)} to go`],
    ['teal', `${countries} countries`, all.countries.size / countries, `${countries - all.countries.size} to go`],
    ['purple', `${hours.toLocaleString()} hours aloft`, all.minutes / 60 / hours, `${Math.ceil(hours - all.minutes / 60)} h to go`],
  ].sort((a, b) => b[2] - a[2]);
  const row = ([c, label, p, left], full) => `<div class="ms"><div class="ms-top"><b>${label}</b><span>${full ? left : Math.floor(p * 100) + '%'}</span></div>
      <div class="ms-bar"><i data-w="${Math.min(100, p * 100).toFixed(1)}" style="background:var(--${c}-1)"></i></div></div>`;
  // Compact: the two closest milestones. Click to pop open all of them with how much is left.
  return `<div class="pie-block milestones" data-act="ms-toggle" title="Show all milestones">
    <h4>Next milestones <span class="chev">▾</span></h4>${rows.slice(0, 2).map(r => row(r)).join('')}
    <div class="ms-pop"><h4>Next milestones</h4>${rows.map(r => row(r, true)).join('')}<div class="ms-note">Counted across all years</div></div></div>`;
}

// Top-list cards. Each aggregates flights by some key; "Flights" counts each flight once per key.
const CARDS = [
  { id: 'airports', title: 'Top airports', color: 'green', unit: 'airports', metrics: ['flights'], filter: 'airport',
    keys: f => [f.from, f.to], label: k => k, sub: (k, f) => (f.from === k ? f.A : f.B).label },
  { id: 'airlines', title: 'Top airlines', color: 'yellow', unit: 'airlines', metrics: ['flights', 'distance', 'time'], filter: 'airline',
    keys: f => [f.airline].filter(Boolean), label: (k, f) => f.airlineIata || k.slice(0, 3).toUpperCase(), sub: k => k },
  { id: 'aircraft', title: 'Top aircraft', color: 'red', unit: 'aircraft', metrics: ['flights', 'distance', 'time'], filter: 'aircraft',
    keys: f => [f.aircraftCode || f.aircraft].filter(Boolean), label: k => k, sub: (k, f) => f.aircraft },
  { id: 'routes', title: 'Top routes', color: 'purple', unit: 'routes', metrics: ['flights', 'distance', 'time'], filter: 'route',
    keys: f => [f.routeKey], label: k => k.replace('–', '-'), sub: (k, f) => `${f.A.city} – ${f.B.city}` },
  { id: 'countries', title: 'Top countries', color: 'teal', unit: 'countries', metrics: ['flights'],
    keys: f => [...new Set([f.A.country, f.B.country])].filter(Boolean), label: k => k, sub: k => COUNTRIES[k]?.[0] || k },
];
const METRIC_LABEL = { flights: 'Flights', distance: 'Distance', time: 'Time' };
function aggregate(card, list) {
  const m = new Map();
  for (const f of list) for (const k of new Set(card.keys(f))) {
    if (!m.has(k)) m.set(k, { key: k, label: card.label(k, f), sub: card.sub(k, f), flights: 0, distance: 0, time: 0 });
    const x = m.get(k); x.flights++; x.distance += f.dist || 0; x.time += f.dur || 0;
  }
  return [...m.values()];
}
const metricText = (metric, v) => metric === 'distance' ? dist(v) : metric === 'time' ? `${Math.round(v / 60).toLocaleString()} h` : v.toLocaleString();
const metricShort = (metric, v) => metric === 'distance' ? (state.units === 'mi' ? v / KM_PER_MI : v) >= 10000 ? `${Math.round((state.units === 'mi' ? v / KM_PER_MI : v) / 1000)}k` : n0(state.units === 'mi' ? v / KM_PER_MI : v)
  : metric === 'time' ? `${Math.round(v / 60)}h` : v;

function topCard(card, list) {
  const metric = state.cardMetric[card.id] || 'flights';
  const items = aggregate(card, list).sort((a, b) => b[metric] - a[metric] || b.flights - a.flights);
  const top = items.slice(0, 7), max = top[0]?.[metric] || 1;
  return `<div class="card top-card c-${card.color}">
    <div class="head"><h3>${card.title}</h3>
      <button class="expand" data-act="compare" data-v="${card.id}" aria-label="Compare all ${card.unit}" data-tip="Compare all">
        <svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M14 3h7v7h-2V6.4l-6.3 6.3-1.4-1.4L17.6 5H14zM5 5h6v2H7v10h10v-4h2v6H5z"/></svg></button>
      <div class="rows">${top.map(i => `<div class="row" data-act="${card.filter ? 'card-filter' : 'compare'}" data-card="${card.id}" data-v="${esc(i.key)}" data-tip="<b>${esc(i.sub)}</b><div class='t-sub'>${metricText(metric, i[metric])}</div>">
        <span class="lbl">${esc(i.label)}</span><span class="barcell"><span class="bar" data-w="${i[metric] / max * 100}"></span><span class="n">${metricShort(metric, i[metric])}</span></span></div>`).join('')
        || '<div class="row"><span class="lbl">—</span></div>'}</div>
    </div>
    <div class="foot"><div><div class="v">${items.length}</div><div class="k">total ${card.unit}</div></div>
      ${card.metrics.length > 1 ? `<div class="toggles">${card.metrics.slice(0, 2).map(mt => `<button class="pill ${mt === metric ? 'on' : ''}" data-act="card-metric" data-card="${card.id}" data-v="${mt}">${METRIC_LABEL[mt]}</button>`).join('')}</div>` : ''}
    </div></div>`;
}
const growBars = root => setTimeout(() => root.querySelectorAll('[data-w]').forEach(b => { b.style.width = `calc(${b.dataset.w}% - ${b.dataset.w * 0.34}px)`; }), 30);

// Full comparison for one card, as a pop-up bar chart.
function openCompare(id, metric) {
  const card = CARDS.find(c => c.id === id);
  metric ||= state.cardMetric[id] || 'flights';
  const items = aggregate(card, current.list).sort((a, b) => b[metric] - a[metric] || b.flights - a.flights);
  const total = items.reduce((t, i) => t + i[metric], 0), max = items[0]?.[metric] || 1;
  $('#compare').innerHTML = `<div class="head" style="background:linear-gradient(180deg,var(--${card.color}-1),var(--${card.color}-2))">
      <h2>${card.title.replace('Top ', 'All ')} · ${state.filter.year || 'all years'}</h2>
      <div class="metrics">${['flights', 'distance', 'time'].map(mt => `<button class="pill ${mt === metric ? 'on' : ''}" data-cmp="${id}" data-v="${mt}">${METRIC_LABEL[mt]}</button>`).join('')}</div>
      <button class="x" data-close aria-label="Close">✕</button></div>
    <div class="body">${items.map((i, ix) => `<div class="cmp-row" ${card.filter ? `data-cmp-filter="${card.filter}" data-v="${esc(i.key)}"` : ''}>
        <div class="lbl">${card.id === 'airlines' ? airlineLogo(i.key, i.label.length === 2 ? i.label : '') : ''}<b>${esc(i.label)}</b><span class="muted">${esc(i.sub !== i.label ? i.sub : '')}</span></div>
        <div class="track"><div class="fill" data-w="${i[metric] / max * 100}" style="background:var(--${card.color}-1);transition-delay:${Math.min(ix, 20) * 18}ms"></div></div>
        <div class="val">${metricText(metric, i[metric])}<small>${pct(i[metric], total)}%</small></div></div>`).join('') || '<div class="empty">Nothing here yet.</div>'}</div>`;
  const dlg = $('#dlg-compare');
  if (!dlg.open) dlg.showModal();
  setTimeout(() => dlg.querySelectorAll('.fill').forEach(b => { b.style.width = b.dataset.w + '%'; }), 30);
}
$('#dlg-compare').addEventListener('click', e => {
  const dlg = $('#dlg-compare');
  if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
  const m = e.target.closest('[data-cmp]'); if (m) return openCompare(m.dataset.cmp, m.dataset.v);
  const f = e.target.closest('[data-cmp-filter]');
  if (f) { dlg.close(); state.filter[f.dataset.cmpFilter] = f.dataset.v; go('flights'); }
});

function yearsFlying() {
  const ys = state.past.map(f => f.year);
  return ys.length ? Math.max(...ys) - Math.min(...ys) + 1 : 0;
}
// Smooth white line-and-area charts on the colored cards.
function drawTrends(s) {
  const ys = state.past.map(f => f.year);
  const all = summarize(state.past).years;
  const years = ys.length ? Array.from({ length: Math.max(...ys) - Math.min(...ys) + 1 }, (_, i) => Math.min(...ys) + i) : [];
  trend($('#ch-year'), years.map(y => ({ label: String(y), value: all.get(y)?.count || 0, sel: state.filter.year === y, year: y,
    tip: `<b>${y}</b> · ${plural(all.get(y)?.count || 0, 'flight')}<div class='t-sub'>${dist(all.get(y)?.km || 0)}</div>` })), 170);
  trend($('#ch-month'), s.months.map((v, i) => ({ label: MONTHS[i], value: v, tip: `<b>${MONTHS[i]}</b> · ${plural(v, 'flight')}` })), 140);
  trend($('#ch-dow'), s.dows.map((v, i) => ({ label: DOWS[i], value: v, tip: `<b>${DOWS[i]}</b> · ${plural(v, 'flight')}` })), 140);
}
function trend(el, pts, H) {
  if (!el) return;
  const W = Math.max(280, el.clientWidth - 32), padL = 26, padB = 22, padT = 14;
  const max = Math.max(1, ...pts.map(p => p.value)), step = niceStep(max), top = Math.ceil(max / step) * step;
  const x = i => padL + (pts.length < 2 ? (W - padL) / 2 : i * (W - padL - 8) / (pts.length - 1));
  const y = v => padT + (1 - v / top) * (H - padT - padB);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('');
  const grid = []; for (let v = 0; v <= top; v += step) grid.push(v);
  const every = Math.ceil(pts.length / Math.max(1, Math.floor(W / 46)));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">
    ${grid.map(v => `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`).join('')}
    ${pts.length ? `<path class="area" d="${line}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z"/><path class="line" d="${line}"/>` : ''}
    ${pts.map((p, i) => `<rect class="hit" x="${x(i) - 14}" y="0" width="28" height="${H - padB}" data-tip="${esc(p.tip)}" ${p.year ? `data-act="year-pick" data-v="${p.year}"` : ''}/>
      <circle class="dot ${p.sel ? 'sel' : ''}" cx="${x(i)}" cy="${y(p.value)}" r="4"/>
      ${i % every === 0 ? `<text x="${x(i)}" y="${H - 5}" text-anchor="middle">${p.label}</text>` : ''}`).join('')}
  </svg>`;
}
function niceStep(max) {
  const raw = max / 3, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
}
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.page === 'profile' && current.s) drawTrends(current.s); }, 120); }).observe($('#stats'));

// ---------- flights page
const COLS = [
  ['sortTime', 'Date'], ['flightNumber', 'Flight'], ['from', 'From'], ['to', 'To'], ['depTime', 'Dep'], ['arrTime', 'Arr'],
  ['dur', 'Duration', 'r'], ['dist', 'Distance', 'r'], ['airline', 'Airline'], ['aircraft', 'Aircraft'], ['registration', 'Reg'],
  ['seat', 'Seat'], ['cls', 'Class'], ['reason', 'Reason'], ['note', 'Note'],
];
function renderFlights() {
  const list = flightsFiltered();
  const { key, dir } = state.sort;
  const rows = [...list].sort((a, b) => {
    const x = a[key] ?? '', y = b[key] ?? '';
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir || (a.sortTime - b.sortTime) * dir;
  });
  const sevColor = { error: 'var(--critical)', warn: 'var(--warning)', info: '#9aa0a6' };
  const f0 = state.filter, chips = [];
  if (f0.airport) chips.push(['airport', `Airport: ${f0.airport}`]);
  if (f0.airline) chips.push(['airline', `Airline: ${f0.airline}`]);
  if (f0.route) chips.push(['route', `Route: ${f0.route.replace('–', ' ⇄ ')}`]);
  if (f0.aircraft) chips.push(['aircraft', `Aircraft: ${f0.aircraft}`]);
  let lastYear = null;
  const body = rows.map(f => {
    let sep = '';
    if (key === 'sortTime' && f.year !== lastYear) {
      lastYear = f.year;
      const n = rows.filter(r => r.year === f.year);
      sep = `<tr class="year-sep"><td colspan="${COLS.length + 1}">${f.year} · ${plural(n.length, 'flight')} · ${dist(n.reduce((t, r) => t + (r.dist || 0), 0))}</td></tr>`;
    }
    const iss = state.issueBy.get(f.id);
    const seat = [f.seat, SEAT_TYPES[f.seatType]].filter(Boolean).join(' · ');
    return sep + `<tr data-act="edit" data-id="${f.id}" data-route="${f.routeKey}">
      <td class="logo-cell">${flightLogo(f)}</td>
      <td class="num">${f.date}${f.upcoming ? ' <span class="up-tag">Upcoming</span>' : ''}${iss ? `<span class="flag-dot" style="background:${sevColor[iss.severity]}" data-tip="${esc(iss.title)}<div class='t-sub'>See Data check</div>"></span>` : ''}</td>
      <td class="mono">${esc(f.flightNumber)}</td>
      <td data-tip="${esc(f.A.label)}"><b>${f.from}</b> <span class="muted">${esc(f.A.city)}</span></td>
      <td data-tip="${esc(f.B.label)}"><b>${f.to}</b> <span class="muted">${esc(f.B.city)}</span></td>
      <td class="num">${f.depTime || ''}</td><td class="num">${f.arrTime || ''}</td>
      <td class="r num ${f.durSource !== 'logged' ? 'est' : ''}" ${f.durSource !== 'logged' ? `data-tip="${f.durSource === 'timezones' ? 'Computed from times &amp; time zones' : 'Estimated from distance'}"` : ''}>${f.durSource === 'estimate' ? '~' : ''}${dur(f.dur)}</td>
      <td class="r num">${dist(f.dist)}</td>
      <td>${esc(f.airline)}</td><td data-tip="${esc(f.aircraftCode)}">${esc(f.aircraft)}</td>
      <td class="mono">${esc(f.registration)}</td><td>${esc(seat)}</td><td>${CLASSES[f.cls] || ''}</td><td>${REASONS[f.reason] || ''}</td>
      <td class="muted">${esc(f.note)}</td></tr>`;
  }).join('');
  const page = $('#page-flights');
  const hadFocus = document.activeElement?.id === 'search';
  page.innerHTML = `<div class="toolbar">
      <input class="search" id="search" type="search" placeholder="Search flights, airports, tails…" value="${esc(state.filter.q)}">
      <select data-year aria-label="Year"></select>
      ${chips.map(([k, l]) => `<span class="chipf">${esc(l)}<button data-act="unfilter" data-v="${k}" aria-label="Remove filter">✕</button></span>`).join('')}
      <span class="muted">${plural(list.length, 'flight')} · ${dist(list.reduce((t, f) => t + (f.dist || 0), 0))}</span>
      <div class="spacer"></div><span class="muted">Click a row to edit · <kbd>N</kbd> new · <kbd>/</kbd> search</span></div>
    <div class="table-wrap"><table><thead><tr><th class="logo-cell" aria-label="Airline logo"></th>${COLS.map(([k, l, c]) => `<th class="${c || ''} ${key === k ? 'sorted' + (dir > 0 ? ' asc' : '') : ''}" data-act="sort" data-v="${k}">${l}</th>`).join('')}</tr></thead>
    <tbody>${body || `<tr><td colspan="${COLS.length + 1}" class="empty">No flights match.</td></tr>`}</tbody></table></div>`;
  renderYearSelect();
  const s = $('#search');
  s.oninput = () => { clearTimeout(s.t); s.t = setTimeout(() => { state.filter.q = s.value; renderFlights(); }, 150); };
  if (hadFocus) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// ---------- records page
function renderRecords(list, s) {
  const page = $('#page-records');
  const bar = `<div class="toolbar"><select data-year aria-label="Year"></select>
    <span class="muted">${state.filter.year ? `Records for ${state.filter.year}` : 'All-time records'} · click a record to open the flight</span></div>`;
  if (!list.length) { page.innerHTML = bar + '<div class="empty">No flights in this period.</div>'; renderYearSelect(); return; }

  const maxBy = (arr, fn) => arr.reduce((b, f) => fn(f) > fn(b) ? f : b, arr[0]);
  const minBy = (arr, fn) => arr.reduce((b, f) => fn(f) < fn(b) ? f : b, arr[0]);
  const flown = list.filter(f => f.dist != null && !f.heli);
  const timed = flown.filter(f => f.dur != null && f.durSource !== 'estimate');
  // Block speed, ignoring entries the data check flags as impossible.
  const speed = f => f.dist / (f.dur / 60);
  const fastest = timed.filter(f => f.dist > 300 && speed(f) < 1000);
  const route = f => `${fname(f)} ${f.from} → ${f.to} · ${date(f.date)}`;
  const flightRec = (k, f, value, cls) => f ? { k, cls, f, logo: flightLogo(f, 'lg'), v: value, d: route(f) } : null;

  // Favorites
  const topAl = byCount(s.airlines)[0], topAc = byCount(s.aircraft)[0], topRt = byCount(s.routes)[0], topAp = byCount(s.airports)[0];
  const tails = new Map();
  for (const f of list) if (f.registration) { const t = tails.get(f.registration) || { reg: f.registration, n: 0, f }; t.n++; t.f = f; tails.set(f.registration, t); }
  const topTail = [...tails.values()].sort((a, b) => b.n - a.n)[0];
  const seatTop = Object.entries(s.seatType).filter(([k]) => +k).sort((a, b) => b[1] - a[1])[0];
  const topCountry = [...s.countries.values()].sort((a, b) => b.count - a.count)[0];

  // Calendar
  const byDay = new Map();
  for (const f of list) byDay.set(f.date, [...(byDay.get(f.date) || []), f]);
  const busiestDay = [...byDay.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const yrs = [...s.years.values()].sort((a, b) => b.count - a.count);
  const ym = [...s.yearMonth.entries()].sort((a, b) => b[1] - a[1])[0];
  let gap = null;
  for (let i = 1; i < list.length; i++) {
    const days = Math.round((Date.parse(list[i].date) - Date.parse(list[i - 1].date)) / 864e5);
    if (!gap || days > gap.days) gap = { days, a: list[i - 1], b: list[i] };
  }
  const trips = journeys(list);
  const longTrip = maxBy(trips, j => j.total), mostLegs = maxBy(trips, j => j.legs.length);
  const perYearCountries = new Map();
  for (const f of list) for (const c of [f.A.countryName, f.B.countryName]) if (c !== '—') perYearCountries.set(f.year, new Set([...(perYearCountries.get(f.year) || []), c]));
  const ctyYear = [...perYearCountries.entries()].sort((a, b) => b[1].size - a[1].size)[0];

  // Geography
  const home = topAp?.a;
  const far = home && !home.unknown ? maxBy([...s.airports.values()].filter(a => !a.a.unknown), a => haversine(home, a.a)) : null;
  const north = maxBy([...s.airports.values()].filter(a => !a.a.unknown), a => a.a.lat);
  const south = minBy([...s.airports.values()].filter(a => !a.a.unknown), a => a.a.lat);

  const sections = [
    ['Distance & time', 's-blue', [
      flown.length && flightRec('Longest flight', maxBy(flown, f => f.dist), dist(maxBy(flown, f => f.dist).dist)),
      flown.length && flightRec('Shortest flight', minBy(flown, f => f.dist), dist(minBy(flown, f => f.dist).dist)),
      timed.length && flightRec('Longest in the air', maxBy(timed, f => f.dur), dur(maxBy(timed, f => f.dur).dur)),
      timed.length && flightRec('Shortest in the air', minBy(timed, f => f.dur), dur(minBy(timed, f => f.dur).dur)),
      fastest.length && flightRec('Fastest average speed', maxBy(fastest, speed), `${n0(state.units === 'mi' ? speed(maxBy(fastest, speed)) / KM_PER_MI : speed(maxBy(fastest, speed)))}<small>${state.units === 'mi' ? 'mph' : 'km/h'}</small>`),
      longTrip && longTrip.legs.length > 1 && { k: 'Longest journey', f: longTrip.legs[0], v: `${Math.floor(longTrip.total / 60)}<small>h</small> ${longTrip.total % 60}<small>min</small>`,
        d: `${[longTrip.legs[0].from, ...longTrip.legs.map(f => f.to)].join(' → ')} · door to door`, logo: flightLogo(longTrip.legs[0], 'lg') },
    ]],
    ['Favorites', 's-yellow', [
      topAl && { k: 'Most flown airline', v: esc(topAl.name), d: `${plural(topAl.count, 'flight')} · ${pct(topAl.count, s.count)}% of all · ${dist(topAl.km)}`, logo: airlineLogo(topAl.name, topAl.iata, 'lg'), filter: ['airline', topAl.name] },
      topAc && { k: 'Most flown aircraft', v: esc(topAc.name || topAc.code), d: `${plural(topAc.count, 'flight')} · ${dist(topAc.km)}`, filter: ['aircraft', topAc.code || topAc.name] },
      topRt && { k: 'Most flown route', v: `${topRt.a.iata} ⇄ ${topRt.b.iata}`, d: `${plural(topRt.count, 'flight')} · ${esc(topRt.a.city)} – ${esc(topRt.b.city)}`, filter: ['route', topRt.key] },
      topAp && { k: 'Busiest airport', v: topAp.code, d: `${plural(topAp.count, 'visit')} · ${esc(topAp.a.label)}`, filter: ['airport', topAp.code] },
      topTail && topTail.n > 1 && { k: 'Most flown aircraft (tail)', v: esc(topTail.reg), d: `${topTail.n} times · ${esc(topTail.f.aircraft)} · ${esc(topTail.f.airline)}`, logo: flightLogo(topTail.f, 'lg') },
      seatTop && { k: 'Favorite seat', v: SEAT_TYPES[seatTop[0]], d: `${pct(seatTop[1], s.count)}% of flights (${seatTop[1]})` },
      topCountry && { k: 'Most visited country', v: esc(topCountry.name), d: `${plural(topCountry.count, 'visit')} · ${plural(topCountry.airports.size, 'airport')}` },
    ]],
    ['Calendar', 's-purple', [
      yrs[0] && !state.filter.year && { k: 'Busiest year', v: yrs[0].year, d: `${plural(yrs[0].count, 'flight')} · ${dist(yrs[0].km)}`, act: `data-act="year-pick" data-v="${yrs[0].year}"` },
      ym && { k: 'Busiest month', v: `${MONTHS[+ym[0].split('-')[1]]} ${ym[0].split('-')[0]}`, d: plural(ym[1], 'flight') },
      busiestDay && busiestDay[1].length > 1 && { k: 'Most flights in a day', v: `${busiestDay[1].length}<small>flights</small>`, f: busiestDay[1][0],
        d: `${date(busiestDay[0])} · ${[busiestDay[1][0].from, ...busiestDay[1].map(f => f.to)].join(' → ')}` },
      gap && gap.days > 0 && { k: 'Longest time on the ground', v: `${gap.days.toLocaleString()}<small>days</small>`, d: `${date(gap.a.date)} → ${date(gap.b.date)}` },
      mostLegs && mostLegs.legs.length > 2 && { k: 'Most legs in one journey', v: `${mostLegs.legs.length}<small>legs</small>`, f: mostLegs.legs[0], d: [mostLegs.legs[0].from, ...mostLegs.legs.map(f => f.to)].join(' → ') },
      ctyYear && !state.filter.year && { k: 'Most countries in a year', v: `${ctyYear[1].size}<small>countries</small>`, d: `${ctyYear[0]} · ${[...ctyYear[1]].slice(0, 5).join(', ')}${ctyYear[1].size > 5 ? '…' : ''}` },
      { ...flightRec('', list[0], date(list[0].date)), k: 'First flight' },
      { ...flightRec('', list.at(-1), date(list.at(-1).date)), k: 'Most recent flight' },
    ]],
    ['Geography', 's-teal', [
      s.north && { k: 'Farthest north', v: `${s.north.maxLat.toFixed(1)}°N`, f: s.north, d: `over the route ${s.north.from} → ${s.north.to}` },
      s.south && { k: 'Farthest south', v: `${Math.abs(s.south.minLat).toFixed(1)}°${s.south.minLat < 0 ? 'S' : 'N'}`, f: s.south, d: `over the route ${s.south.from} → ${s.south.to}` },
      far && far.code !== topAp.code && { k: `Farthest from ${topAp.code}`, v: far.code, d: `${dist(haversine(home, far.a))} away · ${esc(far.a.label)}`, filter: ['airport', far.code] },
      north && { k: 'Northernmost airport', v: north.code, d: `${north.a.lat.toFixed(1)}° · ${esc(north.a.label)}`, filter: ['airport', north.code] },
      south && { k: 'Southernmost airport', v: south.code, d: `${south.a.lat.toFixed(1)}° · ${esc(south.a.label)}`, filter: ['airport', south.code] },
      { k: 'Date line crossings', v: list.filter(f => f.dateline).length, d: 'flights across the International Date Line' },
    ]],
  ];
  const card = r => {
    const act = r.act || (r.f ? `data-act="edit" data-id="${r.f.id}"` : r.filter ? `data-act="rec-filter" data-k="${r.filter[0]}" data-v="${esc(r.filter[1])}"` : '');
    return `<div class="rec" ${act}><div class="k">${r.k}</div><div class="main">${r.logo || ''}<div><div class="v">${r.v}</div><div class="d">${r.d}</div></div></div></div>`;
  };
  const board = (title, color, rows, val, fmt) => {
    const top = [...rows].sort((a, b) => val(b) - val(a)).slice(0, 10), max = val(top[0]) || 1;
    return `<div class="card board"><div class="head" style="background:linear-gradient(180deg,var(--${color}-1),var(--${color}-2))"><h3>${title}</h3></div>
      ${top.map((f, i) => `<div class="lb-row" data-act="edit" data-id="${f.id}"><span class="rank">${i + 1}</span>${flightLogo(f)}
        <span class="who"><b>${f.from} → ${f.to}</b> <span class="muted">${esc(fname(f))} · ${f.date}</span></span>
        <span class="track"><span class="fill" data-w="${val(f) / max * 100}" style="display:block;background:var(--${color}-1)"></span></span>
        <span class="val">${fmt(f)}</span></div>`).join('')}</div>`;
  };
  page.innerHTML = bar + sections.map(([title, cls, recs]) => {
    const items = recs.filter(r => r && r.v != null && r.v !== '');
    return items.length ? `<div class="rec-section ${cls}"><div class="section-h">${title}</div><div class="rec-grid">${items.map(card).join('')}</div></div>` : '';
  }).join('') + `<div class="section-h">Leaderboards</div><div class="boards">
    ${board('Longest flights', 'blue', flown, f => f.dist, f => dist(f.dist))}
    ${board('Longest time in the air', 'purple', timed, f => f.dur, f => dur(f.dur))}</div>`;
  renderYearSelect();
  setTimeout(() => page.querySelectorAll('.fill[data-w]').forEach(b => { b.style.width = b.dataset.w + '%'; }), 30);
}

// ---------- data check page
function renderCheck() {
  const all = state.all, n = all.length;
  const fields = [
    ['Departure & arrival times', f => f.depTime && f.arrTime && !(f.depTime === '00:00' && f.arrTime === '00:00')],
    ['Airline', f => f.airline], ['Aircraft type', f => f.aircraft || f.aircraftCode], ['Registration', f => f.registration],
    ['Seat number', f => f.seat], ['Seat type', f => f.seatType], ['Flight reason', f => f.reason],
  ];
  const sevLabel = { error: ['!', 'Error'], warn: ['!', 'Warning'], info: ['i', 'Info'] };
  const visible = state.issues.filter(i => state.healthSev === 'all' ? !i.dismissed : state.healthSev === 'dismissed' ? i.dismissed : i.severity === state.healthSev && !i.dismissed);
  const count = sev => state.issues.filter(i => i.severity === sev && !i.dismissed).length;
  const byId = new Map(all.map(f => [f.id, f]));
  const ref = f => `<button class="tag mono" data-act="edit" data-id="${f.id}" data-tip="${esc(`${f.A.label} → ${f.B.label}<div class='t-sub'>${date(f.date)} · ${f.airline || ''}</div>`)}">${esc(fname(f))} ${f.from}→${f.to}</button>`;
  const fixBtn = i => !i.fix ? '' : i.fix.kind === 'airport'
    ? `<button class="btn small primary" data-act="fix-airport" data-v="${i.fix.code}">Add airport</button>`
    : `<button class="btn small primary" data-act="fix" data-v="${esc(i.id)}">${esc(i.fix.label)}</button>`;
  $('#page-check').innerHTML = `
    <div class="card" style="padding:16px 18px;margin-bottom:16px">
      <div class="section-h" style="margin-top:0">Logbook completeness</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 24px">
      ${fields.map(([l, fn]) => { const c = all.filter(fn).length; return `<div><div style="display:flex;justify-content:space-between;font-size:13px"><span>${l}</span><b>${pct(c, n)}%</b></div>
        <div style="height:6px;background:var(--line);border-radius:3px;margin-top:4px;overflow:hidden"><i style="display:block;height:100%;width:${pct(c, n)}%;background:var(--teal-1)"></i></div></div>`; }).join('')}
      </div></div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--line)">
        <div><b>Things to review</b> <span class="muted">· times vs. time zones, impossible speeds, overlaps, mis-logged return legs, duplicates</span></div>
        <div class="chips">${[['all', 'All open'], ['error', `Errors ${count('error')}`], ['warn', `Warnings ${count('warn')}`], ['info', `Info ${count('info')}`], ['dismissed', `Dismissed ${state.issues.filter(i => i.dismissed).length}`]]
          .map(([k, l]) => `<button class="chip ${state.healthSev === k ? 'on' : ''}" data-act="health-sev" data-v="${k}">${l}</button>`).join('')}</div>
      </div>
      ${visible.map(i => `<div class="issue">
        <div class="sev ${i.severity}"><i>${sevLabel[i.severity][0]}</i>${sevLabel[i.severity][1]}</div>
        <div><div class="t">${esc(i.title)}</div><div class="d">${esc(i.detail)}</div>
          <div class="tagrow">${[...new Set(i.ids)].map(id => byId.get(id)).filter(Boolean).map(ref).join('')}</div></div>
        <div class="acts">${fixBtn(i)}<button class="btn small" data-act="${i.dismissed ? 'undismiss' : 'dismiss'}" data-v="${esc(i.id)}">${i.dismissed ? 'Restore' : 'Dismiss'}</button></div>
      </div>`).join('') || '<div class="empty">✓ Nothing to review here.</div>'}
    </div>`;
}

// ---------- global click handling
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('dialog')) return;
  const v = el.dataset.v, act = el.dataset.act;
  switch (act) {
    case 'unfilter': setFilter({ [v]: null }); break;
    case 'card-filter': { const card = CARDS.find(c => c.id === el.dataset.card); state.filter[card.filter] = v; go('flights'); break; }
    case 'card-metric': state.cardMetric[el.dataset.card] = v; refresh(); break;
    case 'compare': openCompare(v || el.dataset.card); break;
    case 'ms-toggle':
      el.classList.toggle('pop-left', el.getBoundingClientRect().right < 330); // open rightwards when near the left edge
      el.classList.toggle('open');
      el.querySelectorAll('.ms-pop .ms-bar i').forEach(i => { i.style.width = i.dataset.w + '%'; });
      break;
    case 'rec-filter': state.filter[el.dataset.k] = v; go('flights'); break;
    case 'year-pick': setFilter({ year: state.filter.year === +v ? null : +v }); break;
    case 'edit': openFlight(el.dataset.id); break;
    case 'sort': state.sort = { key: v, dir: state.sort.key === v ? -state.sort.dir : (v === 'sortTime' || v === 'dist' || v === 'dur' ? -1 : 1) }; renderFlights(); break;
    case 'health-sev': state.healthSev = v; renderCheck(); break;
    case 'dismiss': commit(db => db.dismissed.push(v), 'Finding dismissed'); break;
    case 'undismiss': commit(db => { db.dismissed = db.dismissed.filter(x => x !== v); }); break;
    case 'fix': applyFix(state.issues.find(i => i.id === v)); break;
    case 'fix-airport': openAirport(v); break;
  }
});
// Clicking anywhere else closes the milestones pop-up.
document.addEventListener('click', e => { if (!e.target.closest('.milestones')) document.querySelector('.milestones.open')?.classList.remove('open'); });
document.addEventListener('mouseover', e => {
  if (state.page !== 'profile') return;
  const r = e.target.closest?.('[data-route]');
  map.highlightRoutes(r ? r.dataset.route.split(' ') : null);
});

function applyFix(issue) {
  if (!issue?.fix) return;
  const { kind, id, patch } = issue.fix;
  if (kind === 'patch') commit(db => Object.assign(db.flights.find(f => f.id === id), patch), 'Fixed: ' + issue.fix.label);
  else if (kind === 'delete') commit(db => { db.flights = db.flights.filter(f => f.id !== id); }, 'Duplicate deleted');
  else if (kind === 'edit') openFlight(id, patch);
}

// ---------- menu
$('#btn-add').onclick = () => openFlight(null);
$('#btn-menu').onclick = e => {
  e.stopPropagation();
  document.querySelector('.menu')?.remove();
  const r = e.currentTarget.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'menu';
  m.style.top = (r.bottom + 6 + scrollY) + 'px'; m.style.left = Math.max(8, r.right - 260) + 'px';
  m.innerHTML = `<button data-x="import">Import flights<small>myFlightradar24 CSV or Skylog backup</small></button>
    <button data-x="csv">Export CSV<small>myFlightradar24 format, re-importable</small></button>
    <button data-x="json">Export backup (JSON)<small>Everything, unencrypted. Keep it somewhere safe.</small></button>
    <hr><button data-x="units">Units: ${state.units === 'km' ? 'kilometres' : 'miles'}<small>Switch to ${state.units === 'km' ? 'miles' : 'kilometres'}</small></button>
    <button data-x="airport">Add custom airport<small>For airports missing from the built-in list</small></button>
    ${hosted ? `<hr><button data-x="settings">Security &amp; sync<small>Password, GitHub token</small></button><button data-x="lock">Lock<small>Sign out on this device</small></button>` : ''}`;
  document.body.append(m);
  m.onclick = ev => {
    const x = ev.target.closest('button')?.dataset.x; if (!x) return;
    m.remove();
    const stamp = new Date().toISOString().slice(0, 10);
    if (x === 'import') openImport();
    if (x === 'csv') {
      const apInfo = code => { const a = state.ap(code); return { label: `${a.city} / ${a.name || a.city}`, icao: a.icao }; };
      download(`skylog-${stamp}.csv`, toFR24CSV([...state.db.flights].sort((a, b) => a.date.localeCompare(b.date)), apInfo), 'text/csv');
    }
    if (x === 'json') download(`skylog-${stamp}.json`, JSON.stringify(state.db, null, 1), 'application/json');
    if (x === 'units') { state.units = state.units === 'km' ? 'mi' : 'km'; store.set('units', state.units); refresh(); }
    if (x === 'airport') openAirport(null);
    if (x === 'settings') openSettings();
    if (x === 'lock') { if (unsynced() && !confirm('Some changes are not saved to GitHub yet. Lock anyway? (They stay on this device and upload next time.)')) return; sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); location.reload(); }
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
  if (!gate.classList.contains('hidden')) return;
  if (e.target.closest?.('input,textarea,select,dialog')) {
    if (e.key === 'Escape' && e.target.id === 'search') { e.target.value = ''; state.filter.q = ''; renderFlights(); e.target.blur(); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); if (state.page !== 'flights') go('flights'); $('#search')?.focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openFlight(null); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  else if (e.key === 'Escape' && map.replaying) stopReplay();
});

// ---------- settings (hosted)
const dlgS = $('#dlg-settings'), sform = $('#settings-form');
function openSettings() {
  sform.reset(); $('#set-err').textContent = '';
  $('#set-where').innerHTML = `Encrypted log: <a href="https://github.com/${where.owner}/${where.repo}/commits/HEAD/${VAULT_FILE}" target="_blank" rel="noopener">${where.owner}/${where.repo}/${VAULT_FILE}</a>. Every save is a commit, so earlier versions can always be recovered. GitHub token: ${sync.token ? 'set' : '<b>missing</b> (saving is off)'}.`;
  dlgS.showModal();
}
sform.addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const err = $('#set-err'), pw = $('#set-pass').value, token = $('#set-token').value.trim();
  err.textContent = '';
  try {
    if (pw) {
      if (pw !== $('#set-pass2').value) throw new Error("Passwords don't match.");
      if (strengthOf(pw) < 0.45) throw new Error('Choose a stronger password.');
    }
    if (token) { const c = await gh.checkToken(token); if (!c.ok) throw new Error(c.reason); sync.token = token; }
    if (pw) {
      sync.session = await newSession(pw);
      const key = await exportSession(sync.session);
      sessionStorage.setItem(KEY, key);
      if (localStorage.getItem(KEY)) localStorage.setItem(KEY, key);
    }
    if (pw || token) { save(); toast(pw ? 'Password changed. Other devices will ask for the new one.' : 'GitHub token updated'); }
    dlgS.close();
  } catch (ex) { err.textContent = ex.message; }
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
  if (m && state.ap(m[1]) && !state.ap(m[1]).unknown) return m[1];
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
  $('#h-from').textContent = A ? (A.unknown ? 'Unknown airport: add it from the menu' : `${A.label}, ${A.countryName}`) : '';
  $('#h-to').textContent = B ? (B.unknown ? 'Unknown airport: add it from the menu' : `${B.label}, ${B.countryName}`) : '';
  const bits = [];
  let tzDur = null;
  if (A && B && !A.unknown && !B.unknown) {
    const km = haversine(A, B);
    bits.push(`Distance <b>${dist(km)}</b>`, `Typical flight time <b>${dur(estimateDuration(km))}</b>`);
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

// ---------- import
function parseImport(text, name) {
  if (/\.json$/i.test(name) || text.trim().startsWith('{')) {
    const j = JSON.parse(text);
    if (!Array.isArray(j.flights)) throw new Error('JSON has no "flights" array');
    const flights = j.flights.map(f => ({ ...f, id: f.id || newId() }));
    return { flights, labels: j.airportLabels || {}, extra: { customAirports: j.customAirports || {}, dismissed: j.dismissed || [] },
      asDb: { flights, airportLabels: j.airportLabels || {}, customAirports: j.customAirports || {}, dismissed: j.dismissed || [] } };
  }
  const { flights, airportsSeen } = fromFR24CSV(text);
  return { flights, labels: airportsSeen, extra: {}, asDb: { flights, airportLabels: airportsSeen } };
}
const dlgI = $('#dlg-import');
let pending = null;
function openImport() { pending = null; $('#import-summary').classList.add('hidden'); $('#import-go').disabled = true; $('#import-file').value = ''; dlgI.showModal(); }
async function readImport(file) {
  const sum = $('#import-summary'); sum.classList.remove('hidden');
  try {
    const p = parseImport(await file.text(), file.name);
    const have = new Set(state.db.flights.map(flightKey));
    p.fresh = p.flights.filter(f => !have.has(flightKey(f)));
    const unknown = [...new Set(p.flights.flatMap(f => [f.from, f.to]))].filter(c => state.ap(c).unknown && !p.extra.customAirports?.[c]);
    pending = p;
    sum.innerHTML = `<b>${esc(file.name)}</b>: ${plural(p.flights.length, 'flight')} found. <b>${p.fresh.length}</b> new, ${p.flights.length - p.fresh.length} already in your log.
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

// ---------- custom airport dialog
const dlgA = $('#dlg-airport'), aform = $('#airport-form');
aform.country.innerHTML = '<option value="">—</option>' + Object.entries(COUNTRIES).sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('');
try { $('#dl-tz').innerHTML = Intl.supportedValuesOf('timeZone').map(z => `<option value="${z}">`).join(''); } catch { /* older browser */ }
function openAirport(code) {
  const a = code ? state.ap(code) : null;
  aform.reset();
  if (a) {
    aform.iata.value = a.iata; aform.icao.value = a.icao || ''; aform.city.value = a.city || ''; aform.name.value = a.name || '';
    aform.country.value = a.country || ''; aform.lat.value = a.unknown ? '' : a.lat; aform.lon.value = a.unknown ? '' : a.lon; aform.tz.value = a.tz || '';
  }
  $('#a-delete').classList.toggle('hidden', !(code && state.db.customAirports?.[code]));
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
function start() {
  recompute();
  map.setMode(state.mapMode);
  go(state.page);
}
if (hosted) bootHosted();
else {
  let db = null;
  try { db = JSON.parse(localStorage.getItem('skylog.db')); } catch { /* storage blocked */ }
  state.db = db || structuredClone(globalThis.SKYLOG_SEED || { flights: [], customAirports: {}, airportLabels: {} });
  if (!db) save(); else setSync('Saved in this browser', 'ok');
  start();
}
