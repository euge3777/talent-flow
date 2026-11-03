// Natural-language scheduling constraints (SCH-23).
// Turns phrases like "mornings PT, not Friday, after the 12th" into the
// structured filter the slot engine understands, and reports back what it
// understood so the user can check it.

import { DAY_KEYS, addDaysKey, dateKey, hhmmToMin, isValidTz, minToHhmm, weekdayOfKey } from './tz.js';
import { PARTS_OF_DAY } from './slots.js';

const ZONES = {
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', eastern: 'America/New_York',
  gmt: 'Europe/London', bst: 'Europe/London', uk: 'Europe/London', london: 'Europe/London',
  cet: 'Europe/Berlin', cest: 'Europe/Berlin',
  sgt: 'Asia/Singapore', singapore: 'Asia/Singapore',
  ist: 'Asia/Kolkata', india: 'Asia/Kolkata',
  aest: 'Australia/Sydney', sydney: 'Australia/Sydney',
  utc: 'UTC',
};

const DAY_WORDS = {
  sun: 'sun', sunday: 'sun', mon: 'mon', monday: 'mon', tue: 'tue', tues: 'tue', tuesday: 'tue',
  wed: 'wed', wednesday: 'wed', thu: 'thu', thur: 'thu', thurs: 'thu', thursday: 'thu',
  fri: 'fri', friday: 'fri', sat: 'sat', saturday: 'sat',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function clockToMin(h, m, ampm) {
  let hour = Number(h);
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return hour * 60 + Number(m || 0);
}

/** Resolve "12th" or "Nov 12" to a date key on or after today. */
function resolveDay(todayKey, day, monthWord) {
  const [y, m, d] = todayKey.split('-').map(Number);
  if (monthWord) {
    const mi = MONTHS.indexOf(monthWord.slice(0, 3));
    let year = y;
    if (mi + 1 < m || (mi + 1 === m && day < d)) year++;
    return `${year}-${String(mi + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  let year = y;
  let month = m;
  if (day < d) {
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * @param {string} text
 * @param {{ now: number, tz: string }} ctx  tz = the zone the speaker means by default
 * @returns {{ constraints: object, understood: string[] }}
 */
export function parseConstraints(text, { now, tz }) {
  const c = {};
  const understood = [];
  if (!text || !text.trim()) return { constraints: c, understood };
  const s = ` ${text.toLowerCase().replace(/[,;.!?]/g, ' ')} `;

  // Time zone: an IANA name or a common abbreviation.
  const iana = text.match(/\b([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/);
  if (iana && isValidTz(iana[1])) c.tz = iana[1];
  else {
    for (const [word, zone] of Object.entries(ZONES)) {
      if (new RegExp(`\\s${word}\\s`).test(s)) { c.tz = zone; break; }
    }
  }
  const zone = c.tz || tz;
  if (c.tz) understood.push(`times in ${c.tz}`);

  // Part of day.
  for (const [part, [from, to]] of Object.entries(PARTS_OF_DAY)) {
    if (new RegExp(`\\s${part}s?\\s`).test(s)) {
      c.fromMin = from;
      c.toMin = to;
      understood.push(`${part}s (${minToHhmm(from)}–${minToHhmm(to)})`);
    }
  }
  const after = s.match(/\s(?:after|from)\s(\d{1,2})(?::(\d{2}))?\s?(am|pm)\s/);
  if (after) {
    c.fromMin = clockToMin(after[1], after[2], after[3]);
    understood.push(`starting ${minToHhmm(c.fromMin)} or later`);
  }
  const before = s.match(/\s(?:before|until|by)\s(\d{1,2})(?::(\d{2}))?\s?(am|pm)\s/);
  if (before) {
    c.toMin = clockToMin(before[1], before[2], before[3]);
    understood.push(`ending by ${minToHhmm(c.toMin)}`);
  }

  // Days of the week: "not Friday" excludes, a bare day name includes.
  const exclude = new Set();
  const include = new Set();
  const negRe = /\s(?:not|no|except|excluding|avoid|skip)\s(?:on\s)?([a-z]+)/g;
  let mm;
  while ((mm = negRe.exec(s))) {
    const word = mm[1].replace(/s$/, '');
    if (DAY_WORDS[word] || DAY_WORDS[mm[1]]) exclude.add(DAY_WORDS[word] || DAY_WORDS[mm[1]]);
  }
  for (const word of s.split(/\s+/)) {
    const day = DAY_WORDS[word] || DAY_WORDS[word.replace(/s$/, '')];
    if (day && !exclude.has(day)) include.add(day);
  }
  if (exclude.size) {
    c.excludeDays = [...exclude];
    understood.push(`not ${[...exclude].join(', ')}`);
  }
  if (include.size) {
    c.days = DAY_KEYS.filter((d) => include.has(d));
    understood.push(`only ${c.days.join(', ')}`);
  }

  // Date range.
  const today = dateKey(now, zone);
  const monday = addDaysKey(today, -((weekdayOfKey(today) + 6) % 7));
  if (/\sthis week\s/.test(s)) {
    c.notAfter = addDaysKey(monday, 6);
    understood.push(`this week (until ${c.notAfter})`);
  }
  if (/\snext week\s/.test(s)) {
    c.notBefore = addDaysKey(monday, 7);
    c.notAfter = addDaysKey(monday, 13);
    understood.push(`next week (${c.notBefore} to ${c.notAfter})`);
  }
  if (/\stomorrow\s/.test(s)) {
    c.notBefore = c.notAfter = addDaysKey(today, 1);
    understood.push(`tomorrow (${c.notBefore})`);
  }
  const monthAlt = MONTHS.map((x) => `${x}[a-z]*`).join('|');
  const afterDate = s.match(new RegExp(`\\s(after|from|on or after)\\s(?:the\\s)?(?:(${monthAlt})\\s)?(\\d{1,2})(?:st|nd|rd|th)?\\s(?!am|pm|:)`));
  if (afterDate) {
    const key = resolveDay(today, Number(afterDate[3]), afterDate[2]);
    c.notBefore = afterDate[1] === 'after' ? addDaysKey(key, 1) : key;
    understood.push(`from ${c.notBefore}`);
  }
  const beforeDate = s.match(new RegExp(`\\s(before|until|by)\\s(?:the\\s)?(?:(${monthAlt})\\s)?(\\d{1,2})(?:st|nd|rd|th)?\\s(?!am|pm|:)`));
  if (beforeDate) {
    const key = resolveDay(today, Number(beforeDate[3]), beforeDate[2]);
    c.notAfter = beforeDate[1] === 'before' ? addDaysKey(key, -1) : key;
    understood.push(`until ${c.notAfter}`);
  }

  if (c.fromMin != null || c.toMin != null || c.days || c.excludeDays) c.tz = zone;
  return { constraints: c, understood };
}

/** Merge structured constraints over parsed ones (structured wins). */
export function mergeConstraints(parsed, structured) {
  const out = { ...parsed };
  for (const [k, v] of Object.entries(structured || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  if (typeof out.fromMin === 'string') out.fromMin = hhmmToMin(out.fromMin);
  if (typeof out.toMin === 'string') out.toMin = hhmmToMin(out.toMin);
  return out;
}
