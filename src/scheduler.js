// Scheduling service: every business rule from the feature spec lives here.
// The web app, the candidate booking page and the MCP tools all call this
// class, so the behaviour is identical on every surface.

import { randomBytes } from 'node:crypto';
import { all, get, getSetting, run, setSetting, tx } from './db.js';
import { MockCalendarProvider, createVideoLink, newId } from './calendar.js';
import { attendeeConflict, computeSlots, meetsConstraints, prepareAttendee, workingDaysWindowEnd } from './slots.js';
import { mergeConstraints, parseConstraints } from './constraints.js';
import { addDaysKey, formatInTz, hhmmToMin, isValidTz, startOfDayKey } from './tz.js';
import * as T from './templates.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_CONFIG = {
  minNoticeHours: 24,      // SCH-6 / edge case "same-day bookings"
  windowDays: 5,           // SCH-6
  widenDays: 10,           // SCH-7
  minSlots: 3,             // SCH-7
  linkExpiryHours: 72,     // SCH-10
  linkReminderHours: 48,   // edge case "candidate doesn't book"
  holdMinutes: 15,         // SCH-9
  changeCutoffHours: 4,    // SCH-18
  noShowGraceMinutes: 15,  // SCH-21
  slotStepMinutes: 30,
  // Product decision beyond the spec: never offer a candidate a time outside
  // 07:00–21:00 in their own zone, even if the interviewers are free.
  candidateHours: ['07:00', '21:00'],
};

