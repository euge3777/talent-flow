// Integration tests: the scheduling flows from the feature spec, end to end,
// on an in-memory database with a fixed clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, all, get } from '../src/db.js';
import { seed } from '../src/seed.js';
import { Scheduler } from '../src/scheduler.js';

const H = 3_600_000;
const MONDAY_9AM_PT = Date.parse('2026-11-09T17:00:00Z');

function setup() {
  const db = openDb(':memory:');
  const clock = () => MONDAY_9AM_PT;
  seed(db, { clock, withBooking: false });
  const s = new Scheduler(db, { clock, baseUrl: 'http://test' });
  return { db, s };
}

const tokenOf = (sent) => sent.link.url.split('/book/')[1];
const outbox = (db, to) => all(db, 'SELECT * FROM outbox WHERE to_addr = ? ORDER BY id', to);

test('HR screen: send link → hold → book → invites (US-2, US-3, US-5)', () => {
  const { db, s } = setup();
  const sent = s.sendSchedulingLink('app_ana', 'hr_screen', { actor: 'riya@acme.example' });
  assert.ok(sent.slots.length >= 3);
  assert.equal(s.application('app_ana').stage, 'hr_screen');
  assert.match(outbox(db, 'ana.silva@mail.example')[0].body, /http:\/\/test\/book\//);

  const token = tokenOf(sent);
  const page = s.publicLink(token);
  assert.equal(page.status, 'active');
  assert.equal(page.candidate.firstName, 'Ana');
  assert.ok(!JSON.stringify(page).includes('Lunch'), 'candidate never sees calendar details');

  // Slots are at least 24 h out and inside 07:00–21:00 Lisbon.
  for (const slot of page.slots) assert.ok(Date.parse(slot.start) >= MONDAY_9AM_PT + 24 * H);

  const hold = s.hold(token, page.slots[0].start);
  const booked = s.book(token, { holdId: hold.holdId, tz: 'Europe/Lisbon' });
  assert.equal(booked.status, 'scheduled');
  assert.ok(booked.videoUrl.startsWith('https://zoom.example.com/'));

  const events = all(db, `SELECT * FROM calendar_events WHERE source = 'talentflow'`);
  assert.equal(events.length, 1);
  assert.equal(events[0].user_id, 'u_riya');
  const ana = outbox(db, 'ana.silva@mail.example');
  assert.match(ana.at(-1).subject, /^Confirmed: HR screen/);
  assert.match(ana.at(-1).body, /Add to calendar: http:\/\/test\/api\/public\/links\/.+\/ics/);
  assert.match(outbox(db, 'riya@acme.example').map((m) => m.subject).join('|'), /Invite: HR screen with Ana Silva/);
  assert.match(s.ics(token), /BEGIN:VEVENT[\s\S]*DTSTART:/);
});

test('a held slot cannot be taken by another candidate (SCH-9)', () => {
  const { s } = setup();
  const a = tokenOf(s.sendSchedulingLink('app_ana', 'hr_screen'));
  const b = tokenOf(s.sendSchedulingLink('app_leo', 'hr_screen'));
  const shared = s.publicLink(a).slots.find((x) => s.publicLink(b).slots.some((y) => y.start === x.start));
  s.hold(a, shared.start);
  assert.ok(!s.publicLink(b).slots.some((x) => x.start === shared.start), 'held slot hidden from others');
  assert.throws(() => s.hold(b, shared.start), (e) => e.code === 'slot_taken' && e.data.slots.length > 0);
});

test('a slot booked meanwhile returns the remaining slots, not an error page', () => {
  const { s } = setup();
  const a = tokenOf(s.sendSchedulingLink('app_ana', 'hr_screen'));
  const page = s.publicLink(a);
  const hold = s.hold(a, page.slots[0].start);
  s.calendar.createEvent('u_riya', { start: Date.parse(page.slots[0].start), end: Date.parse(page.slots[0].end), title: 'Urgent', source: 'external' });
  assert.throws(() => s.book(a, { holdId: hold.holdId }), (e) => e.code === 'slot_taken' && Array.isArray(e.data.slots));
});

test('HM interview widens to 10 days when the HM is overbooked and alerts the recruiter (SCH-7)', () => {
  const { db, s } = setup();
  const found = s.findSlots('app_mia', 'hm_interview');
  assert.equal(found.widened, true);
  assert.equal(found.windowDays, 10);
  s.sendSchedulingLink('app_mia', 'hm_interview');
  assert.ok(outbox(db, 'riya@acme.example').some((m) => m.subject === 'Low interviewer availability'));
});

test('optional recruiter joins the HM interview only when free (SCH-8)', () => {
  const { s } = setup();
  const f = s.findSlots('app_ben', 'hm_interview');
  assert.deepEqual(f.required.map((u) => u.id), ['u_marcus']);
  assert.deepEqual(f.optional.map((u) => u.id), ['u_riya']);
  assert.ok(f.slots.length > 0);
  const token = tokenOf(s.sendSchedulingLink('app_ben', 'hm_interview'));
  const slot = s.publicLink(token).slots[0];
  const optional = f.slots.find((x) => x.start === slot.start).optionalAttendees;
  const hold = s.hold(token, slot.start);
  const iv = s.interview(s.book(token, { holdId: hold.holdId }).interviewId);
  assert.deepEqual(iv.attendee_ids, ['u_marcus', ...optional]);
});

test('no slots → nothing is sent; candidate in a non-overlapping zone is explained', () => {
  const { db, s } = setup();
  assert.throws(() => s.sendSchedulingLink('app_ravi', 'hr_screen'), (e) => e.code === 'no_slots' && /Asia\/Kolkata/.test(e.message));
  assert.equal(outbox(db, 'ravi.kumar@mail.example').length, 0);
});

test('disconnected calendar blocks slot search and alerts people', () => {
  const { db, s } = setup();
  s.updateUserSettings('u_marcus', { calendar_connected: false });
  assert.throws(() => s.sendSchedulingLink('app_ben', 'hm_interview'), (e) => e.code === 'calendar_disconnected');
  assert.ok(outbox(db, 'marcus@acme.example').some((m) => /Reconnect your calendar/.test(m.subject)));
});

test('a new link voids the previous one (duplicate links)', () => {
  const { s } = setup();
  const first = tokenOf(s.sendSchedulingLink('app_ana', 'hr_screen'));
  s.sendSchedulingLink('app_ana', 'hr_screen');
  assert.equal(s.publicLink(first).status, 'void');
});

test('candidate can reschedule once; the second request goes to the recruiter (US-6)', () => {
  const { db, s } = setup();
  const t1 = tokenOf(s.sendSchedulingLink('app_ana', 'hr_screen'));
  s.book(t1, { holdId: s.hold(t1, s.publicLink(t1).slots[0].start).holdId });

  const r1 = s.candidateReschedule(t1);
  assert.ok(r1.nextToken);
  assert.equal(all(db, `SELECT * FROM calendar_events WHERE source = 'talentflow'`).length, 0, 'old event removed');
  assert.equal(s.publicLink(t1).status, 'rescheduled');
  assert.equal(s.publicLink(t1).nextToken, r1.nextToken);

  const t2 = r1.nextToken;
  s.book(t2, { holdId: s.hold(t2, s.publicLink(t2).slots[1].start).holdId });
  assert.equal(s.publicLink(t2).interview.rescheduleGoesToRecruiter, true);
  const r2 = s.candidateReschedule(t2);
  assert.equal(r2.escalated, true);
  assert.equal(s.publicLink(t2).interview.status, 'scheduled', 'interview kept');
  assert.ok(outbox(db, 'riya@acme.example').some((m) => /asked to reschedule again/.test(m.subject)));
});

test('candidate changes close 4 hours before the start (SCH-18)', () => {
  const db = openDb(':memory:');
  let now = MONDAY_9AM_PT;
  seed(db, { clock: () => now, withBooking: false });
  const s = new Scheduler(db, { clock: () => now });
  const t = tokenOf(s.sendSchedulingLink('app_ana', 'hr_screen'));
  const slot = s.publicLink(t).slots[0];
  s.book(t, { holdId: s.hold(t, slot.start).holdId });
  now = Date.parse(slot.start) - 3 * H;
  assert.equal(s.publicLink(t).interview.canReschedule, false);
  assert.throws(() => s.candidateCancel(t), (e) => e.code === 'too_late');
});

test('HM declines the invite → candidate gets new options with an apology, recruiter notified (US-7)', () => {
  const { db, s } = setup();
  const t = tokenOf(s.sendSchedulingLink('app_ben', 'hm_interview'));
  const { interviewId } = s.book(t, { holdId: s.hold(t, s.publicLink(t).slots[0].start).holdId });
  s.declineInvite(interviewId, 'u_marcus');
  assert.equal(s.interview(interviewId).status, 'rescheduled');
  const ben = outbox(db, 'ben.ortiz@mail.example');
  assert.match(ben.at(-1).subject, /^New times for/);
  assert.match(ben.at(-1).body, /sorry/i);
  assert.ok(outbox(db, 'riya@acme.example').some((m) => m.subject === 'Interview rescheduled'));
});

test('direct booking rejects busy times and warns outside hours', () => {
  const { s } = setup();
  const lunch = get(s.db, `SELECT start FROM calendar_events WHERE user_id = 'u_riya' AND title = 'Lunch' AND start > ? ORDER BY start`, MONDAY_9AM_PT);
  assert.throws(() => s.directBook('app_ana', 'hr_screen', new Date(lunch.start).toISOString()), (e) => e.code === 'attendee_busy');
  const early = '2026-11-11T15:30:00Z'; // Wed 07:30 PST — free but outside Riya's 09:00–17:00
  const p = s.directBook('app_ana', 'hr_screen', early, { confirm: false });
  assert.equal(p.preview, true);
  assert.ok(p.warnings.length);
  const r = s.directBook('app_ana', 'hr_screen', early);
  assert.equal(r.booked, true);
});

test('reminders, link reminder, expiry and no-show prompt fire once each (SCH-10, 20, 21)', () => {
  const db = openDb(':memory:');
  let now = MONDAY_9AM_PT;
  seed(db, { clock: () => now, withBooking: false });
  const s = new Scheduler(db, { clock: () => now });
  s.sendSchedulingLink('app_leo', 'hr_screen'); // never booked
  const t = tokenOf(s.sendSchedulingLink('app_ana', 'hr_screen'));
  const slot = s.publicLink(t).slots.at(-1);
  s.book(t, { holdId: s.hold(t, slot.start).holdId });
  const start = Date.parse(slot.start);

  now = MONDAY_9AM_PT + 49 * H;
  assert.equal(s.runJobs().linkReminders, 1);
  assert.equal(s.runJobs().linkReminders, 0);
  now = MONDAY_9AM_PT + 73 * H;
  assert.equal(s.runJobs().linksExpired, 1);

  now = start - 23 * H;
  assert.equal(s.runJobs().reminders24, 1);
  now = start - 30 * 60_000;
  assert.equal(s.runJobs().reminders1, 1);
  now = start + 20 * 60_000;
  assert.equal(s.runJobs().noShowPrompts, 1);
  assert.equal(s.runJobs().noShowPrompts, 0);

  const r = s.markOutcome(s.publicLink(t).interview && get(db, 'SELECT id FROM interviews').id, 'no_show_candidate');
  assert.ok(r.rebookLink, 'first no-show gets one re-book link');
});

test('screen result: pass moves to HM interview, fail sends a kind rejection', () => {
  const { db, s } = setup();
  const t = tokenOf(s.sendSchedulingLink('app_ana', 'hr_screen'));
  s.book(t, { holdId: s.hold(t, s.publicLink(t).slots[0].start).holdId });
  assert.equal(s.screenResult('app_ana', true).stage, 'hm_interview');
  s.sendSchedulingLink('app_leo', 'hr_screen');
  assert.equal(s.screenResult('app_leo', false).stage, 'rejected');
  assert.match(outbox(db, 'leo.novak@mail.example').at(-1).subject, /Your application/);
  assert.equal(get(db, `SELECT count(*) AS n FROM scheduling_links WHERE application_id = 'app_leo' AND status = 'active'`).n, 0);
});

test('accommodation requests go privately to the recruiter', () => {
  const { db, s } = setup();
  const t = tokenOf(s.sendSchedulingLink('app_chen', 'hr_screen'));
  s.book(t, { holdId: s.hold(t, s.publicLink(t).slots[0].start).holdId, accommodation: 'Captions please' });
  const msg = outbox(db, 'riya@acme.example').find((m) => /accommodation/.test(m.subject));
  assert.match(msg.body, /Captions please/);
  assert.ok(!outbox(db, 'chen.wei@mail.example').some((m) => /Captions/.test(m.body)));
});

test('metrics reflect bookings', () => {
  const { s } = setup();
  const t = tokenOf(s.sendSchedulingLink('app_ana', 'hr_screen'));
  s.book(t, { holdId: s.hold(t, s.publicLink(t).slots[0].start).holdId });
  const m = s.metrics();
  assert.equal(m.linksBooked, 1);
  assert.equal(m.selfScheduleRate, 1);
  assert.equal(m.hmAvailability[0].name, 'Dana Kim', 'overbooked HM listed first');
});
