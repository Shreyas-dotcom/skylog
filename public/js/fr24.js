// Reads and writes the myFlightradar24 "flight diary" CSV format.
// Shared by the browser app and the Node server (used to seed the first run).

export const SEAT_TYPES = { 0: '', 1: 'Window', 2: 'Middle', 3: 'Aisle', 4: 'Pilot seat', 5: 'Crew seat' };
export const CLASSES = { 0: '', 1: 'Economy', 2: 'Business', 3: 'First', 4: 'Economy+', 5: 'Private' };
export const REASONS = { 0: '', 1: 'Leisure', 2: 'Business', 3: 'Crew', 4: 'Other' };

const HEADER = ['Date', 'Flight number', 'From', 'To', 'Dep time', 'Arr time', 'Duration', 'Airline', 'Aircraft',
  'Registration', 'Seat number', 'Seat type', 'Flight class', 'Flight reason', 'Note',
  'Dep_id', 'Arr_id', 'Airline_id', 'Aircraft_id'];

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

// "Tokyo / Haneda (HND/RJTT)" -> { iata: 'HND', icao: 'RJTT', label: 'Tokyo / Haneda' }
export function parseAirportField(s = '') {
  const m = s.match(/^(.*)\(([A-Z0-9]*)\/([A-Z0-9]*)\)\s*$/);
  if (!m) return { iata: s.trim().toUpperCase().slice(0, 4), icao: '', label: s.trim() };
  return { iata: m[2], icao: m[3], label: m[1].trim() };
}

// "Japan Airlines (JL/JAL)" -> { name, iata, icao }
export function parseAirline(s = '') {
  const m = s.match(/^(.*)\(([A-Z0-9]*)\/([A-Z0-9]*)\)\s*$/);
  if (!m) return { name: s.trim(), iata: '', icao: '' };
  return { name: m[1].trim(), iata: m[2], icao: m[3] };
}

// "Boeing 777-300ER (B77W)" -> { name, code }
export function parseAircraft(s = '') {
  const m = s.match(/^(.*)\(([A-Z0-9]*)\)\s*$/);
  if (!m) return { name: s.trim(), code: '' };
  return { name: m[1].trim(), code: m[2] };
}

export function hmsToMinutes(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return +m[1] * 60 + +m[2];
}

export function minutesToHms(min) {
  if (min == null || isNaN(min)) return '';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

const hhmm = s => (s && /^\d{1,2}:\d{2}/.test(s)) ? s.slice(0, 5).padStart(5, '0') : '';

export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function flightKey(f) {
  return [f.date, (f.flightNumber || '').toUpperCase(), f.from, f.to].join('|');
}

export function fromFR24CSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { flights: [], airportsSeen: {} };
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = name => head.indexOf(name.toLowerCase());
  if (col('date') < 0 || col('from') < 0 || col('to') < 0) {
    throw new Error('This does not look like a myFlightradar24 CSV (missing Date/From/To columns).');
  }
  const get = (r, name) => { const i = col(name); return i < 0 ? '' : (r[i] || '').trim(); };
  const airportsSeen = {};
  const flights = rows.slice(1).map(r => {
    const from = parseAirportField(get(r, 'From'));
    const to = parseAirportField(get(r, 'To'));
    for (const a of [from, to]) if (a.iata) airportsSeen[a.iata] = a;
    const al = parseAirline(get(r, 'Airline'));
    const ac = parseAircraft(get(r, 'Aircraft'));
    return {
      id: newId(),
      date: get(r, 'Date'),
      flightNumber: get(r, 'Flight number').toUpperCase(),
      from: from.iata || from.icao,
      to: to.iata || to.icao,
      depTime: hhmm(get(r, 'Dep time')),
      arrTime: hhmm(get(r, 'Arr time')),
      duration: hmsToMinutes(get(r, 'Duration')),
      airline: al.name, airlineIata: al.iata, airlineIcao: al.icao,
      aircraft: ac.name, aircraftCode: ac.code,
      registration: get(r, 'Registration').toUpperCase(),
      seat: get(r, 'Seat number'),
      seatType: +get(r, 'Seat type') || 0,
      cls: +get(r, 'Flight class') || 0,
      reason: +get(r, 'Flight reason') || 0,
      note: get(r, 'Note'),
    };
  }).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f.date) && f.from && f.to);
  return { flights, airportsSeen };
}

const q = v => {
  v = v == null ? '' : String(v);
  return /[",\n]/.test(v) || v.includes(' ') || v.includes('/') ? `"${v.replace(/"/g, '""')}"` : v;
};

// apInfo(code) -> { label: 'Tokyo / Haneda', icao: 'RJTT' }
export function toFR24CSV(flights, apInfo) {
  const lines = [HEADER.map(q).join(',')];
  const ap = code => { const a = apInfo(code); return `${a.label} (${code}/${a.icao || ''})`; };
  for (const f of flights) {
    lines.push([
      f.date, f.flightNumber, ap(f.from), ap(f.to),
      f.depTime ? f.depTime + ':00' : '', f.arrTime ? f.arrTime + ':00' : '', minutesToHms(f.duration),
      f.airline || f.airlineIata ? `${f.airline} (${f.airlineIata || ''}/${f.airlineIcao || ''})` : '',
      f.aircraft || f.aircraftCode ? `${f.aircraft} (${f.aircraftCode || ''})` : '',
      f.registration, f.seat, f.seatType || '', f.cls || '', f.reason || '', f.note, '', '', '', '',
    ].map(q).join(','));
  }
  return lines.join('\n') + '\n';
}
