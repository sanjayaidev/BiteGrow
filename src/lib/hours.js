'use strict';
// Opening hours: how the owner's schedule is stored, validated and understood.
//
// Storage lives in bg_tenant_settings (see db/005_hours_schedule_reports.sql):
//   open_hours     jsonb  { "mon": [{open:"11:30", close:"22:00"}], ..., "sun": [] }
//                          A day with an empty list is closed that day. Missing keys fall back to the weekly default.
//   open_note      text   free line shown under the hours ("last orders 30 min before close")
//   pause_orders   boolean manual "closed / not taking orders" switch, independent of the schedule
//   pause_until    text   optional ISO date-time; the pause lifts by itself after that moment
//
// All times are local wall-clock times in the restaurant's timezone (bg_tenants.timezone),
// so a kitchen in Dubai and one in London can both say "opens 11:30".

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];   // getDay() order
const DAY_LABEL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const WEEK_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;                     // "09:30", "9:30", "22:00"

const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// ---- reading the settings row ---------------------------------------------------------
// Accepts the raw database row or a shaped tenant object ({ settings: {...} }).
function scheduleFrom(rawSettings) {
  const s = rawSettings && rawSettings.settings ? rawSettings.settings : (rawSettings || {});
  return {
    days: s.open_hours && typeof s.open_hours === 'object' ? s.open_hours : null,
    note: s.open_note || '',
    paused: !!s.pause_orders,
    until: s.pause_until || null,
    timezone: (rawSettings && rawSettings.timezone) || s.timezone || 'UTC',
  };
}

// One IANA timezone offset check per call is plenty; Intl is slow, so results are cached.
const offsetCache = new Map();
function tzOffsetMs(timezone, atMs) {
  const key = `${timezone}|${Math.floor(atMs / 3_600_000)}`;   // bucketed per hour
  let hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(atMs));
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    let hour = g('hour'); if (hour === 24) hour = 0;
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), hour, g('minute'), g('second'));
    hit = asUtc - Math.floor(atMs / 1000) * 1000;
  } catch (e) { hit = 0; }                                     // unknown zone -> treat as UTC
  offsetCache.set(key, hit);
  if (offsetCache.size > 5000) offsetCache.clear();
  return hit;
}

