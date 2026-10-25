// Flight enrichment (distances, timezones), aggregate statistics, journeys,
// achievements and data-health checks. Pure functions, no DOM.
import { BUILTIN_AIRPORTS, COUNTRIES, ALLIANCES, HELICOPTER_CODES } from './airports.js';
import { flightKey } from './fr24.js';

export const EARTH_KM = 40075, MOON_KM = 384400, KM_PER_MI = 1.609344;
const R = 6371.0088, rad = Math.PI / 180;

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Points along the great circle from a to b, as [lon, lat].
export function greatCircle(a, b, n = 48) {
  const φ1 = a.lat * rad, λ1 = a.lon * rad, φ2 = b.lat * rad, λ2 = b.lon * rad;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d === 0) return [[a.lon, a.lat], [b.lon, b.lat]];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    pts.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad]);
  }
  return pts;
}

// ---------- time zones
const dtfCache = {};
function tzOffsetMin(tz, ms) {
  const f = dtfCache[tz] ||= new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms) / 60000);
}

export function localToUtc(date, time, tz) {
  try {
    const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const off = tzOffsetMin(tz, guess);
    let t = guess - off * 60000;
    const off2 = tzOffsetMin(tz, t);
    if (off2 !== off) t = guess - off2 * 60000;
    return t;
  } catch { return null; }
}

const DAY = 86400000;
const hasTimes = f => f.depTime && !(f.depTime === '00:00' && (!f.arrTime || f.arrTime === '00:00'));

// Departure/arrival instants from local times + airport time zones.
export function flightTimes(f, A, B) {
  if (!hasTimes(f) || !A?.tz) return {};
  const depUtc = localToUtc(f.date, f.depTime, A.tz);
  if (depUtc == null || !f.arrTime || !B?.tz) return { depUtc };
  let best = null;
  for (const off of [-1, 0, 1, 2]) {
    const d = new Date(Date.parse(f.date + 'T00:00:00Z') + off * DAY).toISOString().slice(0, 10);
    const arr = localToUtc(d, f.arrTime, B.tz);
    if (arr != null && arr - depUtc > 5 * 60000 && (best == null || arr < best)) best = arr;
  }
  return best == null ? { depUtc } : { depUtc, arrUtc: best, tzDur: Math.round((best - depUtc) / 60000) };
}

// Typical gate-to-gate time: cruise around 780 km/h plus ~40 min for taxi, climb and approach.
export const estimateDuration = km => Math.round(km / 780 * 60 + 40);

// ---------- airports
export function makeAirportLookup(db) {
  const custom = db.customAirports || {}, labels = db.airportLabels || {};
  const cache = {};
  const lookup = code => {
    if (cache[code]) return cache[code];
    let a = custom[code] || BUILTIN_AIRPORTS[code];
    if (a) a = { ...a, metro: a.metro || a.city, custom: !!custom[code] };
    else {
      const label = labels[code]?.label || code;
      const [city, name] = label.includes(' / ') ? label.split(' / ') : [label, ''];
      a = { iata: code, icao: labels[code]?.icao || '', city, name, metro: city, country: '', unknown: true };
    }
    a.countryName = COUNTRIES[a.country]?.[0] || a.country || '—';
    a.continent = COUNTRIES[a.country]?.[2] || '';
    a.countryId = COUNTRIES[a.country]?.[1] || null;
    a.label = a.name && a.name !== a.city ? `${a.city} / ${a.name}` : a.city;
    return (cache[code] = a);
  };
  lookup.all = () => {
    const codes = new Set([...Object.keys(BUILTIN_AIRPORTS), ...Object.keys(custom)]);
    return [...codes].map(lookup);
  };
  return lookup;
}

const allianceOf = iata => Object.keys(ALLIANCES).find(k => ALLIANCES[k].includes(iata)) || 'Unaffiliated';
const haulOf = km => km == null ? 'Unknown' : km < 1500 ? 'Short' : km < 4000 ? 'Medium' : km < 10000 ? 'Long' : 'Ultra-long';
export const HAULS = ['Short', 'Medium', 'Long', 'Ultra-long'];
export const HAUL_RANGES = { Short: '< 1,500 km', Medium: '1,500–4,000 km', Long: '4,000–10,000 km', 'Ultra-long': '> 10,000 km' };

