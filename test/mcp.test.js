// MCP protocol + HTTP endpoint tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, get } from '../src/db.js';
import { seed } from '../src/seed.js';
import { Scheduler } from '../src/scheduler.js';
import { McpSession, TOOLS } from '../src/mcp.js';
import { createApp } from '../src/server.js';

const clock = () => Date.parse('2026-11-09T17:00:00Z');

function session(userId = 'u_riya') {
  const db = openDb(':memory:');
  seed(db, { clock, withBooking: false });
  const s = new Scheduler(db, { clock });
  const sess = new McpSession(s, s.user(userId));
  sess.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'ChatGPT' }, capabilities: {} } });
  let id = 1;
  const call = (name, args) => sess.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }).result;
  return { db, s, sess, call };
}

test('initialize and tools/list', () => {
  const { sess } = session();
  const init = sess.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal(sess.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = sess.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const t of list.result.tools) assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
  assert.equal(sess.handle({ jsonrpc: '2.0', id: 3, method: 'nope' }).error.code, -32601);
});

test('write tools preview first and only act with confirm: true', () => {
  const { db, call } = session();
  const apps = call('list_applications', { query: 'ana' });
  assert.equal(apps.structuredContent.count, 1);
  const appId = apps.structuredContent.applications[0].id;

  const preview = call('send_scheduling_link', { application_id: appId, interview_type: 'hr_screen', when: 'mornings PT, not Friday' });
  assert.equal(preview.isError, false);
  assert.equal(preview.structuredContent.preview, true);
  assert.match(preview.content[0].text, /^PREVIEW ONLY/);
  assert.deepEqual(preview.structuredContent.constraints.excludeDays, ['fri']);
  assert.equal(get(db, 'SELECT count(*) AS n FROM scheduling_links').n, 0, 'nothing sent on preview');

  const sent = call('send_scheduling_link', { application_id: appId, interview_type: 'hr_screen', when: 'mornings PT, not Friday', confirm: true });
  assert.equal(sent.structuredContent.sent, true);
  assert.equal(get(db, 'SELECT count(*) AS n FROM scheduling_links').n, 1);
  const audit = get(db, `SELECT * FROM audit WHERE action = 'scheduling_link.sent'`);
  assert.equal(audit.source, 'mcp:chatgpt');
  assert.equal(audit.actor, 'riya@acme.example');
});

test('hiring manager can reschedule their own interview but cannot send links', () => {
  const { s, call } = session('u_marcus');
  const denied = call('send_scheduling_link', { application_id: 'app_ben', interview_type: 'hm_interview', confirm: true });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error, 'forbidden');

  const sent = s.sendSchedulingLink('app_ben', 'hm_interview');
  const token = sent.link.url.split('/book/')[1];
  s.book(token, { holdId: s.hold(token, s.publicLink(token).slots[0].start).holdId });

  const mine = call('list_interviews', { query: 'ben' });
  assert.equal(mine.structuredContent.count, 1);
  const ivId = mine.structuredContent.interviews[0].id;
  const preview = call('reschedule_interview', { interview_id: ivId, reason: 'Offsite moved', when: 'next week' });
  assert.equal(preview.structuredContent.preview, true);
  assert.equal(s.interview(ivId).status, 'scheduled');
  const done = call('reschedule_interview', { interview_id: ivId, reason: 'Offsite moved', when: 'next week', confirm: true });
  assert.equal(done.structuredContent.rescheduled, true);
  assert.equal(s.interview(ivId).status, 'rescheduled');
});

test('errors come back as tool errors, not protocol errors', () => {
  const { call } = session();
  const r = call('send_scheduling_link', { application_id: 'app_ravi', interview_type: 'hr_screen' });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error, 'no_slots');
  const missing = call('find_interview_slots', { application_id: 'nope', interview_type: 'hr_screen' });
  assert.equal(missing.structuredContent.error, 'application_not_found');
});

test('HTTP: /mcp requires a bearer token and supports sessions; booking page API works', async () => {
  const db = openDb(':memory:');
  seed(db, { clock, withBooking: false });
  const { handler, scheduler } = createApp({ db, clock, baseUrl: 'http://test' });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = scheduler.user('u_riya').api_token;
    const rpc = (body, headers = {}) => fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);

    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai' } } }, { Authorization: `Bearer ${token}` });
    const sid = init.headers.get('mcp-session-id');
    assert.ok(sid);
    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid });
    assert.equal(note.status, 202);
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_scheduling_link', arguments: { application_id: 'app_chen', interview_type: 'hr_screen', confirm: true } } },
      { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid });
    const body = await res.json();
    assert.equal(body.result.structuredContent.sent, true);
    assert.equal(get(db, `SELECT source FROM audit WHERE action = 'scheduling_link.sent'`).source, 'mcp:claude-ai');

    const viaQuery = await fetch(`${base}/mcp?token=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) });
    assert.equal(viaQuery.status, 200);

    // Candidate side over HTTP.
    const linkToken = body.result.structuredContent.link.url.split('/book/')[1];
    const page = await (await fetch(`${base}/api/public/links/${linkToken}`)).json();
    assert.equal(page.status, 'active');
    const hold = await (await fetch(`${base}/api/public/links/${linkToken}/hold`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: page.slots[0].start }) })).json();
    const booked = await fetch(`${base}/api/public/links/${linkToken}/book`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holdId: hold.holdId }) });
    assert.equal(booked.status, 200);
    const ics = await fetch(`${base}/api/public/links/${linkToken}/ics`);
    assert.equal(ics.headers.get('content-type'), 'text/calendar; charset=utf-8');
    assert.match(await ics.text(), /BEGIN:VCALENDAR/);

    const html = await fetch(`${base}/book/${linkToken}`);
    assert.match(await html.text(), /book\.js/);
    const internal = await fetch(`${base}/api/applications`);
    assert.equal(internal.status, 401, 'internal API needs a user');
  } finally {
    server.close();
  }
});

test('stdio transport answers initialize and tools/list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-'));
  const dbFile = join(dir, 'test.db');
  const db = openDb(dbFile);
  seed(db, { clock, withBooking: false });
  const token = get(db, `SELECT api_token FROM users WHERE id = 'u_riya'`).api_token;
  db.close();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/mcp-stdio.js'], {
    env: { ...process.env, TALENTFLOW_DB: dbFile, TALENTFLOW_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.setEncoding('utf8').on('data', (d) => lines.push(...d.split('\n').filter(Boolean)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-desktop' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  const deadline = Date.now() + 5000;
  while (lines.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const [init, list] = lines.map((l) => JSON.parse(l));
  assert.equal(init.result.serverInfo.name, 'talentflow-scheduling');
  assert.equal(list.result.tools.length, TOOLS.length);
});
