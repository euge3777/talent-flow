// HTTP server: recruiter/HM web app, candidate booking page, MCP endpoint.
//
//   npm start            → http://localhost:4300
//
// Internal API calls carry X-User-Id (the "acting as" picker in the UI).
// That stands in for SSO, which is out of scope for this MVP.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, openDb } from './db.js';
import { AppError, Scheduler } from './scheduler.js';
import { McpSession } from './mcp.js';
import { seed } from './seed.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp({ db = openDb(), baseUrl, clock } = {}) {
  const scheduler = new Scheduler(db, { baseUrl, clock });
  const mcpSessions = new Map();

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  const actingUser = (req) => {
    const id = req.headers['x-user-id'];
    if (!id) throw new AppError(401, 'no_user', 'Pick a user in the "Acting as" menu.');
    return scheduler.user(String(id));
  };
  const ctx = (req) => {
    const u = actingUser(req);
    return { user: u, actor: u.email, source: 'web' };
  };

  // ------------------------------------------------------------ internal API

  route('GET', '/api/users', () => scheduler.users());
  route('GET', '/api/me', (req) => {
    const u = actingUser(req);
    return { ...scheduler.publicUser(u), apiToken: u.api_token };
  });
  route('GET', '/api/jobs', () => scheduler.jobs().map((j) => ({
    ...j, recruiter: scheduler.user(j.recruiter_id).name, hm: scheduler.user(j.hm_id).name,
    interviewTypes: scheduler.interviewTypes(j.id),
  })));
  route('GET', '/api/applications', (req, { query }) => scheduler.listApplications({ jobId: query.get('job_id') || undefined }));
  route('POST', '/api/applications/:id/stage', (req, { params, body }) => scheduler.moveStage(params.id, body.stage, ctx(req)));
  route('POST', '/api/applications/:id/screen', (req, { params, body }) => scheduler.screenResult(params.id, !!body.pass, ctx(req)));
  route('POST', '/api/applications/:id/slots', (req, { params, body }) => scheduler.findSlots(params.id, body.type, {
    text: body.text, constraints: body.constraints, speakerTz: actingUser(req).tz,
  }));
  route('POST', '/api/applications/:id/links', (req, { params, body }) => {
    const c = ctx(req);
    return scheduler.sendSchedulingLink(params.id, body.type, {
      text: body.text, message: body.message, confirm: body.confirm !== false, speakerTz: c.user.tz, ...c,
    });
  });
  route('POST', '/api/applications/:id/book', (req, { params, body }) => scheduler.directBook(params.id, body.type, body.start, {
    ...ctx(req), confirm: body.confirm !== false,
  }));

  route('GET', '/api/interviews', (req, { query }) => scheduler.listInterviews({
    userId: query.get('mine') ? actingUser(req).id : undefined, status: query.get('status') || 'scheduled',
  }));
  route('POST', '/api/interviews/:id/reschedule', (req, { params, body }) => {
    const c = ctx(req);
    const iv = scheduler.interview(params.id);
    const app = scheduler.application(iv.application_id);
    const by = app.job.recruiter_id === c.user.id ? 'recruiter' : c.user.role === 'coordinator' ? 'coordinator' : 'hm';
    return scheduler.reschedule(params.id, { ...c, by, reason: body.reason, text: body.text, newStart: body.newStart, confirm: body.confirm !== false });
  });
  route('POST', '/api/interviews/:id/cancel', (req, { params, body }) => scheduler.cancel(params.id, {
    ...ctx(req), reason: body.reason, notifyCandidate: body.notifyCandidate !== false,
  }));
  route('POST', '/api/interviews/:id/outcome', (req, { params, body }) => scheduler.markOutcome(params.id, body.outcome, ctx(req)));
  route('POST', '/api/interviews/:id/decline', (req, { params }) => scheduler.declineInvite(params.id, actingUser(req).id));

  route('PUT', '/api/users/:id/settings', (req, { params, body }) => {
    const c = ctx(req);
    if (c.user.id !== params.id && c.user.role !== 'coordinator') throw new AppError(403, 'forbidden', 'You can only edit your own availability.');
    return scheduler.updateUserSettings(params.id, body, c);
  });
  route('GET', '/api/users/:id/events', (req, { params }) => {
    const now = scheduler.now();
    return scheduler.calendar.listEvents(params.id, now - 86_400_000, now + 21 * 86_400_000);
  });
  route('POST', '/api/users/:id/events', (req, { params, body }) => {
    const start = Date.parse(body.start);
    const end = Date.parse(body.end);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new AppError(400, 'bad_event', 'Give a start and an end after it.');
    return { id: scheduler.calendar.createEvent(params.id, { start, end, title: body.title || 'Busy', source: 'external' }) };
  });
  route('DELETE', '/api/events/:id', (req, { params }) => {
    scheduler.calendar.deleteEvent(params.id);
    return { deleted: true };
  });

  route('GET', '/api/outbox', (req, { query }) => all(db,
    `SELECT * FROM outbox WHERE (? = '' OR to_addr = ?) ORDER BY id DESC LIMIT 200`, query.get('to') || '', query.get('to') || ''));
  route('GET', '/api/audit', () => all(db, 'SELECT * FROM audit ORDER BY id DESC LIMIT 200'));
  route('GET', '/api/metrics', () => scheduler.metrics());

  route('GET', '/api/clock', () => ({ now: new Date(scheduler.now()).toISOString(), offsetMinutes: Math.round((scheduler.now() - scheduler.clock()) / 60_000) }));
  route('POST', '/api/clock/advance', (req, { body }) => {
    scheduler.advanceClock(Number(body.minutes) || 60);
    return { now: new Date(scheduler.now()).toISOString(), jobs: scheduler.runJobs() };
  });
  route('POST', '/api/clock/reset', () => ({ now: new Date(scheduler.resetClock()).toISOString() }));
  route('POST', '/api/dev/reset', () => {
    seed(db, { clock: scheduler.clock });
    mcpSessions.clear();
    return { reset: true };
  });
  route('POST', '/api/jobs/run', () => scheduler.runJobs());

  // ------------------------------------------------------------ candidate (public, token = auth)

  route('GET', '/api/public/links/:token', (req, { params }) => scheduler.publicLink(params.token));
  route('POST', '/api/public/links/:token/hold', (req, { params, body }) => scheduler.hold(params.token, body.start));
  route('POST', '/api/public/links/:token/book', (req, { params, body }) => scheduler.book(params.token, body));
  route('POST', '/api/public/links/:token/suggest', (req, { params, body }) => scheduler.suggestTimes(params.token, body.times, body.note));
  route('POST', '/api/public/links/:token/reschedule', (req, { params }) => scheduler.candidateReschedule(params.token));
  route('POST', '/api/public/links/:token/cancel', (req, { params, body }) => scheduler.candidateCancel(params.token, body.reason));

  // ------------------------------------------------------------ MCP (Streamable HTTP, JSON responses)

  async function handleMcp(req, res) {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    // ?token= exists only because ChatGPT developer mode can't send headers. Dev use only.
    const queryToken = new URL(req.url, 'http://localhost').searchParams.get('token');
    const user = scheduler.userByToken(auth || queryToken);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="talentflow"' });
      res.end(JSON.stringify({ error: 'Missing or invalid bearer token. Copy yours from the AI assistants page.' }));
      return;
    }
    if (req.method === 'DELETE') {
      mcpSessions.delete(req.headers['mcp-session-id']);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' }).end();
      return;
    }
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const headers = { 'Content-Type': 'application/json' };
    let sid = req.headers['mcp-session-id'];
    let session = sid && mcpSessions.get(sid);
    if (session && session.user.id !== user.id) session = null;
    const isInit = !Array.isArray(msg) && msg?.method === 'initialize';
    if (!session) {
      session = new McpSession(scheduler, user);
      if (isInit) {
        sid = randomUUID();
        mcpSessions.set(sid, session);
        headers['Mcp-Session-Id'] = sid;
      }
    }
    const responses = (Array.isArray(msg) ? msg : [msg]).map((m) => session.handle(m)).filter(Boolean);
    if (!responses.length) {
      res.writeHead(202, headers).end();
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(Array.isArray(msg) ? responses : responses[0]));
  }

  // ------------------------------------------------------------ dispatcher

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') return await handleMcp(req, res);
      if (url.pathname.startsWith('/api/')) {
        const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
        if (!match) throw new AppError(404, 'not_found', `No route ${req.method} ${url.pathname}`);
        // Everything except the candidate API and the user picker needs a signed-in user.
        if (!url.pathname.startsWith('/api/public/') && url.pathname !== '/api/users') actingUser(req);
        const m = url.pathname.match(match.re);
        const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const raw = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : '';
        let body = {};
        if (raw) {
          try { body = JSON.parse(raw); } catch { throw new AppError(400, 'bad_json', 'Request body must be JSON.'); }
        }
        const result = await match.handler(req, { params, body, query: url.searchParams });
        return sendJson(res, 200, result);
      }
      return await serveStatic(url.pathname, res);
    } catch (err) {
      if (err instanceof AppError) return sendJson(res, err.status, { error: err.code, message: err.message, data: err.data });
      console.error(err);
      return sendJson(res, 500, { error: 'internal', message: 'Something went wrong.' });
    }
  }

  // The .ics download is the one non-JSON API response.
  async function withIcs(req, res) {
    const m = new URL(req.url, 'http://localhost').pathname.match(/^\/api\/public\/links\/([^/]+)\/ics$/);
    if (m && req.method === 'GET') {
      try {
        const body = scheduler.ics(decodeURIComponent(m[1]));
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="interview.ics"' });
        return res.end(body);
      } catch (err) {
        if (err instanceof AppError) return sendJson(res, err.status, { error: err.code, message: err.message });
        throw err;
      }
    }
    return handler(req, res);
  }

  return { handler: withIcs, scheduler, db };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 200_000) {
        reject(new AppError(413, 'too_large', 'Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj ?? null));
}

async function serveStatic(pathname, res) {
  let file = pathname === '/' ? '/app.html' : pathname;
  if (/^\/book\/[^/]+$/.test(pathname)) file = '/book.html';
  const full = normalize(join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) throw new AppError(404, 'not_found', 'Not found');
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    throw new AppError(404, 'not_found', 'Not found');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 4300;
  const host = process.env.HOST || '127.0.0.1';
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  const db = openDb();
  if (!all(db, 'SELECT id FROM users LIMIT 1').length) {
    seed(db);
    console.log('Empty database: loaded demo data.');
  }
  const { handler, scheduler } = createApp({ db, baseUrl });
  createServer(handler).listen(port, host, () => {
    console.log(`TalentFlow scheduling running at ${baseUrl}`);
    console.log(`MCP endpoint: ${baseUrl}/mcp (Bearer token from the AI assistants page)`);
  });
  // Reminders, link expiry and no-show prompts.
  setInterval(() => {
    try { scheduler.runJobs(); } catch (err) { console.error('jobs failed', err); }
  }, 30_000).unref();
}