export function enrich(db) {
  const ap = makeAirportLookup(db);
  const out = db.flights.map(f => {
    const A = ap(f.from), B = ap(f.to);
    const geo = !A.unknown && !B.unknown;
    const dist = geo ? haversine(A, B) : null;
    const t = flightTimes(f, A, B);
    let dur = f.duration, durSource = 'logged';
    if (dur == null && t.tzDur != null) { dur = t.tzDur; durSource = 'timezones'; }
    if (dur == null && dist != null) { dur = estimateDuration(dist); durSource = 'estimate'; }
    const sortTime = t.depUtc ?? Date.parse(f.date + 'T12:00:00Z');
    const arrUtc = t.arrUtc ?? (dur != null ? sortTime + dur * 60000 : sortTime);
    const path = geo ? greatCircle(A, B, Math.max(8, Math.round(dist / 150))) : null;
    const lons = path ? path.map(p => p[0]) : [];
    let dateline = false;
    for (let i = 1; i < lons.length; i++) if (Math.abs(lons[i] - lons[i - 1]) > 180) dateline = true;
    const d = new Date(f.date + 'T00:00:00Z');
    return {
      ...f, f, A, B, dist, dur, durSource, tzDur: t.tzDur, depUtc: t.depUtc, arrUtc, sortTime, path,
      year: +f.date.slice(0, 4), month: d.getUTCMonth(), dow: (d.getUTCDay() + 6) % 7,
      depHour: f.depTime && hasTimes(f) ? +f.depTime.slice(0, 2) : null,
      routeKey: [f.from, f.to].sort().join('–'),
      heli: HELICOPTER_CODES.has(f.aircraftCode) || /heliport/i.test(A.name + B.name),
      haul: haulOf(dist), alliance: allianceOf(f.airlineIata),
      maxLat: path ? Math.max(...path.map(p => p[1])) : null,
      minLat: path ? Math.min(...path.map(p => p[1])) : null,
      dateline, equator: geo && Math.sign(A.lat) !== Math.sign(B.lat),
      manufacturer: (f.aircraft || '').split(' ')[0] || 'Unknown',
    };
  });
  out.sort((a, b) => a.sortTime - b.sortTime);
  return { flights: out, ap };
}

// ---------- aggregates
const bump = (map, key, init, fn) => { if (!map.has(key)) map.set(key, init()); fn(map.get(key)); };
export const byCount = m => [...m.values()].sort((a, b) => b.count - a.count || (b.km || 0) - (a.km || 0));

