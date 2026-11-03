// Slot engine (SCH-5, SCH-6, SCH-8). Pure functions: no database, no clock.
//
// An attendee model looks like:
//   { id, tz, hours: { mon: [['10:00','16:00']], ... }, maxPerDay, maxPerWeek,
//     bufferMin, busy: [{ start, end }], interviews: [{ start }], holidays: Set<'YYYY-MM-DD'> }
//
// A slot is offered only when every required attendee is inside their
// interview hours, outside every busy block (plus buffer), off their holidays,
// and under their daily and weekly interview caps.

import {
  DAY_KEYS, addDaysKey, dateKey, hhmmToMin, parts, startOfDayKey, weekKey, weekdayOfKey,
} from './tz.js';

const MIN = 60_000;

export const PARTS_OF_DAY = {
  morning: [8 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 20 * 60],
};

/** Normalise an attendee model (minutes, counts) for conflict checks. */
export function prepareAttendee(a) {
  const dayCounts = new Map();
  const weekCounts = new Map();
  for (const iv of a.interviews || []) {
    const dk = dateKey(iv.start, a.tz);
    const wk = weekKey(iv.start, a.tz);
    dayCounts.set(dk, (dayCounts.get(dk) || 0) + 1);
    weekCounts.set(wk, (weekCounts.get(wk) || 0) + 1);
  }
  const hours = {};
  for (const k of DAY_KEYS) {
    hours[k] = (a.hours?.[k] || []).map(([s, e]) => [hhmmToMin(s), hhmmToMin(e)]);
  }
  return { ...a, hours, dayCounts, weekCounts, holidays: a.holidays || new Set(), busy: a.busy || [] };
}

/** Why `a` cannot take [start, end), or null when they can. */
export function attendeeConflict(a, start, end, { ignoreHours = false } = {}) {
  const p = parts(start, a.tz);
  const dk = dateKey(start, a.tz);
  if (a.holidays.has(dk)) return 'holiday';
  if (!ignoreHours) {
    const s = p.h * 60 + p.mi;
    const e = s + (end - start) / MIN;
    const ranges = a.hours[DAY_KEYS[p.wd]];
    if (!ranges.some(([rs, re]) => s >= rs && e <= re)) return 'outside_hours';
  }
  const buf = (a.bufferMin || 0) * MIN;
  if (a.busy.some((b) => start < b.end + buf && end > b.start - buf)) return 'busy';
  if (a.maxPerDay != null && (a.dayCounts.get(dk) || 0) >= a.maxPerDay) return 'daily_cap';
  const wk = weekKey(start, a.tz);
  if (a.maxPerWeek != null && (a.weekCounts.get(wk) || 0) >= a.maxPerWeek) return 'weekly_cap';
  return null;
}

/** Does the slot satisfy the user's constraints (days, part of day, date range)? */
export function meetsConstraints(start, end, c, fallbackTz) {
  if (!c) return true;
  const tz = c.tz || fallbackTz;
  const p = parts(start, tz);
  const day = DAY_KEYS[p.wd];
  if (c.days?.length && !c.days.includes(day)) return false;
  if (c.excludeDays?.length && c.excludeDays.includes(day)) return false;
  const s = p.h * 60 + p.mi;
  const e = s + (end - start) / MIN;
  if (c.fromMin != null && s < c.fromMin) return false;
  if (c.toMin != null && e > c.toMin) return false;
  const dk = dateKey(start, tz);
  if (c.notBefore && dk < c.notBefore) return false;
  if (c.notAfter && dk > c.notAfter) return false;
  return true;
}

/**
 * Compute every bookable slot.
 * @returns {{start:number,end:number,optional:string[]}[]}
 */
export function computeSlots({
  required, optional = [], durationMin, windowStart, windowEnd,
  stepMin = 30, constraints = null, constraintTz,
}) {
  const req = required.map(prepareAttendee);
  const opt = optional.map(prepareAttendee);
  const dur = durationMin * MIN;
  const step = stepMin * MIN;
  const tz = constraintTz || req[0]?.tz || 'UTC';
  const out = [];
  for (let t = Math.ceil(windowStart / step) * step; t + dur <= windowEnd; t += step) {
    const end = t + dur;
    if (!meetsConstraints(t, end, constraints, tz)) continue;
    if (req.some((a) => attendeeConflict(a, t, end))) continue;
    out.push({ start: t, end, optional: opt.filter((a) => !attendeeConflict(a, t, end)).map((a) => a.id) });
  }
  return out;
}

/**
 * End of a window that spans `workingDays` Mon–Fri days (skipping holidays)
 * in `tz`, starting from the local day of `fromMs`.
 */
export function workingDaysWindowEnd(fromMs, workingDays, tz, holidays = new Set()) {
  let key = dateKey(fromMs, tz);
  let counted = 0;
  for (let i = 0; i < 60; i++) {
    const wd = weekdayOfKey(key);
    if (wd >= 1 && wd <= 5 && !holidays.has(key)) counted++;
    if (counted >= workingDays) return startOfDayKey(addDaysKey(key, 1), tz);
    key = addDaysKey(key, 1);
  }
  return startOfDayKey(key, tz);
}