// The restaurant's local wall clock right now: { ms, y, mo, d, hm, dow }.
// dow matches Date#getDay in the restaurant's timezone (0 = Sunday).
function localNow(timezone, instant = new Date()) {
  const ms = instant instanceof Date ? instant.getTime() : Number(instant);
  const off = tzOffsetMs(timezone, ms);
  const shifted = new Date(ms + off);
  return {
    ms,
    y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(),
    hm: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    dow: DAYS[shifted.getUTCDay()],
    iso: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`,
  };
}

// Local midnight of the given local calendar day, as a real timestamp (ms). Used for reports:
// "today's sales" must mean today in the restaurant's own timezone, not in the server's.
function localMidnightMs(timezone, y, mo, d) {
  const guess = Date.UTC(y, mo - 1, d) - tzOffsetMs(timezone, Date.UTC(y, mo - 1, d));
  // Re-check with the offset actually in force at the guessed instant (DST edges).
  return Date.UTC(y, mo - 1, d) - tzOffsetMs(timezone, guess);
}

// The window for a day: entries plus their minute ranges, ignoring nonsense rows.
function windowsFor(dayList) {
  const list = Array.isArray(dayList) ? dayList : [];
  const out = [];
  for (const w of list) {
    if (!w || !TIME_RE.test(w.open || '') || !TIME_RE.test(w.close || '')) continue;
    const o = minutesOf(w.open), c = minutesOf(w.close);
    out.push({ ...w, oMin: o, cMin: c, spansMidnight: c <= o });
  }
  return out;
}

// Is this local time inside any of the day's windows? Closes that pass midnight count the early hours too.
function inWindow(win, hm) {
  return win.spansMidnight ? (hm >= win.oMin || hm < win.cMin) : (hm >= win.oMin && hm < win.cMin);
}

// True when the owner configured a schedule at all. Legacy tenants that predate the hours
// feature (open_hours missing or an empty object {}) must keep accepting orders — only an
// explicit schedule can close them. A saved schedule counts even when every day is an empty
// list: that is the owner deliberately closing every day, not a missing schedule.
function hasSchedule(schedule) {
  const days = schedule.days;
  if (!days || typeof days !== 'object') return false;
  return Object.keys(days).some((k) => k === 'default' || DAYS.includes(k));
}

// What the schedule says about one moment.
//   { open, reason?, closesAt?, opensAt?, message }
// reason: 'paused' | 'closed_day' | 'before_open' | 'after_close'
function statusAt(schedule, local) {
  const note = schedule.note ? ` (${schedule.note})` : '';
  if (!hasSchedule(schedule)) return { open: true, reason: 'no_schedule', message: 'Open now' };
  if (schedule.paused) {
    const until = schedule.until ? new Date(schedule.until) : null;
    if (until && !isNaN(until) && until.getTime() <= local.ms) {
      // the timed pause has passed: it lifts on its own, even before the page reloads
    } else {
      const when = until && !isNaN(until) ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: schedule.timezone }).format(until) : '';
      return { open: false, reason: 'paused', message: `Not taking orders right now${when ? `. We expect to be back around ${when}` : ''}.` };
    }
  }

  const days = schedule.days || {};
  const todays = DAYS.includes(local.dow) ? days[local.dow] : undefined;
  const list = windowsFor(Array.isArray(todays) ? todays : days.default);
  if (!list.length) return { open: false, reason: 'closed_day', message: `We are closed today${note}.` };

  for (const w of list) if (inWindow(w, local.hm)) {
    const closing = list.filter((x) => x.oMin <= local.hm && (x.spansMidnight || x.cMin > local.hm))
      .sort((a, b) => (a.spansMidnight ? a.cMin + 1440 : a.cMin) - (b.spansMidnight ? b.cMin + 1440 : b.cMin))[0];
    return { open: true, closesAt: closing ? hhmm(closing.cMin) : null, message: 'Open now' + (closing ? ` — until ${hhmm(closing.cMin)}` : '') + '.' };
  }

  // Not inside a window: the next opening later today, else tomorrow's first window.
  const upcomingToday = list.filter((w) => !w.spansMidnight && w.oMin > local.hm).sort((a, b) => a.oMin - b.oMin)[0];
  if (upcomingToday) return { open: false, reason: 'before_open', opensAt: hhmm(upcomingToday.oMin), message: `We open at ${hhmm(upcomingToday.oMin)} today${note}.` };
  const idx = DAYS.indexOf(local.dow);
  for (let i = 1; i <= 7; i++) {
    const day = DAYS[(idx + i) % 7];
    const wl = windowsFor(Array.isArray(days[day]) ? days[day] : days.default);
    const first = wl.sort((a, b) => a.oMin - b.oMin)[0];
    if (first) {
      const label = i === 1 ? 'tomorrow' : DAY_LABEL[day];
      return { open: false, reason: i === 1 ? 'after_close' : 'before_open', opensAt: hhmm(first.oMin), opensDay: label, message: `We are closed right now. ${label} we open at ${hhmm(first.oMin)}${note}.` };
    }
    if (i === 7) break;
  }
  return { open: false, reason: 'closed_day', message: `We are closed${note}.` };
}

// Convenience: schedule row + instant -> status. The instant may also be given as the second
// argument of an object-style call ({ settings, timezone }, now) — both shapes are used.
function isOpen(settingsRow, instant = new Date()) {
  let raw = settingsRow;
  let at = instant;
  if (settingsRow && typeof settingsRow === 'object' && !(settingsRow instanceof Date)
    && !Array.isArray(settingsRow) && ('settings' in settingsRow || 'timezone' in settingsRow)) {
    raw = settingsRow.settings;                 // camelCase fields ride along inside settings too;
    at = settingsRow.now || instant;            // scheduleFrom reads them as a last resort
  }
  const sch = scheduleFrom(raw);
  return statusAt(sch, localNow(sch.timezone, at));
}

// Human lines for the storefront footer, the assistant prompt and the admin preview.
function formatLines(schedule, local) {
  const days = schedule.days || {};
  const lines = [];
  for (const d of WEEK_ORDER) {
    const wl = windowsFor(Array.isArray(days[d]) ? days[d] : days.default);
    lines.push(`${DAY_LABEL[d].slice(0, 3)}: ${wl.length ? wl.map((w) => `${w.open}${w.spansMidnight ? ' → next day' : ''}–${w.close}`).join(', ') : 'Closed'}`);
  }
  if (schedule.note) lines.push(schedule.note);
  return lines;
}

// Validates what the admin sends (PUT /api/admin/settings -> open_hours).
// Returns { hours } or { error }. An empty array means closed that day; a "default" key is the
// fallback for any day without its own entry. Times are normalised to "HH:MM".
function validateSchedule(input) {
  if (input === null || input === '') return { hours: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'Opening hours must be a list of days' };
  for (const k of Object.keys(input)) {
    if (k !== 'default' && !DAYS.includes(k)) return { error: 'Unknown day in opening hours' };
    if (!Array.isArray(input[k])) return { error: `Hours for ${k} must be a list of time ranges` };
    if (input[k].length > 6) return { error: `At most 6 time ranges per day (${k})` };
  }
  const out = {};
  for (const [k, list] of Object.entries(input)) {
    const ranges = [];
    for (let i = 0; i < list.length; i++) {
      const w = list[i] || {};
      const open = String(w.open || ''), close = String(w.close || '');
      if (!TIME_RE.test(open) || !TIME_RE.test(close)) return { error: `${k} range ${i + 1}: times must look like 09:30 and 22:00` };
      ranges.push({ open: open.padStart(5, '0'), close: close.padStart(5, '0') });
    }
    out[k] = ranges;
  }
  return { hours: out };
}

// The schedule a storefront or report can rely on: every day present, default applied where missing.
function normalizeSchedule(days) {
  const src = days && typeof days === 'object' ? days : {};
  const def = Array.isArray(src.default) ? src.default : null;
  const out = {};
  for (const d of DAYS) out[d] = Array.isArray(src[d]) ? src[d] : (def ? [...def] : []);
  if (def) out.default = [...def];
  return out;
}

module.exports = { DAYS, DAY_LABEL, WEEK_ORDER, TIME_RE, minutesOf, hhmm, scheduleFrom, localNow, localMidnightMs, windowsFor, statusAt, isOpen, hasSchedule, formatLines, validateSchedule, normalizeSchedule };