export function summarize(list) {
  const s = {
    count: list.length, km: 0, minutes: 0, co2: 0,
    airports: new Map(), countries: new Map(), continents: new Set(), airlines: new Map(),
    aircraft: new Map(), routes: new Map(), regs: new Set(), years: new Map(), yearMonth: new Map(),
    months: Array(12).fill(0), dows: Array(7).fill(0), hours: Array(24).fill(0),
    seatType: {}, cls: {}, reason: {}, haul: {}, alliance: {}, manufacturer: new Map(),
    longest: null, shortest: null, longestTime: null, north: null, south: null,
  };
  for (const f of list) {
    s.km += f.dist || 0;
    s.minutes += f.dur || 0;
    if (f.dist) s.co2 += f.dist * (f.dist < 1500 ? 0.16 : f.dist < 4000 ? 0.12 : 0.105) * (f.cls === 2 ? 2.9 : f.cls === 3 ? 4 : f.cls === 4 ? 1.5 : 1);
    for (const [code, a, dep] of [[f.from, f.A, true], [f.to, f.B, false]]) {
      bump(s.airports, code, () => ({ code, a, count: 0, deps: 0, arrs: 0, first: f.date, last: f.date }), x => {
        x.count++; dep ? x.deps++ : x.arrs++; x.last = f.date;
      });
      if (a.country) bump(s.countries, a.country, () => ({ code: a.country, name: a.countryName, id: a.countryId, count: 0, first: f.date, airports: new Set() }), x => { x.count++; x.airports.add(code); });
      if (a.continent) s.continents.add(a.continent);
    }
    const alKey = f.airline || '(none)';
    if (f.airline) bump(s.airlines, alKey, () => ({ name: f.airline, iata: f.airlineIata, count: 0, km: 0, first: f.date }), x => { x.count++; x.km += f.dist || 0; });
    if (f.aircraft || f.aircraftCode) {
      const k = f.aircraftCode || f.aircraft;
      bump(s.aircraft, k, () => ({ name: f.aircraft, code: f.aircraftCode, count: 0, km: 0, regs: new Set() }), x => { x.count++; x.km += f.dist || 0; if (f.registration) x.regs.add(f.registration); });
      bump(s.manufacturer, f.manufacturer, () => ({ name: f.manufacturer, count: 0 }), x => x.count++);
    }
    bump(s.routes, f.routeKey, () => ({ key: f.routeKey, a: f.A, b: f.B, path: f.path, count: 0, km: f.dist, fwd: 0, ids: [] }), x => {
      x.count++; x.ids.push(f.id); x.lastYear = f.year; if (f.from === x.a.iata) x.fwd++;
    });
    if (f.registration) s.regs.add(f.registration);
    bump(s.years, f.year, () => ({ year: f.year, count: 0, km: 0, minutes: 0 }), x => { x.count++; x.km += f.dist || 0; x.minutes += f.dur || 0; });
    const ym = `${f.year}-${f.month}`;
    s.yearMonth.set(ym, (s.yearMonth.get(ym) || 0) + 1);
    s.months[f.month]++; s.dows[f.dow]++;
    if (f.depHour != null) s.hours[f.depHour]++;
    s.seatType[f.seatType] = (s.seatType[f.seatType] || 0) + 1;
    s.cls[f.cls] = (s.cls[f.cls] || 0) + 1;
    s.reason[f.reason] = (s.reason[f.reason] || 0) + 1;
    s.haul[f.haul] = (s.haul[f.haul] || 0) + 1;
    s.alliance[f.alliance] = (s.alliance[f.alliance] || 0) + 1;
    if (f.dist != null) {
      if (!s.longest || f.dist > s.longest.dist) s.longest = f;
      if (!f.heli && (!s.shortest || f.dist < s.shortest.dist)) s.shortest = f;
      if (!s.north || f.maxLat > s.north.maxLat) s.north = f;
      if (!s.south || f.minLat < s.south.minLat) s.south = f;
    }
    if (f.dur != null && (!s.longestTime || f.dur > s.longestTime.dur)) s.longestTime = f;
  }
  return s;
}

// "Firsts" within a subset relative to everything before it (for a year in review).
export function firsts(all, subset) {
  if (!subset.length) return { airports: [], airlines: [], aircraft: [], countries: [] };
  const start = subset[0].sortTime;
  const before = all.filter(f => f.sortTime < start);
  const seen = (key) => new Set(before.flatMap(key));
  const newOf = (key) => { const s = seen(key), out = []; for (const f of subset) for (const k of key(f)) if (k && !s.has(k)) { s.add(k); out.push(k); } return out; };
  return {
    airports: newOf(f => [f.from, f.to]),
    airlines: newOf(f => [f.airline]),
    aircraft: newOf(f => [f.aircraft]),
    countries: newOf(f => [f.A.countryName, f.B.countryName].filter(c => c !== '—')),
  };
}

// ---------- journeys: consecutive legs connected within 24h through the same city
export function journeys(list) {
  const out = [];
  let cur = null;
  for (const f of list) {
    const connects = cur && (f.sortTime - cur.legs.at(-1).arrUtc) <= DAY && (f.sortTime - cur.legs.at(-1).arrUtc) > -3600000
      && cur.legs.at(-1).B.metro === f.A.metro;
    if (connects) cur.legs.push(f);
    else { cur = { legs: [f] }; out.push(cur); }
  }
  for (const j of out) {
    const first = j.legs[0], last = j.legs.at(-1);
    j.km = j.legs.reduce((t, f) => t + (f.dist || 0), 0);
    j.air = j.legs.reduce((t, f) => t + (f.dur || 0), 0);
    j.total = Math.round((last.arrUtc - first.sortTime) / 60000);
    j.direct = first.A && last.B ? (first.A.unknown || last.B.unknown ? null : haversine(first.A, last.B)) : null;
    j.stops = j.legs.slice(0, -1).map(f => f.to);
  }
  return out;
}

