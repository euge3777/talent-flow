// MCP tools for interview scheduling (SCH-22). Transport-agnostic: the
// stdio entry point (Claude Desktop, local agents) and the HTTP /mcp route
// (ChatGPT developer mode, Claude remote connectors) both use McpSession.
//
// Write tools are two-phase: called without `confirm: true` they return a
// preview and change nothing. This guarantees the "confirm before every
// write" rule even in hosts that don't show their own confirmation prompt.

import { AppError } from './scheduler.js';

export const SERVER_INFO = { name: 'talentflow-scheduling', title: 'TalentFlow Interview Scheduling', version: '0.1.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `TalentFlow schedules interviews between candidates, recruiters (HR) and hiring managers.
- Find IDs first: list_applications for a candidate, list_interviews for an existing interview. If a name matches more than one record, ask the user which one; never guess.
- Prefer send_scheduling_link (candidate picks a time). Use book_interview only when the user names a time already agreed with the candidate.
- Every write tool is two-phase: call it without confirm to get a preview, show the preview to the user, and call again with confirm: true only after they explicitly agree.
- Always state times with their time zone, and the candidate's local time when it differs.`;

const constraintsSchema = {
  type: 'object',
  description: 'Structured filters. Usually leave this out and pass `when` instead.',
  properties: {
    tz: { type: 'string', description: 'IANA time zone the filters are expressed in, e.g. America/Los_Angeles' },
    days: { type: 'array', items: { enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
    excludeDays: { type: 'array', items: { enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
    fromMin: { type: 'string', description: 'Earliest start, HH:MM' },
    toMin: { type: 'string', description: 'Latest end, HH:MM' },
    notBefore: { type: 'string', description: 'YYYY-MM-DD' },
    notAfter: { type: 'string', description: 'YYYY-MM-DD' },
  },
  additionalProperties: false,
};

const when = { type: 'string', description: 'Natural-language preference, e.g. "mornings PT, not Friday, next week".' };
const confirm = { type: 'boolean', description: 'Omit for a preview. Set true only after the user approved that preview.' };
const typeKey = { type: 'string', enum: ['hr_screen', 'hm_interview'], description: 'hr_screen = candidate + recruiter; hm_interview = candidate + hiring manager.' };

export const TOOLS = [
  {
    name: 'list_applications',
    title: 'Find candidates',
    description: 'Search candidate applications by candidate name or job title. Returns application_id, stage, any scheduled interview and the latest scheduling link. Use this to resolve a candidate name to an application_id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Candidate name or job title (partial match).' },
        job_id: { type: 'string' },
        stage: { type: 'string', enum: ['applied', 'hr_screen', 'hm_interview', 'offer', 'rejected'] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_interviews',
    title: 'List interviews',
    description: "List interviews the user attends or recruits for. Use to find interview_id before rescheduling or cancelling (e.g. \"my interview with Ana\").",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Candidate name (partial match).' },
        status: { type: 'string', enum: ['scheduled', 'held', 'cancelled', 'rescheduled', 'all'], default: 'scheduled' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_interview_types',
    title: 'Interview types for a job',
    description: 'List interview types for a job with duration, who must attend and format.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'find_interview_slots',
    title: 'Find interview times',
    description: 'Find times when every required interviewer is free, inside their interview hours and load caps. Read-only: nothing is booked or sent. Widens to 10 working days automatically when fewer than 3 slots exist.',
    inputSchema: {
      type: 'object',
      properties: { application_id: { type: 'string' }, interview_type: typeKey, when, constraints: constraintsSchema, window_days: { type: 'integer', minimum: 1, maximum: 20 } },
      required: ['application_id', 'interview_type'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'send_scheduling_link',
    title: 'Send scheduling link',
    description: 'Email the candidate a self-booking link with the free slots. Two-phase: without confirm it returns a preview of the slots and email; with confirm: true it sends. Replaces any earlier active link for the same interview type.',
    inputSchema: {
      type: 'object',
      properties: {
        application_id: { type: 'string' }, interview_type: typeKey, when, constraints: constraintsSchema,
        message: { type: 'string', description: 'Optional personal note added to the email.' }, confirm,
      },
      required: ['application_id', 'interview_type'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'book_interview',
    title: 'Book a specific time',
    description: 'Book a specific time that the user already agreed with the candidate, and send invites. Fails if a required interviewer is busy; warns when outside interview hours. Two-phase like the other write tools.',
    inputSchema: {
      type: 'object',
      properties: {
        application_id: { type: 'string' }, interview_type: typeKey,
        start: { type: 'string', description: 'ISO 8601 with offset, e.g. 2026-11-10T10:00:00-08:00' }, confirm,
      },
      required: ['application_id', 'interview_type', 'start'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'reschedule_interview',
    title: 'Reschedule interview',
    description: 'Cancel the current time and either send the candidate new options (default, with an apology) or book new_start. Two-phase. The recruiter is notified when a hiring manager reschedules.',
    inputSchema: {
      type: 'object',
      properties: {
        interview_id: { type: 'string' }, reason: { type: 'string' }, when,
        new_start: { type: 'string', description: 'Book this exact time instead of sending options (ISO 8601).' }, confirm,
      },
      required: ['interview_id', 'reason'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'cancel_interview',
    title: 'Cancel interview',
    description: 'Cancel an interview for every attendee and remove it from calendars. Two-phase. Does not reject the candidate.',
    inputSchema: {
      type: 'object',
      properties: { interview_id: { type: 'string' }, reason: { type: 'string' }, notify_candidate: { type: 'boolean', default: true }, confirm },
      required: ['interview_id', 'reason'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];

const forbid = (msg) => { throw new AppError(403, 'forbidden', msg); };

export class McpSession {
  /**
   * @param {import('./scheduler.js').Scheduler} scheduler
   * @param {object} user  the signed-in TalentFlow user the assistant acts as
   */
  constructor(scheduler, user) {
    this.s = scheduler;
    this.user = user;
    this.clientName = 'unknown';
  }

  get source() {
    return `mcp:${this.clientName}`;
  }

  /** Handle one JSON-RPC message. Returns a response object, or null for notifications. */
  handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && 'id' in msg ? rpcError(msg.id ?? null, -32600, 'Invalid request') : null;
    }
    const isNotification = !('id' in msg);
    try {
      const result = this.dispatch(msg.method, msg.params || {});
      return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result };
    } catch (err) {
      if (isNotification) return null;
      if (err.rpcCode) return rpcError(msg.id, err.rpcCode, err.message);
      return rpcError(msg.id, -32603, err.message);
    }
  }

  dispatch(method, params) {
    switch (method) {
      case 'initialize': {
        this.clientName = String(params.clientInfo?.name || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        const requested = params.protocolVersion;
        return {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {};
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call':
        return this.callTool(params.name, params.arguments || {});
      default: {
        const e = new Error(`Method not found: ${method}`);
        e.rpcCode = -32601;
        throw e;
      }
    }
  }

  callTool(name, args) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      const e = new Error(`Unknown tool: ${name}`);
      e.rpcCode = -32602;
      throw e;
    }
    try {
      const data = this.run(name, args);
      return { content: [{ type: 'text', text: summarize(name, data) }], structuredContent: data, isError: false };
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      const detail = { error: err.code, message: err.message };
      if (err.data?.slots) detail.slots = err.data.slots.slice(0, 10).map((s) => s.labels || s.start);
      return { content: [{ type: 'text', text: `Error (${err.code}): ${err.message}` }], structuredContent: detail, isError: true };
    }
  }

  // ------------------------------------------------------------ permissions

  canSeeApp(app) {
    return this.user.role === 'coordinator' || app.job.recruiter_id === this.user.id || app.job.hm_id === this.user.id;
  }

  requireScheduler(app) {
    if (!(this.user.role === 'coordinator' || app.job.recruiter_id === this.user.id)) {
      forbid(`Only the recruiter or a coordinator can schedule for ${app.job.title}. Ask ${this.s.user(app.job.recruiter_id).name}.`);
    }
  }

  requireInterviewAccess(iv) {
    const app = this.s.application(iv.application_id);
    const ok = this.user.role === 'coordinator' || app.job.recruiter_id === this.user.id || iv.attendee_ids.includes(this.user.id);
    if (!ok) forbid('You can only change interviews you attend or recruit for.');
    return app;
  }

  byFor(app) {
    if (app.job.recruiter_id === this.user.id) return 'recruiter';
    if (this.user.role === 'coordinator') return 'coordinator';
    return 'hm';
  }

  // ------------------------------------------------------------ tools

  run(name, a) {
    const s = this.s;
    const actor = this.user.email;
    const source = this.source;
    const confirmed = a.confirm === true;
    switch (name) {
      case 'list_applications': {
        const scope = this.user.role === 'coordinator' ? undefined : this.user.id;
        let apps = s.listApplications({ jobId: a.job_id, query: a.query, userId: scope });
        if (a.stage) apps = apps.filter((x) => x.stage === a.stage);
        return { count: apps.length, applications: apps.slice(0, 25) };
      }
      case 'list_interviews': {
        const scope = this.user.role === 'coordinator' ? undefined : this.user.id;
        const ivs = s.listInterviews({ userId: scope, status: a.status || 'scheduled', query: a.query });
        return { count: ivs.length, interviews: ivs.slice(0, 25) };
      }
      case 'get_interview_types': {
        const job = s.job(a.job_id);
        if (!(this.user.role === 'coordinator' || job.recruiter_id === this.user.id || job.hm_id === this.user.id)) forbid('Not your job.');
        return {
          job: job.title,
          interviewTypes: s.interviewTypes(a.job_id).map((t) => ({
            key: t.key, name: t.name, durationMin: t.duration_min, required: t.required_roles, optional: t.optional_roles, format: t.format,
          })),
        };
      }
      case 'find_interview_slots': {
        const app = s.application(a.application_id);
        if (!this.canSeeApp(app)) forbid('Not your candidate.');
        const r = s.findSlots(a.application_id, a.interview_type, {
          text: a.when, constraints: a.constraints, windowDays: a.window_days, speakerTz: this.user.tz,
        });
        return { ...r, slots: r.slots.slice(0, 20), totalSlots: r.slots.length };
      }
      case 'send_scheduling_link': {
        const app = s.application(a.application_id);
        this.requireScheduler(app);
        const r = s.sendSchedulingLink(a.application_id, a.interview_type, {
          text: a.when, constraints: a.constraints, message: a.message, actor, source, confirm: confirmed, speakerTz: this.user.tz,
        });
        return { ...r, slots: r.slots.slice(0, 10), totalSlots: r.slots.length };
      }
      case 'book_interview': {
        const app = s.application(a.application_id);
        this.requireScheduler(app);
        return s.directBook(a.application_id, a.interview_type, a.start, { actor, source, confirm: confirmed });
      }
      case 'reschedule_interview': {
        const iv = s.interview(a.interview_id);
        const app = this.requireInterviewAccess(iv);
        const r = s.reschedule(a.interview_id, {
          by: this.byFor(app), actor, source, reason: a.reason, text: a.when, newStart: a.new_start, confirm: confirmed,
        });
        if (r.next?.slots) r.next = { ...r.next, slots: r.next.slots.slice(0, 10), totalSlots: r.next.slots.length };
        if (r.slots) r.slots = r.slots.slice(0, 10);
        return r;
      }
      case 'cancel_interview': {
        const iv = s.interview(a.interview_id);
        const app = this.requireInterviewAccess(iv);
        return s.cancel(a.interview_id, {
          by: this.byFor(app), actor, source, reason: a.reason, notifyCandidate: a.notify_candidate !== false, confirm: confirmed,
        });
      }
      default:
        throw new AppError(400, 'unknown_tool', name);
    }
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Short, model-readable text that accompanies structuredContent. */
function summarize(name, d) {
  const head = {
    list_applications: `${d.count} application(s) found.`,
    list_interviews: `${d.count} interview(s) found.`,
    get_interview_types: `Interview types for ${d.job}.`,
    find_interview_slots: `${d.totalSlots} slot(s) for ${d.application?.candidate} — ${d.interviewType?.name}${d.widened ? ` (widened to ${d.windowDays} working days)` : ''}.${d.lowAvailability ? ' Low availability.' : ''}`,
    send_scheduling_link: d.preview
      ? `PREVIEW ONLY — nothing sent. Show this to the user and call again with confirm: true if they agree. ${d.totalSlots} slot(s) would be offered to ${d.application?.candidate}.`
      : `Sent. ${d.application?.candidate} has a booking link with ${d.totalSlots} slot(s); it expires ${d.link?.expiresAt}.`,
    book_interview: d.preview
      ? 'PREVIEW ONLY — nothing booked. Confirm with the user, then call again with confirm: true.'
      : `Booked ${d.interviewType} with ${d.candidate} for ${d.candidateTime} (candidate's time).`,
    reschedule_interview: d.escalated ? d.message : d.preview
      ? 'PREVIEW ONLY — nothing changed. Confirm with the user, then call again with confirm: true.'
      : 'Rescheduled. The old time was cancelled for everyone.',
    cancel_interview: d.preview
      ? 'PREVIEW ONLY — nothing cancelled. Confirm with the user, then call again with confirm: true.'
      : `Cancelled. Notified: ${d.notified?.join(', ')}.`,
  }[name];
  return `${head}\n\n${JSON.stringify(d, null, 1)}`;
}
