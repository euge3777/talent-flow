// Time-zone helpers built on Intl, so the app needs no date libraries.
// Every timestamp in the system is UTC milliseconds; these helpers convert
// to and from "wall-clock" time in a named IANA zone.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const partsFormatters = new Map();

function partsFormatter(tz) {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

export function isValidTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of a UTC instant in `tz`. wd: 0 = Sunday. */
export function parts(ms, tz) {
  const o = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return {
    y: +o.year, m: +o.month, d: +o.day,
    h: +o.hour % 24, mi: +o.minute, s: +o.second,
    wd: WEEKDAYS.indexOf(o.weekday),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds. */
export function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  const whole = Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - whole;
}

/** UTC instant for a wall-clock time in `tz` (DST-aware). */
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date of an instant, as 'YYYY-MM-DD'. */
export function dateKey(ms, tz) {
  const p = parts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function addDaysKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOfKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the local week containing `ms`, as 'YYYY-MM-DD'. */
export function weekKey(ms, tz) {
  const key = dateKey(ms, tz);
  return addDaysKey(key, -((weekdayOfKey(key) + 6) % 7));
}

/** UTC instant of local midnight at the start of date `key` in `tz`. */
export function startOfDayKey(key, tz) {
  const [y, m, d] = key.split('-').map(Number);
  return zonedToUtc(y, m, d, 0, 0, tz);
}

export function minutesOfDay(ms, tz) {
  const p = parts(ms, tz);
  return p.h * 60 + p.mi;
}

export function hhmmToMin(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function minToHhmm(min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** Human format such as "Tue 10 Nov, 10:00 PST". */
export function formatInTz(ms, tz, { withZone = true, withDate = true } = {}) {
  const opts = { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (withDate) Object.assign(opts, { weekday: 'short', day: 'numeric', month: 'short' });
  if (withZone) opts.timeZoneName = 'short';
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms));
}