// ---------- delays
// How far east (+1) or west (-1) a route runs; 0 for north-south routes. Jet streams make
// eastbound flights noticeably faster than westbound ones of the same length.
export function eastward(f) {
  const dlon = ((f.B.lon - f.A.lon + 540) % 360) - 180;
  const ew = dlon * Math.cos((f.A.lat + f.B.lat) / 2 * rad) * 111.32;
  return Math.max(-1, Math.min(1, ew / f.dist));
}

// Typical gate-to-gate time, fitted to your own flights: minutes = a + km / (v + w·eastward) · 60.
// The fit minimises absolute error, so occasional delays don't drag the "typical" time up.
// Flights whose logged duration disagrees with their times + time zones are left out, because
// it's unclear which number carries the delay.
export function delayModel(flights) {
  const durOf = f => f.duration ?? f.tzDur;
  const consistent = f => !(f.duration != null && f.tzDur != null && Math.abs(f.duration - f.tzDur) > 20);
  const eligible = f => f.dist >= 150 && !f.heli && durOf(f) != null && f.dist / (durOf(f) / 60) < 1000;
  const usable = flights.filter(f => eligible(f) && consistent(f));
  const skipped = flights.filter(f => eligible(f) && !consistent(f));
  let best = { a: 40, v: 780, w: 80, err: Infinity };
  if (usable.length >= 8) {
    const pts = usable.map(f => [f.dist, eastward(f), durOf(f)]);
    for (let a = 20; a <= 70; a += 2) for (let v = 650; v <= 950; v += 10) for (let w = 0; w <= 200; w += 10) {
      let err = 0;
      for (const [km, e, d] of pts) err += Math.abs(d - (a + km / (v + w * e) * 60));
      if (err < best.err) best = { a, v, w, err };
    }
  }
  const expected = f => Math.round(best.a + f.dist / (best.v + best.w * eastward(f)) * 60);
  const rows = usable.map(f => ({ f, actual: durOf(f), expected: expected(f), delay: durOf(f) - expected(f) }));
  return { ...best, rows, skipped, expected, threshold: 20 };
}