export class AppError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const json = (s, fallback) => (s == null ? fallback : JSON.parse(s));
const iso = (ms) => new Date(ms).toISOString();
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class Scheduler {
  constructor(db, { calendar, baseUrl, clock } = {}) {
    this.db = db;
    this.clock = clock || Date.now;
    this.calendar = calendar || new MockCalendarProvider(db);
    this.baseUrl = baseUrl || process.env.BASE_URL || 'http://localhost:4300';
  }

  // ---------------------------------------------------------------- clock & config

  /** Current time. A dev offset lets the demo "time travel" to fire reminders. */
  now() {
    return this.clock() + getSetting(this.db, 'clock_offset_ms', 0);
  }

  advanceClock(minutes) {
    setSetting(this.db, 'clock_offset_ms', getSetting(this.db, 'clock_offset_ms', 0) + minutes * MIN);
    return this.now();
  }

  resetClock() {
    setSetting(this.db, 'clock_offset_ms', 0);
    return this.now();
  }

  config() {
    return { ...DEFAULT_CONFIG, ...getSetting(this.db, 'config', {}) };
  }

  // ---------------------------------------------------------------- lookups

  user(id) {
    const u = get(this.db, 'SELECT * FROM users WHERE id = ?', id);
    if (!u) throw new AppError(404, 'user_not_found', `No user ${id}`);
    return { ...u, interview_hours: json(u.interview_hours, {}), calendar_connected: !!u.calendar_connected };
  }

  userByToken(token) {
    const u = token && get(this.db, 'SELECT id FROM users WHERE api_token = ?', token);
    return u ? this.user(u.id) : null;
  }

  users() {
    return all(this.db, 'SELECT id FROM users ORDER BY role, name').map((r) => this.publicUser(this.user(r.id)));
  }

  publicUser(u) {
    const { api_token, ...rest } = u;
    return rest;
  }

  job(id) {
    const j = get(this.db, 'SELECT * FROM jobs WHERE id = ?', id);
    if (!j) throw new AppError(404, 'job_not_found', `No job ${id}`);
    return j;
  }

  jobs() {
    return all(this.db, 'SELECT * FROM jobs ORDER BY title');
  }

  interviewType(jobId, keyOrId) {
    const t = get(this.db, 'SELECT * FROM interview_types WHERE job_id = ? AND (key = ? OR id = ?)', jobId, keyOrId, keyOrId);
    if (!t) throw new AppError(404, 'interview_type_not_found', `Job ${jobId} has no interview type "${keyOrId}". Use get_interview_types.`);
    return { ...t, required_roles: json(t.required_roles, []), optional_roles: json(t.optional_roles, []) };
  }

  interviewTypes(jobId) {
    this.job(jobId);
    return all(this.db, 'SELECT id FROM interview_types WHERE job_id = ? ORDER BY duration_min', jobId)
      .map((r) => {
        const t = get(this.db, 'SELECT key FROM interview_types WHERE id = ?', r.id);
        return this.interviewType(jobId, t.key);
      });
  }

  application(id) {
    const a = get(this.db, 'SELECT * FROM applications WHERE id = ?', id);
    if (!a) throw new AppError(404, 'application_not_found', `No application ${id}`);
    const candidate = get(this.db, 'SELECT * FROM candidates WHERE id = ?', a.candidate_id);
    return { ...a, candidate, job: this.job(a.job_id) };
  }

  interview(id) {
    const iv = get(this.db, 'SELECT * FROM interviews WHERE id = ?', id);
    if (!iv) throw new AppError(404, 'interview_not_found', `No interview ${id}`);
    return { ...iv, attendee_ids: json(iv.attendee_ids, []) };
  }

  linkByToken(token) {
    const l = get(this.db, 'SELECT * FROM scheduling_links WHERE token = ?', token);
    if (!l) throw new AppError(404, 'link_not_found', 'This scheduling link is not valid.');
    return { ...l, constraints: json(l.constraints, {}) };
  }

  // ---------------------------------------------------------------- side effects

  audit(actor, source, action, details = {}) {
    run(this.db, 'INSERT INTO audit (at, actor, source, action, details) VALUES (?, ?, ?, ?, ?)',
      this.now(), actor || 'system', source || 'system', action, JSON.stringify(details));
  }

  notify(channel, to, { subject, body }, relatedId = null) {
    run(this.db, 'INSERT INTO outbox (channel, to_addr, subject, body, related_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      channel, to, subject, body, relatedId, this.now());
  }

  // ---------------------------------------------------------------- availability

  attendees(app, type) {
    const byRole = { recruiter: app.job.recruiter_id, hm: app.job.hm_id };
    const pick = (roles) => [...new Set(roles.map((r) => byRole[r]).filter(Boolean))].map((id) => this.user(id));
    const required = pick(type.required_roles);
    const optional = pick(type.optional_roles).filter((u) => !required.some((r) => r.id === u.id));
    return { required, optional };
  }

  holidaysFor(region) {
    return new Set(all(this.db, 'SELECT date FROM holidays WHERE region = ?', region).map((r) => r.date));
  }

  attendeeModel(user, { from, to, excludeLinkId = '', excludeInterviewId = '' }) {
    const now = this.now();
    const busy = this.calendar.freeBusy(user.id, from - DAY, to + DAY, { excludeInterviewId });
    const holds = all(this.db,
      `SELECT start, end, user_ids FROM holds WHERE expires_at > ? AND link_id != ? AND start < ? AND end > ?`,
      now, excludeLinkId, to, from).filter((h) => json(h.user_ids, []).includes(user.id));
    const interviews = all(this.db,
      `SELECT start, attendee_ids FROM interviews WHERE status IN ('scheduled','held') AND id != ? AND start > ? AND start < ?`,
      excludeInterviewId, from - 8 * DAY, to + 8 * DAY).filter((iv) => json(iv.attendee_ids, []).includes(user.id));
    return {
      id: user.id, tz: user.tz, hours: user.interview_hours,
      maxPerDay: user.max_per_day, maxPerWeek: user.max_per_week, bufferMin: user.buffer_min,
      busy: [...busy, ...holds.map(({ start, end }) => ({ start, end }))],
      interviews: interviews.map(({ start }) => ({ start })),
      holidays: this.holidaysFor(user.holiday_region),
    };
  }

  /** Raw slot search for one window size. */
  slotsFor(app, type, { constraints = {}, windowDays, excludeLinkId, excludeInterviewId }) {
    const cfg = this.config();
    const { required, optional } = this.attendees(app, type);
    const disconnected = required.filter((u) => !u.calendar_connected);
    if (disconnected.length) return { slots: [], required, optional, disconnected };

    const primaryTz = required[0].tz;
    let windowStart = this.now() + cfg.minNoticeHours * HOUR;
    if (constraints.notBefore) {
      windowStart = Math.max(windowStart, startOfDayKey(constraints.notBefore, constraints.tz || primaryTz));
    }
    const holidays = this.holidaysFor(required[0].holiday_region);
    let windowEnd = workingDaysWindowEnd(windowStart, windowDays, primaryTz, holidays);
    if (constraints.notAfter) {
      windowEnd = Math.min(windowEnd, startOfDayKey(addDaysKey(constraints.notAfter, 1), constraints.tz || primaryTz));
    }
    const range = { from: windowStart, to: windowEnd, excludeLinkId, excludeInterviewId };
    const [candFrom, candTo] = cfg.candidateHours.map(hhmmToMin);
    const raw = computeSlots({
      required: required.map((u) => this.attendeeModel(u, range)),
      optional: optional.filter((u) => u.calendar_connected).map((u) => this.attendeeModel(u, range)),
      durationMin: type.duration_min,
      windowStart, windowEnd,
      stepMin: cfg.slotStepMinutes,
      constraints, constraintTz: constraints.tz || primaryTz,
    });
    const slots = raw.filter((s) => meetsConstraints(s.start, s.end, { tz: app.candidate.tz, fromMin: candFrom, toMin: candTo }));
    return { slots, required, optional, disconnected, windowStart, windowEnd, outsideCandidateHours: raw.length - slots.length };
  }

  /**
   * Find slots for an application (SCH-5..8, SCH-23). Widens the window to
   * 10 working days when fewer than 3 slots exist.
   */
  findSlots(applicationId, typeKey, { text, constraints, windowDays, speakerTz, excludeInterviewId, excludeLinkId } = {}) {
    const cfg = this.config();
    const app = this.application(applicationId);
    const type = this.interviewType(app.job_id, typeKey);
    const { required } = this.attendees(app, type);
    const { constraints: parsed, understood } = parseConstraints(text, { now: this.now(), tz: speakerTz || required[0].tz });
    const merged = mergeConstraints(parsed, constraints);
    if (merged.tz && !isValidTz(merged.tz)) throw new AppError(400, 'bad_timezone', `Unknown time zone ${merged.tz}`);

    const days = windowDays || cfg.windowDays;
    let r = this.slotsFor(app, type, { constraints: merged, windowDays: days, excludeInterviewId, excludeLinkId });
    let usedDays = days;
    let widened = false;
    if (!windowDays && !r.disconnected.length && r.slots.length < cfg.minSlots) {
      const wide = this.slotsFor(app, type, { constraints: merged, windowDays: cfg.widenDays, excludeInterviewId, excludeLinkId });
      if (wide.slots.length > r.slots.length) {
        r = wide;
        usedDays = cfg.widenDays;
        widened = true;
      }
    }
    const tzs = [...new Set([...r.required.map((u) => u.tz), app.candidate.tz])];
    return {
      application: { id: app.id, candidate: app.candidate.name, candidateTz: app.candidate.tz, job: app.job.title, stage: app.stage },
      interviewType: { key: type.key, name: type.name, durationMin: type.duration_min, format: type.format },
      required: r.required.map((u) => ({ id: u.id, name: u.name, tz: u.tz })),
      optional: r.optional.map((u) => ({ id: u.id, name: u.name, tz: u.tz })),
      disconnected: r.disconnected.map((u) => ({ id: u.id, name: u.name })),
      outsideCandidateHours: r.outsideCandidateHours || 0,
      windowDays: usedDays,
      widened,
      lowAvailability: r.slots.length < cfg.minSlots,
      constraints: merged,
      understood,
      slots: r.slots.map((s) => ({
        start: iso(s.start), end: iso(s.end),
        optionalAttendees: s.optional,
        labels: Object.fromEntries(tzs.map((tz) => [tz, formatInTz(s.start, tz)])),
      })),
    };
  }

  // ---------------------------------------------------------------- scheduling links

  /**
   * Email the candidate a self-booking link (SCH-10). With confirm=false it
   * returns a preview and changes nothing, which is how the AI assistant
   * shows the user what will happen before they agree.
   */
  sendSchedulingLink(applicationId, typeKey, opts = {}) {
    const {
      text, constraints, message, actor, source = 'web', confirm = true,
      rescheduleOf = null, candidateReschedules = 0, apology = false, windowDays,
    } = opts;
    const app = this.application(applicationId);
    const type = this.interviewType(app.job_id, typeKey);
    if (app.stage === 'rejected') throw new AppError(409, 'application_closed', `${app.candidate.name}'s application is closed.`);
    const found = this.findSlots(applicationId, typeKey, { text, constraints, windowDays, speakerTz: opts.speakerTz });
    const recruiter = this.user(app.job.recruiter_id);

    if (found.disconnected.length) {
      if (confirm) {
        for (const u of found.disconnected) {
          this.notify('email', u.id === recruiter.id ? recruiter.email : this.user(u.id).email, {
            subject: 'Reconnect your calendar to receive interviews',
            body: `Your calendar is disconnected, so TalentFlow can't offer interview times for ${app.candidate.name} (${app.job.title}). Reconnect it under Availability.`,
          });
        }
        this.notify('slack', recruiter.email, {
          subject: 'Calendar disconnected',
          body: `Can't schedule ${app.candidate.name}: ${found.disconnected.map((u) => u.name).join(', ')} has a disconnected calendar. You can book manually with a specific time.`,
        });
      }
      throw new AppError(409, 'calendar_disconnected',
        `${found.disconnected.map((u) => u.name).join(', ')} must reconnect their calendar before slots can be offered.`, found);
    }
    const cfg0 = this.config();
    if (!found.slots.length) {
      if (confirm) {
        this.notify('slack', recruiter.email, {
          subject: 'No interview slots available',
          body: `No ${type.name} slots for ${app.candidate.name} in the next ${found.windowDays} working days. Ask ${found.required.map((u) => u.name).join(', ')} to open more interview hours, or ask the candidate to suggest times.`,
        });
      }
      const why = found.outsideCandidateHours
        ? ` ${found.outsideCandidateHours} interviewer slot(s) exist, but all fall outside ${cfg0.candidateHours.join('–')} in the candidate's time zone (${app.candidate.tz}). Book a specific time agreed with the candidate instead.`
        : '';
      throw new AppError(409, 'no_slots', `No free ${type.name} slots in the next ${found.windowDays} working days. Nothing was sent.${why}`, found);
    }

    const token = randomBytes(18).toString('base64url');
    const url = `${this.baseUrl}/book/${token}`;
    const email = T.schedulingLinkEmail({
      candidate: app.candidate, job: app.job, type, url, slotCount: found.slots.length, message, apology, recruiter,
    });
    if (!confirm) {
      return { preview: true, ...found, email: { to: app.candidate.email, ...email, body: email.body.replace(url, '<booking link>') } };
    }

    const cfg = this.config();
    const now = this.now();
    const linkId = newId('lnk');
    tx(this.db, () => {
      run(this.db, `UPDATE scheduling_links SET status = 'void' WHERE application_id = ? AND interview_type_id = ? AND status = 'active'`,
        app.id, type.id);
      run(this.db,
        `INSERT INTO scheduling_links (id, token, application_id, interview_type_id, constraints, message, status, created_at,
           expires_at, candidate_reschedules, reschedule_of, window_days, created_by, source)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        linkId, token, app.id, type.id, JSON.stringify(found.constraints), message || null, now,
        now + cfg.linkExpiryHours * HOUR, candidateReschedules, rescheduleOf, found.windowDays, actor || null, source);
      this.advanceStageFor(app, type);
      this.notify('email', app.candidate.email, email, linkId);
      if (found.widened || found.lowAvailability) {
        this.notify('slack', recruiter.email, {
          subject: 'Low interviewer availability',
          body: `Only ${found.slots.length} ${type.name} slot(s) for ${app.candidate.name}${found.widened ? ` after widening to ${found.windowDays} working days` : ''}. Consider asking ${found.required.map((u) => u.name).join(', ')} to open more interview hours.`,
        }, linkId);
      }
      this.audit(actor, source, 'scheduling_link.sent', {
        applicationId: app.id, type: type.key, slots: found.slots.length, widened: found.widened, rescheduleOf,
      });
    });
    return {
      sent: true, ...found,
      link: { id: linkId, url, expiresAt: iso(now + cfg.linkExpiryHours * HOUR) },
      email: { to: app.candidate.email, subject: email.subject },
    };
  }

  advanceStageFor(app, type) {
    const order = ['applied', 'hr_screen', 'hm_interview'];
    const target = type.key;
    if (order.includes(target) && order.indexOf(app.stage) < order.indexOf(target)) {
      run(this.db, 'UPDATE applications SET stage = ? WHERE id = ?', target, app.id);
    }
  }

  /** Mark expired links; returns the fresh link row. */
  refreshLink(link) {
    if (link.status === 'active' && link.expires_at <= this.now()) {
      run(this.db, `UPDATE scheduling_links SET status = 'expired' WHERE id = ?`, link.id);
      return { ...link, status: 'expired' };
    }
    return link;
  }

  liveSlotsForLink(link) {
    const app = this.application(link.application_id);
    const type = get(this.db, 'SELECT key FROM interview_types WHERE id = ?', link.interview_type_id);
    return this.slotsFor(app, this.interviewType(app.job_id, type.key), {
      constraints: link.constraints, windowDays: link.window_days, excludeLinkId: link.id,
    });
  }

  /** Everything the candidate booking page needs (SCH-11). Slots are re-validated on every load. */
  publicLink(token) {
    const link = this.refreshLink(this.linkByToken(token));
    const app = this.application(link.application_id);
    const typeRow = get(this.db, 'SELECT key FROM interview_types WHERE id = ?', link.interview_type_id);
    const type = this.interviewType(app.job_id, typeRow.key);
    const out = {
      status: link.status,
      candidate: { firstName: app.candidate.name.split(' ')[0], tz: app.candidate.tz },
      company: app.job.company, job: app.job.title,
      interviewType: { name: type.name, durationMin: type.duration_min, format: type.format, prepNotes: type.prep_notes },
      expiresAt: iso(link.expires_at),
    };
    if (link.status === 'active') {
      const { slots, required } = this.liveSlotsForLink(link);
      out.interviewers = required.map((u) => u.name.split(' ')[0]);
      out.slots = slots.map((s) => ({ start: iso(s.start), end: iso(s.end) }));
    }
    if (link.status === 'booked' || link.status === 'rescheduled') {
      const iv = this.interview(link.interview_id);
      const cfg = this.config();
      const tooLate = iv.start - this.now() < cfg.changeCutoffHours * HOUR;
      out.interview = {
        start: iso(iv.start), end: iso(iv.end), status: iv.status, videoUrl: iv.video_url, tz: iv.candidate_tz,
        interviewers: iv.attendee_ids.map((id) => this.user(id).name),
        canReschedule: iv.status === 'scheduled' && !tooLate,
        canCancel: iv.status === 'scheduled' && !tooLate,
        rescheduleGoesToRecruiter: iv.candidate_reschedules >= 1,
      };
      const next = get(this.db,
        `SELECT token FROM scheduling_links WHERE reschedule_of = ? AND status IN ('active','booked') ORDER BY created_at DESC LIMIT 1`, iv.id);
      if (next) out.nextToken = next.token;
    }
    return out;
  }

  /** Hold a slot while the candidate confirms (SCH-9). */
  hold(token, startIso) {
    return tx(this.db, () => {
      const link = this.refreshLink(this.linkByToken(token));
      if (link.status !== 'active') throw new AppError(410, `link_${link.status}`, 'This link can no longer be used.');
      const start = Date.parse(startIso);
      const live = this.liveSlotsForLink(link);
      const slot = live.slots.find((s) => s.start === start);
      if (!slot) {
        throw new AppError(409, 'slot_taken', 'That time was just taken. Please pick another.', {
          slots: live.slots.map((s) => ({ start: iso(s.start), end: iso(s.end) })),
        });
      }
      const cfg = this.config();
      const id = newId('hold');
      const expiresAt = this.now() + cfg.holdMinutes * MIN;
      run(this.db, 'DELETE FROM holds WHERE link_id = ?', link.id);
      run(this.db, 'INSERT INTO holds (id, link_id, start, end, user_ids, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, link.id, slot.start, slot.end, JSON.stringify([...live.required.map((u) => u.id), ...slot.optional]), expiresAt);
      return { holdId: id, start: iso(slot.start), end: iso(slot.end), expiresAt: iso(expiresAt) };
    });
  }

  /** Candidate confirms a held slot (SCH-14, SCH-15). */
  book(token, { holdId, tz, accommodation } = {}) {
    const result = tx(this.db, () => {
      const link = this.refreshLink(this.linkByToken(token));
      if (link.status !== 'active') throw new AppError(410, `link_${link.status}`, 'This link can no longer be used.');
      const hold = get(this.db, 'SELECT * FROM holds WHERE id = ? AND link_id = ? AND expires_at > ?', holdId || '', link.id, this.now());
      const live = this.liveSlotsForLink(link);
      const slotsOut = { slots: live.slots.map((s) => ({ start: iso(s.start), end: iso(s.end) })) };
      if (!hold) throw new AppError(409, 'hold_expired', 'Your hold on that time expired. Please pick a time again.', slotsOut);
      const slot = live.slots.find((s) => s.start === hold.start);
      if (!slot) throw new AppError(409, 'slot_taken', 'That time is no longer available. Please pick another.', slotsOut);

      const app = this.application(link.application_id);
      const typeRow = get(this.db, 'SELECT key FROM interview_types WHERE id = ?', link.interview_type_id);
      const type = this.interviewType(app.job_id, typeRow.key);
      const candidateTz = tz && isValidTz(tz) ? tz : app.candidate.tz;
      const interviewId = this.createInterview(app, type, slot.start, [...live.required.map((u) => u.id), ...slot.optional], {
        bookedVia: 'link', linkId: link.id, candidateReschedules: link.candidate_reschedules,
        accommodation: accommodation || null, candidateTz,
      });
      run(this.db, `UPDATE scheduling_links SET status = 'booked', booked_at = ?, interview_id = ? WHERE id = ?`,
        this.now(), interviewId, link.id);
      run(this.db, 'DELETE FROM holds WHERE link_id = ?', link.id);
      this.sendBookingNotices(app, type, interviewId, token);
      if (accommodation) {
        this.notify('email', this.user(app.job.recruiter_id).email, {
          subject: `Private: accommodation request from ${app.candidate.name}`,
          body: `${app.candidate.name} asked for an accommodation for their ${type.name}:\n\n${accommodation}\n\nThis note is visible only to the recruiter.`,
        }, interviewId);
      }
      this.audit(app.candidate.email, 'candidate', 'interview.booked', { interviewId, applicationId: app.id, start: iso(slot.start) });
      return interviewId;
    });
    return { interviewId: result, ...this.publicLink(token).interview };
  }

  createInterview(app, type, start, attendeeIds, { bookedVia, linkId = null, candidateReschedules = 0, accommodation = null, candidateTz }) {
    const id = newId('int');
    const end = start + type.duration_min * MIN;
    run(this.db,
      `INSERT INTO interviews (id, application_id, interview_type_id, start, end, attendee_ids, video_url, candidate_tz, status,
         booked_via, link_id, candidate_reschedules, accommodation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
      id, app.id, type.id, start, end, JSON.stringify(attendeeIds),
      type.format === 'video' ? createVideoLink(app.job.video_provider) : null,
      candidateTz || app.candidate.tz, bookedVia, linkId, candidateReschedules, accommodation, this.now());
    for (const uid of attendeeIds) {
      this.calendar.createEvent(uid, { start, end, title: `Interview: ${app.candidate.name} — ${type.name}`, interviewId: id });
    }
    return id;
  }

  sendBookingNotices(app, type, interviewId, token) {
    const iv = this.interview(interviewId);
    const interviewers = iv.attendee_ids.map((uid) => this.user(uid));
    const manageUrl = token ? `${this.baseUrl}/book/${token}` : `${this.baseUrl}/book/${this.manageToken(iv)}`;
    this.notify('email', app.candidate.email, T.confirmationEmail({
      candidate: app.candidate, job: app.job, type, interview: iv, interviewers,
      manageUrl, icsUrl: `${manageUrl.replace('/book/', '/api/public/links/')}/ics`,
    }), interviewId);
    for (const u of interviewers) {
      this.notify('calendar', u.email, T.interviewerInvite({
        user: u, candidate: app.candidate, job: app.job, type, interview: iv, baseUrl: this.baseUrl, application: app,
      }), interviewId);
    }
    const recruiter = this.user(app.job.recruiter_id);
    this.notify('slack', recruiter.email, {
      subject: 'Interview booked',
      body: `${app.candidate.name} booked a ${type.name} for ${T.timeLine(iv.start, recruiter.tz, iv.candidate_tz)}.`,
    }, interviewId);
  }

  /** Direct bookings have no candidate link yet; create a booked one so the candidate can manage it. */
  manageToken(iv) {
    if (iv.link_id) return get(this.db, 'SELECT token FROM scheduling_links WHERE id = ?', iv.link_id).token;
    const token = randomBytes(18).toString('base64url');
    const linkId = newId('lnk');
    run(this.db,
      `INSERT INTO scheduling_links (id, token, application_id, interview_type_id, status, created_at, expires_at, booked_at,
         interview_id, candidate_reschedules, source)
       VALUES (?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?, 'direct')`,
      linkId, token, iv.application_id, iv.interview_type_id, this.now(), iv.end, this.now(), iv.id, iv.candidate_reschedules);
    run(this.db, 'UPDATE interviews SET link_id = ? WHERE id = ?', linkId, iv.id);
    return token;
  }

  // ---------------------------------------------------------------- direct booking

  /** Book an agreed time directly (book_interview). Busy conflicts block; outside-hours only warns. */
  directBook(applicationId, typeKey, startIso, { actor, source = 'web', confirm = true, excludeInterviewId = '', candidateReschedules = 0 } = {}) {
    const start = Date.parse(startIso);
    if (Number.isNaN(start)) throw new AppError(400, 'bad_start', 'start must be an ISO 8601 date-time, e.g. 2026-11-10T18:00:00Z');
    if (start <= this.now()) throw new AppError(400, 'start_in_past', 'That time has already passed.');
    const app = this.application(applicationId);
    const type = this.interviewType(app.job_id, typeKey);
    const end = start + type.duration_min * MIN;
    const { required, optional } = this.attendees(app, type);
    const range = { from: start, to: end, excludeInterviewId };
    const warnings = [];
    for (const u of required) {
      const model = this.attendeeModel(u, range);
      const conflict = attendeeConflict(prepareAttendee(model), start, end, { ignoreHours: true });
      if (conflict) throw new AppError(409, `attendee_${conflict}`, `${u.name} is not available then (${conflict.replace('_', ' ')}).`);
      const hoursCheck = attendeeConflict(prepareAttendee(model), start, end);
      if (hoursCheck === 'outside_hours') warnings.push(`Outside ${u.name}'s interview hours.`);
    }
    const freeOptional = optional.filter((u) => {
      const m = this.attendeeModel(u, range);
      return u.calendar_connected && !attendeeConflict(prepareAttendee(m), start, end, { ignoreHours: true });
    });
    const attendeesOut = [...required, ...freeOptional].map((u) => ({ name: u.name, time: formatInTz(start, u.tz) }));
    const preview = {
      candidate: app.candidate.name, candidateTime: formatInTz(start, app.candidate.tz),
      interviewType: type.name, durationMin: type.duration_min, attendees: attendeesOut,
      videoProvider: app.job.video_provider, warnings,
    };
    if (!confirm) return { preview: true, ...preview };
    const interviewId = tx(this.db, () => {
      run(this.db, `UPDATE scheduling_links SET status = 'void' WHERE application_id = ? AND interview_type_id = ? AND status = 'active'`,
        app.id, type.id);
      const id = this.createInterview(app, type, start, [...required, ...freeOptional].map((u) => u.id), {
        bookedVia: 'direct', candidateReschedules, candidateTz: app.candidate.tz,
      });
      this.advanceStageFor(app, type);
      this.sendBookingNotices(app, type, id, null);
      this.audit(actor, source, 'interview.booked_direct', { interviewId: id, applicationId: app.id, start: iso(start), warnings });
      return id;
    });
    return { booked: true, interviewId, ...preview };
  }

  // ---------------------------------------------------------------- changes

  /** Cancel an interview and remove calendar events. Internal; no permission checks. */
  cancelInternal(iv, status, reason, { notifyCandidate = true } = {}) {
    const app = this.application(iv.application_id);
    const type = get(this.db, 'SELECT * FROM interview_types WHERE id = ?', iv.interview_type_id);
    run(this.db, 'UPDATE interviews SET status = ?, cancel_reason = ? WHERE id = ?', status, reason || null, iv.id);
    this.calendar.deleteEventsForInterview(iv.id);
    for (const uid of iv.attendee_ids) {
      const u = this.user(uid);
      this.notify('calendar', u.email, T.cancellationEmail({ candidate: app.candidate, type, interview: iv, reason, toCandidate: false, user: u }), iv.id);
    }
    if (notifyCandidate) {
      this.notify('email', app.candidate.email, T.cancellationEmail({ candidate: app.candidate, type, interview: iv, reason, toCandidate: true }), iv.id);
    }
    if (iv.link_id) run(this.db, `UPDATE scheduling_links SET status = 'rescheduled' WHERE id = ? AND status = 'booked'`, iv.link_id);
    return { app, type };
  }

  assertChangeable(iv, by) {
    if (iv.status !== 'scheduled') throw new AppError(409, 'not_scheduled', `This interview is ${iv.status}.`);
    if (by === 'candidate' && iv.start - this.now() < this.config().changeCutoffHours * HOUR) {
      throw new AppError(409, 'too_late', 'Changes are possible up to 4 hours before the interview. Please contact your recruiter.');
    }
  }

  /**
   * Reschedule (SCH-17..19). Cancels the current time, then either books
   * `newStart` or sends the candidate a fresh link. `by` is who asked:
   * candidate | recruiter | hm | coordinator | calendar.
   */
  reschedule(interviewId, { by = 'recruiter', actor, source = 'web', reason, text, constraints, newStart, confirm = true } = {}) {
    const iv = this.interview(interviewId);
    this.assertChangeable(iv, by);
    const app = this.application(iv.application_id);
    const typeRow = get(this.db, 'SELECT key, name FROM interview_types WHERE id = ?', iv.interview_type_id);
    const recruiter = this.user(app.job.recruiter_id);

    if (by === 'candidate' && iv.candidate_reschedules >= 1) {
      this.notify('email', recruiter.email, {
        subject: `${app.candidate.name} asked to reschedule again`,
        body: `${app.candidate.name} asked to move their ${typeRow.name} (${T.timeLine(iv.start, recruiter.tz)}) a second time. Candidates can self-reschedule once, so please follow up directly.`,
      }, iv.id);
      this.audit(actor || app.candidate.email, source, 'interview.reschedule_escalated', { interviewId });
      return { escalated: true, message: 'Your recruiter has been asked to find a new time with you.' };
    }

    const current = { start: iso(iv.start), label: formatInTz(iv.start, app.candidate.tz) };
    if (!confirm) {
      const next = newStart
        ? this.directBook(app.id, typeRow.key, newStart, { confirm: false, excludeInterviewId: iv.id })
        : this.findSlots(app.id, typeRow.key, { text, constraints, excludeInterviewId: iv.id });
      return { preview: true, current, next, candidate: app.candidate.name, interviewType: typeRow.name };
    }

    return tx(this.db, () => {
      this.cancelInternal(iv, 'rescheduled', reason || `Rescheduled by ${by}`, { notifyCandidate: false });
      const carried = iv.candidate_reschedules + (by === 'candidate' ? 1 : 0);
      const result = newStart
        ? this.directBook(app.id, typeRow.key, newStart, { actor, source, excludeInterviewId: iv.id, candidateReschedules: carried })
        : this.sendSchedulingLink(app.id, typeRow.key, {
          text, constraints, actor, source, rescheduleOf: iv.id, candidateReschedules: carried,
          apology: by !== 'candidate',
          message: by === 'candidate' ? null : 'We apologise for the change and appreciate your flexibility.',
        });
      if (by !== 'recruiter' && by !== 'candidate') {
        this.notify('slack', recruiter.email, {
          subject: 'Interview rescheduled',
          body: `${by === 'calendar' ? reason : `The ${by.toUpperCase()}`} — ${typeRow.name} with ${app.candidate.name} (was ${T.timeLine(iv.start, recruiter.tz)}) has been rescheduled. ${newStart ? 'A new time was booked.' : 'The candidate was sent new options.'}`,
        }, iv.id);
      }
      this.audit(actor, source, 'interview.rescheduled', { interviewId, by, reason, newStart: newStart || null });
      return { rescheduled: true, previous: current, ...result };
    });
  }

  cancel(interviewId, { by = 'recruiter', actor, source = 'web', reason, notifyCandidate = true, confirm = true } = {}) {
    const iv = this.interview(interviewId);
    this.assertChangeable(iv, by);
    const app = this.application(iv.application_id);
    const typeRow = get(this.db, 'SELECT name FROM interview_types WHERE id = ?', iv.interview_type_id);
    const notified = [...iv.attendee_ids.map((id) => this.user(id).name), ...(notifyCandidate ? [app.candidate.name] : [])];
    if (!confirm) {
      return { preview: true, interview: { candidate: app.candidate.name, type: typeRow.name, start: iso(iv.start) }, willNotify: notified, reason: reason || null };
    }
    return tx(this.db, () => {
      this.cancelInternal(iv, 'cancelled', reason, { notifyCandidate: by !== 'candidate' && notifyCandidate });
      if (by === 'candidate') {
        this.notify('slack', this.user(app.job.recruiter_id).email, {
          subject: 'Candidate cancelled', body: `${app.candidate.name} cancelled their ${typeRow.name}${reason ? `: "${reason}"` : ''}.`,
        }, iv.id);
      }
      this.audit(actor, source, 'interview.cancelled', { interviewId, by, reason });
      return { cancelled: true, notified };
    });
  }

  /** An interviewer declined the calendar invite: treat it as a reschedule request (edge case table). */
  declineInvite(interviewId, userId) {
    const u = this.user(userId);
    return this.reschedule(interviewId, { by: 'calendar', actor: u.email, source: 'calendar', reason: `${u.name} declined the invite` });
  }

  candidateReschedule(token) {
    const link = this.linkByToken(token);
    if (!link.interview_id) throw new AppError(409, 'not_booked', 'Nothing is booked on this link yet.');
    const app = this.application(link.application_id);
    const result = this.reschedule(link.interview_id, { by: 'candidate', actor: app.candidate.email, source: 'candidate', reason: 'Candidate rescheduled' });
    if (result.escalated) return result;
    const next = get(this.db, `SELECT token FROM scheduling_links WHERE reschedule_of = ? AND status = 'active'`, link.interview_id);
    return { rescheduled: true, nextToken: next?.token };
  }

  candidateCancel(token, reason) {
    const link = this.linkByToken(token);
    if (!link.interview_id) throw new AppError(409, 'not_booked', 'Nothing is booked on this link yet.');
    const app = this.application(link.application_id);
    return this.cancel(link.interview_id, { by: 'candidate', actor: app.candidate.email, source: 'candidate', reason });
  }

  /** Candidate can't make any slot and proposes alternatives (SCH-13). */
  suggestTimes(token, times, note) {
    const link = this.refreshLink(this.linkByToken(token));
    if (link.status !== 'active') throw new AppError(410, `link_${link.status}`, 'This link can no longer be used.');
    const parsed = (times || []).map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t)).slice(0, 3);
    if (!parsed.length) throw new AppError(400, 'no_times', 'Please suggest at least one time.');
    const app = this.application(link.application_id);
    const recruiter = this.user(app.job.recruiter_id);
    this.notify('email', recruiter.email, {
      subject: `${app.candidate.name} suggested other interview times`,
      body: [
        `${app.candidate.name} couldn't make any of the offered times and suggested:`,
        ...parsed.map((t) => `- ${T.timeLine(t, recruiter.tz, app.candidate.tz)}`),
        note ? `\nNote: ${note}` : '',
        '\nBook one with "Book a specific time" or ask the assistant to book it.',
      ].join('\n'),
    }, link.id);
    this.audit(app.candidate.email, 'candidate', 'scheduling_link.times_suggested', { linkId: link.id, count: parsed.length });
    return { sent: true, count: parsed.length };
  }

  // ---------------------------------------------------------------- outcomes & stages

  markOutcome(interviewId, outcome, { actor, source = 'web' } = {}) {
    const allowed = ['held', 'no_show_candidate', 'no_show_interviewer'];
    if (!allowed.includes(outcome)) throw new AppError(400, 'bad_outcome', `outcome must be one of ${allowed.join(', ')}`);
    const iv = this.interview(interviewId);
    if (iv.status !== 'scheduled') throw new AppError(409, 'not_scheduled', `This interview is already ${iv.status}.`);
    if (iv.start > this.now()) throw new AppError(409, 'not_started', 'The interview has not started yet.');
    const app = this.application(iv.application_id);
    const typeRow = get(this.db, 'SELECT key, name FROM interview_types WHERE id = ?', iv.interview_type_id);
    return tx(this.db, () => {
      run(this.db, 'UPDATE interviews SET status = ? WHERE id = ?', outcome, iv.id);
      let next = null;
      if (outcome === 'held') {
        for (const uid of iv.attendee_ids) {
          const u = this.user(uid);
          this.notify('slack', u.email, {
            subject: 'Scorecard due',
            body: `Please submit your scorecard for ${app.candidate.name} (${typeRow.name}): ${this.baseUrl}/#/scorecards/${app.id}`,
          }, iv.id);
        }
      } else if (outcome === 'no_show_candidate') {
        run(this.db, 'UPDATE applications SET no_shows = no_shows + 1 WHERE id = ?', app.id);
        if (app.no_shows === 0) {
          next = this.trySendLink(app.id, typeRow.key, {
            actor, source, message: 'We missed you at your interview. If something came up, you can pick a new time once.',
          });
        } else {
          this.notify('slack', this.user(app.job.recruiter_id).email, {
            subject: 'Second no-show', body: `${app.candidate.name} missed a second interview. Consider closing the application.`,
          }, iv.id);
        }
      } else {
        next = this.trySendLink(app.id, typeRow.key, {
          actor, source, apology: true, windowDays: this.config().widenDays,
          message: "We're very sorry — our interviewer couldn't make it. Please pick a new time; these are our first available slots.",
        });
      }
      this.audit(actor, source, 'interview.outcome', { interviewId, outcome });
      return { status: outcome, rebookLink: next?.link || null };
    });
  }

  trySendLink(applicationId, typeKey, opts) {
    try {
      return this.sendSchedulingLink(applicationId, typeKey, opts);
    } catch (err) {
      if (err instanceof AppError && (err.code === 'no_slots' || err.code === 'calendar_disconnected')) return null;
      throw err;
    }
  }

  /** HR screen result. Pass moves to HM interview; fail closes with a kind email. */
  screenResult(applicationId, pass, { actor, source = 'web' } = {}) {
    const app = this.application(applicationId);
    if (!['hr_screen', 'hm_interview'].includes(app.stage)) {
      throw new AppError(409, 'wrong_stage', `${app.candidate.name} is in stage "${app.stage}".`);
    }
    return tx(this.db, () => {
      if (pass) {
        run(this.db, `UPDATE applications SET stage = 'hm_interview' WHERE id = ?`, app.id);
      } else {
        this.closeApplication(app, { actor, source });
      }
      this.audit(actor, source, 'application.screen_result', { applicationId, pass });
      return { stage: pass ? 'hm_interview' : 'rejected', next: pass ? 'schedule_hm_interview' : null };
    });
  }

  closeApplication(app, { actor, source }) {
    run(this.db, `UPDATE applications SET stage = 'rejected' WHERE id = ?`, app.id);
    run(this.db, `UPDATE scheduling_links SET status = 'void' WHERE application_id = ? AND status = 'active'`, app.id);
    for (const iv of all(this.db, `SELECT id FROM interviews WHERE application_id = ? AND status = 'scheduled'`, app.id)) {
      this.cancelInternal(this.interview(iv.id), 'cancelled', 'Application closed', { notifyCandidate: false });
    }
    this.notify('email', app.candidate.email, T.rejectionEmail({ candidate: app.candidate, job: app.job }), app.id);
    this.audit(actor, source, 'application.closed', { applicationId: app.id });
  }

  moveStage(applicationId, stage, { actor, source = 'web' } = {}) {
    const stages = ['applied', 'hr_screen', 'hm_interview', 'offer', 'rejected'];
    if (!stages.includes(stage)) throw new AppError(400, 'bad_stage', `stage must be one of ${stages.join(', ')}`);
    const app = this.application(applicationId);
    if (stage === 'rejected') return tx(this.db, () => { this.closeApplication(app, { actor, source }); return { stage }; });
    run(this.db, 'UPDATE applications SET stage = ? WHERE id = ?', stage, app.id);
    this.audit(actor, source, 'application.stage_changed', { applicationId, from: app.stage, to: stage });
    return { stage };
  }

  // ---------------------------------------------------------------- views

  listApplications({ jobId, query, userId } = {}) {
    let rows = all(this.db,
      `SELECT a.id FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id
       WHERE (? = '' OR a.job_id = ?) AND (? = '' OR lower(c.name) LIKE ? OR lower(j.title) LIKE ?)
         AND (? = '' OR j.recruiter_id = ? OR j.hm_id = ?)
       ORDER BY j.title, a.created_at`,
      jobId || '', jobId || '', query || '', `%${(query || '').toLowerCase()}%`, `%${(query || '').toLowerCase()}%`,
      userId || '', userId || '', userId || '');
    return rows.map(({ id }) => {
      const app = this.application(id);
      const link = get(this.db,
        `SELECT l.*, t.key AS type_key FROM scheduling_links l JOIN interview_types t ON t.id = l.interview_type_id
         WHERE l.application_id = ? ORDER BY l.created_at DESC LIMIT 1`, id);
      const next = get(this.db,
        `SELECT i.*, t.key AS type_key, t.name AS type_name FROM interviews i JOIN interview_types t ON t.id = i.interview_type_id
         WHERE i.application_id = ? AND i.status = 'scheduled' ORDER BY i.start LIMIT 1`, id);
      const lastDone = get(this.db,
        `SELECT i.status, t.key AS type_key FROM interviews i JOIN interview_types t ON t.id = i.interview_type_id
         WHERE i.application_id = ? AND i.status IN ('held','no_show_candidate','no_show_interviewer') ORDER BY i.start DESC LIMIT 1`, id);
      return {
        id, stage: app.stage, jobId: app.job_id, job: app.job.title,
        candidate: { id: app.candidate.id, name: app.candidate.name, email: app.candidate.email, tz: app.candidate.tz },
        latestLink: link && {
          status: this.refreshLink({ ...link, constraints: {} }).status, type: link.type_key,
          createdAt: iso(link.created_at), expiresAt: iso(link.expires_at),
          url: `${this.baseUrl}/book/${link.token}`,
        },
        nextInterview: next && { id: next.id, type: next.type_key, typeName: next.type_name, start: iso(next.start), end: iso(next.end) },
        lastCompleted: lastDone && { type: lastDone.type_key, status: lastDone.status },
      };
    });
  }

  listInterviews({ userId, status = 'scheduled', applicationId, query } = {}) {
    const rows = all(this.db,
      `SELECT i.*, t.name AS type_name, t.key AS type_key, c.name AS candidate_name, j.title AS job_title
       FROM interviews i JOIN interview_types t ON t.id = i.interview_type_id
       JOIN applications a ON a.id = i.application_id JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id
       WHERE (? = 'all' OR i.status = ?) AND (? = '' OR i.application_id = ?) AND (? = '' OR lower(c.name) LIKE ?)
       ORDER BY i.start`,
      status, status, applicationId || '', applicationId || '', query || '', `%${(query || '').toLowerCase()}%`);
    return rows
      .map((r) => ({ ...r, attendee_ids: json(r.attendee_ids, []) }))
      .filter((r) => !userId || r.attendee_ids.includes(userId) || this.isRecruiterFor(userId, r.application_id))
      .map((r) => ({
        id: r.id, applicationId: r.application_id, candidate: r.candidate_name, job: r.job_title,
        type: r.type_key, typeName: r.type_name, start: iso(r.start), end: iso(r.end), status: r.status,
        candidateTz: r.candidate_tz, videoUrl: r.video_url, bookedVia: r.booked_via,
        attendees: r.attendee_ids.map((id) => { const u = this.user(id); return { id, name: u.name, tz: u.tz }; }),
        accommodationRequested: !!r.accommodation,
      }));
  }

  isRecruiterFor(userId, applicationId) {
    const row = get(this.db, 'SELECT j.recruiter_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?', applicationId);
    return row?.recruiter_id === userId;
  }

  updateUserSettings(userId, patch, { actor, source = 'web' } = {}) {
    const u = this.user(userId);
    const next = { ...u };
    if (patch.tz !== undefined) {
      if (!isValidTz(patch.tz)) throw new AppError(400, 'bad_timezone', `Unknown time zone ${patch.tz}`);
      next.tz = patch.tz;
    }
    if (patch.interview_hours !== undefined) next.interview_hours = validateHours(patch.interview_hours);
    for (const k of ['max_per_day', 'max_per_week', 'buffer_min']) {
      if (patch[k] !== undefined) {
        const n = Number(patch[k]);
        if (!Number.isInteger(n) || n < 0 || n > 200) throw new AppError(400, 'bad_number', `${k} must be a whole number`);
        next[k] = n;
      }
    }
    if (patch.calendar_connected !== undefined) next.calendar_connected = !!patch.calendar_connected;
    if (patch.holiday_region !== undefined) next.holiday_region = String(patch.holiday_region);
    run(this.db,
      `UPDATE users SET tz = ?, interview_hours = ?, max_per_day = ?, max_per_week = ?, buffer_min = ?, calendar_connected = ?, holiday_region = ? WHERE id = ?`,
      next.tz, JSON.stringify(next.interview_hours), next.max_per_day, next.max_per_week, next.buffer_min,
      next.calendar_connected ? 1 : 0, next.holiday_region, userId);
    this.audit(actor, source, 'user.settings_updated', { userId, fields: Object.keys(patch) });
    return this.publicUser(this.user(userId));
  }

  // ---------------------------------------------------------------- background jobs

  /** Reminders, link expiry and no-show prompts (SCH-10, SCH-20, SCH-21). Safe to run repeatedly. */
  runJobs() {
    const now = this.now();
    const cfg = this.config();
    const counts = { holdsExpired: 0, linkReminders: 0, linksExpired: 0, reminders24: 0, reminders1: 0, noShowPrompts: 0 };
    tx(this.db, () => {
      counts.holdsExpired = Number(run(this.db, 'DELETE FROM holds WHERE expires_at <= ?', now).changes);

      for (const l of all(this.db, `SELECT * FROM scheduling_links WHERE status = 'active'`)) {
        const app = this.application(l.application_id);
        const type = get(this.db, 'SELECT * FROM interview_types WHERE id = ?', l.interview_type_id);
        if (l.expires_at <= now) {
          run(this.db, `UPDATE scheduling_links SET status = 'expired', expiry_notified = 1 WHERE id = ?`, l.id);
          this.notify('slack', this.user(app.job.recruiter_id).email, {
            subject: 'Scheduling link expired',
            body: `${app.candidate.name} didn't book their ${type.name} within 72 hours. Resend the link or close the candidate.`,
          }, l.id);
          counts.linksExpired++;
        } else if (!l.reminded && now - l.created_at >= cfg.linkReminderHours * HOUR) {
          run(this.db, 'UPDATE scheduling_links SET reminded = 1 WHERE id = ?', l.id);
          this.notify('email', app.candidate.email, {
            subject: `Reminder: pick a time for your ${type.name}`,
            body: `Hi ${app.candidate.name.split(' ')[0]},\n\nYou haven't picked a time for your ${type.name} for ${app.job.title} yet. Your link expires in ${Math.round((l.expires_at - now) / HOUR)} hours:\n${this.baseUrl}/book/${l.token}`,
          }, l.id);
          counts.linkReminders++;
        }
      }

      for (const r of all(this.db, `SELECT id FROM interviews WHERE status = 'scheduled'`)) {
        const iv = this.interview(r.id);
        const app = this.application(iv.application_id);
        const type = get(this.db, 'SELECT * FROM interview_types WHERE id = ?', iv.interview_type_id);
        const until = iv.start - now;
        if (!iv.reminded_24 && until <= 24 * HOUR && until > HOUR) {
          run(this.db, 'UPDATE interviews SET reminded_24 = 1 WHERE id = ?', iv.id);
          if (iv.start - iv.created_at > 24 * HOUR) {
            this.notify('email', app.candidate.email, T.reminderEmail({ candidate: app.candidate, type, interview: iv, hours: 24 }), iv.id);
            counts.reminders24++;
          }
        }
        if (!iv.reminded_1 && until <= HOUR && until > 0) {
          run(this.db, 'UPDATE interviews SET reminded_1 = 1, reminded_24 = 1 WHERE id = ?', iv.id);
          this.notify('email', app.candidate.email, T.reminderEmail({ candidate: app.candidate, type, interview: iv, hours: 1 }), iv.id);
          for (const uid of iv.attendee_ids) {
            const u = this.user(uid);
            this.notify('slack', u.email, {
              subject: `In 1 hour: ${type.name} with ${app.candidate.name}`,
              body: `Starts ${formatInTz(iv.start, u.tz)}. Join: ${iv.video_url}\nRésumé: ${app.candidate.resume_url || '—'}\nScorecard: ${this.baseUrl}/#/scorecards/${app.id}`,
            }, iv.id);
          }
          counts.reminders1++;
        }
        if (!iv.noshow_prompted && now >= iv.start + cfg.noShowGraceMinutes * MIN) {
          run(this.db, 'UPDATE interviews SET noshow_prompted = 1 WHERE id = ?', iv.id);
          this.notify('slack', this.user(app.job.recruiter_id).email, {
            subject: 'Did it happen?',
            body: `${type.name} with ${app.candidate.name} started ${Math.round((now - iv.start) / MIN)} min ago and isn't marked as held. Mark it held, or record a no-show to re-book.`,
          }, iv.id);
          counts.noShowPrompts++;
        }
      }
    });
    return counts;
  }

  // ---------------------------------------------------------------- reporting (SCH-24)

  metrics() {
    const links = all(this.db, `SELECT l.*, j.title AS job FROM scheduling_links l JOIN applications a ON a.id = l.application_id
      JOIN jobs j ON j.id = a.job_id WHERE l.source != 'direct' OR l.source IS NULL`);
    const booked = links.filter((l) => l.booked_at);
    const ivs = all(this.db, 'SELECT status, booked_via FROM interviews');
    const held = ivs.filter((i) => i.status === 'held').length;
    const noShows = ivs.filter((i) => i.status === 'no_show_candidate').length;
    const rescheduled = ivs.filter((i) => i.status === 'rescheduled').length;
    const timeToSchedule = booked.map((l) => (l.booked_at - l.created_at) / HOUR);
    const byJob = {};
    for (const l of booked) (byJob[l.job] ||= []).push((l.booked_at - l.created_at) / HOUR);

    const hms = all(this.db, `SELECT DISTINCT hm_id FROM jobs`).map(({ hm_id }) => {
      const u = this.user(hm_id);
      const cfg = this.config();
      const from = this.now() + cfg.minNoticeHours * HOUR;
      const to = workingDaysWindowEnd(from, cfg.windowDays, u.tz, this.holidaysFor(u.holiday_region));
      const slots = u.calendar_connected
        ? computeSlots({ required: [this.attendeeModel(u, { from, to })], durationMin: 45, windowStart: from, windowEnd: to, stepMin: cfg.slotStepMinutes }).length
        : 0;
      return { id: u.id, name: u.name, freeSlots45: slots, calendarConnected: u.calendar_connected };
    }).sort((a, b) => a.freeSlots45 - b.freeSlots45);

    return {
      linksSent: links.length,
      linksBooked: booked.length,
      medianHoursToSchedule: median(timeToSchedule),
      selfScheduleRate: ivs.length ? ivs.filter((i) => i.booked_via === 'link').length / ivs.length : null,
      rescheduleRate: ivs.length ? rescheduled / ivs.length : null,
      noShowRate: held + noShows ? noShows / (held + noShows) : null,
      interviews: ivs.length,
      byJob: Object.entries(byJob).map(([job, xs]) => ({ job, booked: xs.length, medianHoursToSchedule: median(xs) })),
      hmAvailability: hms,
    };
  }

  /** iCalendar file for the candidate (SCH-14). */
  ics(token) {
    const link = this.linkByToken(token);
    if (!link.interview_id) throw new AppError(404, 'not_booked', 'Nothing is booked on this link.');
    const iv = this.interview(link.interview_id);
    const app = this.application(iv.application_id);
    const type = get(this.db, 'SELECT * FROM interview_types WHERE id = ?', iv.interview_type_id);
    const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TalentFlow//Interview Scheduling//EN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${iv.id}@talentflow`, `DTSTAMP:${stamp(this.now())}`,
      `DTSTART:${stamp(iv.start)}`, `DTEND:${stamp(iv.end)}`,
      `SUMMARY:${type.name} — ${app.job.title} (${app.job.company})`,
      `DESCRIPTION:Join: ${iv.video_url || 'details from your recruiter'}`,
      iv.video_url ? `LOCATION:${iv.video_url}` : null,
      `STATUS:${iv.status === 'scheduled' ? 'CONFIRMED' : 'CANCELLED'}`,
      'END:VEVENT', 'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
  }
}

function validateHours(hours) {
  const out = {};
  for (const k of ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) {
    const ranges = hours?.[k] || [];
    if (!Array.isArray(ranges)) throw new AppError(400, 'bad_hours', `interview_hours.${k} must be a list`);
    out[k] = ranges.map((r) => {
      if (!Array.isArray(r) || r.length !== 2 || !/^\d{2}:\d{2}$/.test(r[0]) || !/^\d{2}:\d{2}$/.test(r[1]) || r[0] >= r[1]) {
        throw new AppError(400, 'bad_hours', `Invalid range for ${k}: ${JSON.stringify(r)}. Use ["10:00","16:00"].`);
      }
      return r;
    });
  }
  return out;
}
