// Unit tests: time zones, slot engine, natural-language constraints.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, formatInTz, parts, weekKey, zonedToUtc } from '../src/tz.js';
import { attendeeConflict, computeSlots, prepareAttendee, workingDaysWindowEnd } from '../src/slots.js';
import { parseConstraints } from '../src/constraints.js';

const LA = 'America/Los_Angeles';
const H = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

test('zonedToUtc handles both sides of a DST change', () => {
  // US DST ended 2026-11-01. 09:00 PDT before, 09:00 PST after.
  assert.equal(iso(zonedToUtc(2026, 10, 30, 9, 0, LA)), '2026-10-30T16:00:00.000Z');
  assert.equal(iso(zonedToUtc(2026, 11, 2, 9, 0, LA)), '2026-11-02T17:00:00.000Z');
  assert.equal(iso(zonedToUtc(2026, 11, 2, 9, 0, 'Asia/Kolkata')), '2026-11-02T03:30:00.000Z');
});

test('parts, dateKey and weekKey are local to the zone', () => {
  const t = Date.parse('2026-11-10T06:30:00Z'); // Mon 22:30 PST, Tue 14:30 SGT
  assert.equal(dateKey(t, LA), '2026-11-09');
  assert.equal(dateKey(t, 'Asia/Singapore'), '2026-11-10');
  assert.equal(parts(t, LA).wd, 1);
  assert.equal(weekKey(t, LA), '2026-11-09');
  assert.match(formatInTz(t, LA), /Mon, Nov 9, 22:30 PST/);
});

const tueToThu = { tue: [['10:00', '16:00']], wed: [['10:00', '16:00']], thu: [['10:00', '16:00']] };
const marcus = (extra = {}) => ({ id: 'm', tz: LA, hours: tueToThu, maxPerDay: 3, maxPerWeek: 8, bufferMin: 10, busy: [], interviews: [], ...extra });
const tue = (h, m = 0) => zonedToUtc(2026, 11, 10, h, m, LA);

test('slots stay inside interview hours', () => {
  const slots = computeSlots({ required: [marcus()], durationMin: 60, windowStart: tue(0), windowEnd: tue(23) });
  assert.equal(slots.length, 11); // 10:00, 10:30 ... 15:00
  assert.equal(iso(slots[0].start), iso(tue(10)));
  assert.equal(iso(slots.at(-1).end), iso(tue(16)));
});

test('busy blocks and buffers remove slots', () => {
  const busy = [{ start: tue(12), end: tue(13) }];
  const slots = computeSlots({ required: [marcus({ busy })], durationMin: 30, windowStart: tue(0), windowEnd: tue(23) });
  const starts = slots.map((s) => iso(s.start));
  assert.ok(starts.includes(iso(tue(11))));          // 11:00–11:30, 30 min clear of 12:00
  assert.ok(!starts.includes(iso(tue(11, 30))));     // ends 12:00, inside 10-min buffer
  assert.ok(!starts.includes(iso(tue(13))));         // starts at 13:00, inside buffer
  assert.ok(starts.includes(iso(tue(13, 30))));
});

test('daily and weekly caps', () => {
  const interviews = [{ start: tue(10) }, { start: tue(11) }, { start: tue(14) }];
  const a = prepareAttendee(marcus({ interviews }));
  assert.equal(attendeeConflict(a, tue(15), tue(15, 30)), 'daily_cap');
  const wed = zonedToUtc(2026, 11, 11, 10, 0, LA);
  assert.equal(attendeeConflict(a, wed, wed + H / 2), null);
  const full = prepareAttendee(marcus({ maxPerWeek: 3, interviews }));
  assert.equal(attendeeConflict(full, wed, wed + H / 2), 'weekly_cap');
});

test('holidays block the whole day', () => {
  const a = prepareAttendee(marcus({ holidays: new Set(['2026-11-10']) }));
  assert.equal(attendeeConflict(a, tue(10), tue(11)), 'holiday');
});

test('every required attendee must be free; optional ones are reported per slot', () => {
  const riya = { id: 'r', tz: LA, hours: { tue: [['09:00', '17:00']] }, busy: [{ start: tue(10), end: tue(11) }], interviews: [], bufferMin: 0 };
  const slots = computeSlots({ required: [marcus()], optional: [riya], durationMin: 30, windowStart: tue(0), windowEnd: tue(23) });
  assert.deepEqual(slots.find((s) => s.start === tue(10)).optional, []);
  assert.deepEqual(slots.find((s) => s.start === tue(12)).optional, ['r']);
});

test('constraints filter by day, part of day and date', () => {
  const c = { tz: LA, fromMin: 8 * 60, toMin: 12 * 60, excludeDays: ['wed'] };
  const slots = computeSlots({ required: [marcus()], durationMin: 30, windowStart: tue(0), windowEnd: tue(0) + 3 * 24 * H, constraints: c });
  assert.ok(slots.length > 0);
  for (const s of slots) {
    const p = parts(s.start, LA);
    assert.notEqual(p.wd, 3);
    assert.ok(p.h * 60 + p.mi + 30 <= 12 * 60);
  }
});

test('working-day window skips weekends and holidays', () => {
  const fri = zonedToUtc(2026, 11, 20, 9, 0, LA);
  const end = workingDaysWindowEnd(fri, 5, LA, new Set(['2026-11-26']));
  // Fri 20, Mon 23, Tue 24, Wed 25, (Thu 26 holiday), Fri 27 → ends at Sat 28 00:00.
  assert.equal(iso(end), iso(zonedToUtc(2026, 11, 28, 0, 0, LA)));
});

test('parseConstraints understands common phrases', () => {
  const now = Date.parse('2026-11-09T17:00:00Z'); // Monday 09:00 PST
  const a = parseConstraints('mornings PT, not Friday', { now, tz: 'Europe/London' });
  assert.equal(a.constraints.tz, LA);
  assert.equal(a.constraints.fromMin, 480);
  assert.equal(a.constraints.toMin, 720);
  assert.deepEqual(a.constraints.excludeDays, ['fri']);
  assert.equal(a.constraints.days, undefined);

  const b = parseConstraints('next week after 2pm', { now, tz: LA });
  assert.equal(b.constraints.notBefore, '2026-11-16');
  assert.equal(b.constraints.notAfter, '2026-11-22');
  assert.equal(b.constraints.fromMin, 14 * 60);

  const c = parseConstraints('after the 12th', { now, tz: LA });
  assert.equal(c.constraints.notBefore, '2026-11-13');

  const d = parseConstraints('only Tuesday or Thursday', { now, tz: LA });
  assert.deepEqual(d.constraints.days, ['tue', 'thu']);

  const e = parseConstraints('this week', { now, tz: LA });
  assert.equal(e.constraints.notAfter, '2026-11-15');
  assert.ok(e.understood.length);
});