// ---------- achievements
export function achievements(all, s) {
  const has = pred => all.filter(pred);
  const a = (id, icon, title, desc, got, progress = null) => ({ id, icon, title, desc, got: !!got, progress });
  const longHauls = has(f => f.dur >= 12 * 60);
  const nights = has(f => f.depHour != null && f.depHour < 5);
  const window = s.seatType[1] || 0;
  const pct = (v, t) => Math.max(0, Math.min(1, v / t));
  return [
    a('first', '🛫', 'Wheels up', 'Log your first flight', s.count >= 1),
    a('f50', '🎫', 'Frequent flyer', 'Log 50 flights', s.count >= 50, pct(s.count, 50)),
    a('f100', '💯', 'Centurion', 'Log 100 flights', s.count >= 100, pct(s.count, 100)),
    a('f250', '🏅', 'Road warrior', 'Log 250 flights', s.count >= 250, pct(s.count, 250)),
    a('earth', '🌍', 'Circumnavigator', `Fly the equator's length (${EARTH_KM.toLocaleString()} km)`, s.km >= EARTH_KM, pct(s.km, EARTH_KM)),
    a('earth10', '🌐', 'Ten laps', 'Fly 10× around the Earth', s.km >= EARTH_KM * 10, pct(s.km, EARTH_KM * 10)),
    a('moon', '🌙', 'Moonshot', 'Fly the distance to the Moon', s.km >= MOON_KM, pct(s.km, MOON_KM)),
    a('ulh', '⏳', 'Iron bladder', 'A single flight of 16+ hours', has(f => f.dur >= 16 * 60).length),
    a('lh10', '✈️', 'Long-haul regular', '10 flights of 12+ hours', longHauls.length >= 10, pct(longHauls.length, 10)),
    a('a380', '🐋', 'Superjumbo', 'Fly on an Airbus A380', has(f => f.aircraftCode === 'A388').length),
    a('b747', '👑', 'Queen of the Skies', 'Fly on a Boeing 747', has(f => /^B74/.test(f.aircraftCode)).length),
    a('heli', '🚁', 'Rotorhead', 'Take a helicopter flight', has(f => f.heli).length),
    a('dateline', '📅', 'Time traveller', 'Cross the International Date Line', has(f => f.dateline).length),
    a('arctic', '🧊', 'Arctic circle', 'A route that passes north of 66.5°N', has(f => f.maxLat > 66.56).length),
    a('equator', '🧭', 'Line crosser', 'Cross the equator', has(f => f.equator).length),
    a('cont3', '🗺️', 'Three continents', 'Visit airports on 3 continents', s.continents.size >= 3, pct(s.continents.size, 3)),
    a('cont5', '🌏', 'Five continents', 'Visit airports on 5 continents', s.continents.size >= 5, pct(s.continents.size, 5)),
    a('ctry10', '🛂', 'Passport stamps', 'Visit 10 countries', s.countries.size >= 10, pct(s.countries.size, 10)),
    a('ctry25', '📕', 'Full passport', 'Visit 25 countries', s.countries.size >= 25, pct(s.countries.size, 25)),
    a('ap50', '🏢', 'Terminal collector', 'Visit 50 airports', s.airports.size >= 50, pct(s.airports.size, 50)),
    a('al25', '🎨', 'Livery spotter', 'Fly 25 different airlines', s.airlines.size >= 25, pct(s.airlines.size, 25)),
    a('ac25', '🔧', 'Type rating', 'Fly 25 aircraft types', s.aircraft.size >= 25, pct(s.aircraft.size, 25)),
    a('alliances', '🤝', 'Alliance hopper', 'Fly all three alliances', ['Star Alliance', 'SkyTeam', 'oneworld'].every(k => s.alliance[k])),
    a('night', '🦉', 'Night owl', 'Five departures between midnight and 5am', nights.length >= 5, pct(nights.length, 5)),
    a('window', '🪟', 'Window warrior', 'Sit by the window 50 times', window >= 50, pct(window, 50)),
  ];
}

// ---------- data health
export function healthCheck(all) {
  const issues = [];
  const add = (severity, type, title, detail, ids, fix) => issues.push({ id: type + ':' + ids.join(','), severity, type, title, detail, ids, fix });
  const fmt = m => m == null ? '—' : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;

  // Unknown airports
  const unknown = new Map();
  for (const f of all) for (const a of [f.A, f.B]) if (a.unknown) bump(unknown, a.iata, () => ({ a, ids: [] }), x => x.ids.push(f.id));
  for (const [code, { a, ids }] of unknown)
    add('error', 'unknown-airport', `Unknown airport ${code}`, `${a.label} has no coordinates, so ${ids.length} flight(s) are missing from the map and distance totals.`, ids, { kind: 'airport', code });

  // Exact duplicates
  const keys = new Map();
  for (const f of all) bump(keys, flightKey(f), () => [], x => x.push(f));
  for (const [, fs] of keys) if (fs.length > 1)
    add('error', 'duplicate', `Duplicate: ${fs[0].flightNumber || 'flight'} on ${fs[0].date}`, `${fs.length} identical entries for ${fs[0].from} → ${fs[0].to}.`, fs.map(f => f.id), { kind: 'delete', id: fs.at(-1).id, label: 'Delete the extra copy' });

  for (const f of all) {
    // Logged duration disagrees with local times + time zones
    if (f.duration != null && f.tzDur != null && Math.abs(f.duration - f.tzDur) > 20)
      add('warn', 'tz-mismatch', `${f.flightNumber || 'Flight'} ${f.from}→${f.to} on ${f.date}: duration doesn't match times`,
        `Logged ${fmt(f.duration)}, but ${f.depTime} (${f.A.tz}) → ${f.arrTime} (${f.B.tz}) is ${fmt(f.tzDur)}. One of the times or the duration is probably off.`,
        [f.id], { kind: 'patch', id: f.id, patch: { duration: f.tzDur }, label: `Set duration to ${fmt(f.tzDur)}` });
    // Implausible speed for the distance
    if (f.dist > 150 && f.dur && !f.heli) {
      const exp = estimateDuration(f.dist), speed = f.dist / (f.dur / 60);
      if (f.dur < exp * 0.65 || speed > 1000)
        add('warn', 'too-fast', `${f.flightNumber || 'Flight'} ${f.from}→${f.to} on ${f.date} is implausibly fast`,
          `${Math.round(f.dist).toLocaleString()} km in ${fmt(f.dur)} is ${Math.round(speed)} km/h block speed. A typical time for this distance is about ${fmt(exp)}.`, [f.id]);
      else if (f.dur > exp * 1.6 + 30)
        add('info', 'too-slow', `${f.flightNumber || 'Flight'} ${f.from}→${f.to} on ${f.date} took unusually long`,
          `${fmt(f.dur)} for ${Math.round(f.dist).toLocaleString()} km (typical ≈ ${fmt(exp)}). Fine if it was delayed or diverted, otherwise check it.`, [f.id]);
    }
    if (f.depTime === '00:00' && (!f.arrTime || f.arrTime === '00:00'))
      add('info', 'no-times', `${f.flightNumber || 'Flight'} ${f.from}→${f.to} on ${f.date} has placeholder times`, 'Both times are 00:00, so overlap and connection checks skip this flight.', [f.id]);
  }

  // Sequence checks between consecutive flights
  for (let i = 1; i < all.length; i++) {
    const p = all[i - 1], n = all[i];
    if (p.depUtc == null || n.depUtc == null) continue;
    const gapH = (n.depUtc - p.arrUtc) / 3600000;
    const moved = p.B.metro !== n.A.metro;
    if (gapH < -0.1)
      add('error', 'overlap', `Overlapping flights on ${n.date}`,
        `${p.flightNumber} ${p.from}→${p.to} is still in the air when ${n.flightNumber} ${n.from}→${n.to} departs. Check the dates, times, or direction.`, [p.id, n.id]);
    else if (moved && !p.B.unknown && !n.A.unknown && gapH < 36) {
      const km = haversine(p.B, n.A);
      if (km > 150 && km / Math.max(gapH, 0.1) > 700)
        add('warn', 'teleport', `Impossible hop: ${p.to} → ${n.from}`,
          `You land at ${p.to} and ${gapH.toFixed(1)} h later depart ${n.from}, ${Math.round(km).toLocaleString()} km away. Is a flight missing, or is a date wrong?`, [p.id, n.id]);
    }
  }

  // Same flight number + same direction twice within 2 weeks with no way back: likely a mis-entered return
  const byNum = new Map();
  for (const f of all) if (f.flightNumber) bump(byNum, f.flightNumber + f.from + f.to, () => [], x => x.push(f));
  for (const [, fs] of byNum) for (let i = 1; i < fs.length; i++) {
    const a = fs[i - 1], b = fs[i];
    const days = (b.sortTime - a.sortTime) / DAY;
    if (days < 0.5 || days > 14) continue;
    const between = all.filter(f => f.sortTime > a.sortTime && f.sortTime < b.sortTime);
    const back = between.some(f => f.A.metro === a.B.metro);
    if (!back)
      add('warn', 'no-return', `${a.flightNumber} ${a.from}→${a.to} logged twice, ${Math.round(days)} days apart`,
        `No flight leaves ${a.to} in between, so the second entry may have been meant as the return (${a.to}→${a.from}).`, [a.id, b.id],
        { kind: 'edit', id: b.id, patch: { from: b.to, to: b.from }, label: `Edit ${b.date} as the return ${b.to}→${b.from}` });
  }

  const sev = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => sev[a.severity] - sev[b.severity]);
}
