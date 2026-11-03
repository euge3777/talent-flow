// TalentFlow scheduling — recruiter / hiring manager web app. No framework.

import { localHour, sunArc } from '/sun.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { users: [], me: null, jobs: [] };

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const userId = () => store.get('tf_user', 'u_riya');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-Id': userId() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.code = data.error;
    err.data = data.data;
    throw err;
  }
  return data;
}

function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 3800);
}

// ---------------------------------------------------------------- time helpers

function fmt(iso, tz, { date = true, zone = true, weekday = true } = {}) {
  const o = { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (date) Object.assign(o, { day: 'numeric', month: 'short' }, weekday ? { weekday: 'short' } : {});
  if (zone) o.timeZoneName = 'short';
  return new Intl.DateTimeFormat('en-US', o).format(new Date(iso));
}
const clockOnly = (iso, tz) => fmt(iso, tz, { date: false, zone: false });
const city = (tz) => tz.split('/').pop().replace(/_/g, ' ');
const firstName = (n) => n.split(' ')[0];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function tzOffset(ms, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** "2026-11-10T10:00" read as wall time in tz → ISO string. */
function wallToIso(local, tz) {
  const [d, t] = local.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, h, mi);
  const first = guess - tzOffset(guess, tz);
  return new Date(guess - tzOffset(first, tz)).toISOString();
}

const TYPE_NAMES = { hr_screen: 'HR screen', hm_interview: 'HM interview' };
const STAGE_WORDS = { applied: 'Applied', hr_screen: 'HR screen', hm_interview: 'Hiring manager interview', offer: 'Offer', rejected: 'Closed' };

// ---------------------------------------------------------------- modal

function openModal(html, label) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div></div>`;
  const back = $('.modal-back', root);
  back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  setTimeout(() => $('input, button.primary', root)?.focus(), 30);
  return $('.modal', root);
}
function closeModal() { $('#modal-root').innerHTML = ''; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------------------------------------------------------------- chrome

async function refreshClock() {
  const c = await api('GET', '/api/clock');
  const tz = state.me?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('#clock').textContent = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(c.now))
    + (c.offsetMinutes ? ` +${Math.round(c.offsetMinutes / 60)}h` : '');
}

async function refreshInboxCount() {
  const msgs = await api('GET', '/api/outbox');
  const el = $('#inbox-count');
  el.textContent = msgs.length;
  el.hidden = !msgs.length;
}

async function loadBase() {
  state.users = await api('GET', '/api/users');
  if (!state.users.some((u) => u.id === userId())) store.set('tf_user', state.users[0].id);
  state.me = await api('GET', '/api/me');
  state.jobs = await api('GET', '/api/jobs');
  const roles = { recruiter: 'recruiter', hm: 'hiring manager', coordinator: 'coordinator' };
  $('#acting').innerHTML = state.users.map((u) => `<option value="${esc(u.id)}" ${u.id === state.me.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  $('#avatar').textContent = state.me.name.split(' ').map((w) => w[0]).join('');
  $('#acting').closest('.chip').title = `Acting as ${state.me.name}, ${roles[state.me.role]}. Switch user.`;
}

$('#acting').addEventListener('change', async (e) => {
  store.set('tf_user', e.target.value);
  await loadBase();
  render();
});
document.querySelectorAll('[data-advance]').forEach((b) => b.addEventListener('click', async () => {
  const r = await api('POST', '/api/clock/advance', { minutes: Number(b.dataset.advance) });
  const names = { linkReminders: 'link reminder', linksExpired: 'expired link', reminders24: '24-hour reminder', reminders1: '1-hour reminder', noShowPrompts: 'no-show check', holdsExpired: 'released hold' };
  const fired = Object.entries(r.jobs).filter(([, n]) => n).map(([k, n]) => plural(n, names[k])).join(', ');
  toast(fired ? `Moved forward. Sent: ${fired}.` : 'Moved forward. Nothing was due yet.');
  render();
}));
$('#clock-reset').addEventListener('click', async () => { await api('POST', '/api/clock/reset'); $('.clock-menu').open = false; render(); });
$('#demo-reset').addEventListener('click', async () => {
  if (!confirm('Reset the demo data? Everything you did will be cleared.')) return;
  await api('POST', '/api/dev/reset');
  await api('POST', '/api/clock/reset');
  $('.clock-menu').open = false;
  await loadBase();
  toast('Demo data reset.');
  render();
});

function statement(title, sub, hour) {
  return `<section class="statement">
    ${hour == null ? '' : `<span class="ornament">${sunArc(hour, { size: 64 })}</span>`}
    <h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</section>`;
}

const nowHour = () => localHour(new Date().toISOString(), state.me.tz);

// ---------------------------------------------------------------- views

const views = {
  async pipeline(el) {
    const isRecruiter = state.me.role !== 'hm';
    const apps = await api('GET', '/api/applications');
    const visible = state.me.role === 'hm'
      ? apps.filter((a) => state.jobs.find((j) => j.id === a.jobId)?.hm_id === state.me.id)
      : apps;
    const open = visible.filter((a) => a.stage !== 'rejected');
    const choosing = open.filter((a) => !a.nextInterview && a.latestLink?.status === 'active').length;
    const booked = open.filter((a) => a.nextInterview).length;
    const ready = open.filter((a) => needsAction(a)).length;

    const count = (n, one, many) => (n === 1 ? `One ${one}` : `${n} ${many}`);
    const title = isRecruiter
      ? (ready ? `${count(ready, 'candidate is', 'candidates are')} ready for a time.` : 'Every candidate has a time or a link.')
      : (booked ? `${count(booked, 'candidate has', 'candidates have')} an interview booked with you.` : 'Nothing is booked with you yet.');
    const progress = [choosing && `${count(choosing, 'is', 'are')} choosing from a link`, `${plural(booked, 'interview')} booked`].filter(Boolean).join(', ');
    const sub = isRecruiter
      ? `${progress}. Schedule someone and TalentFlow sends them times when you and the hiring manager are both free.`
      : 'Recruiters send the times. You can move an interview from the Interviews page, your calendar or your AI assistant.';

    const byJob = new Map();
    for (const a of visible) {
      if (!byJob.has(a.jobId)) byJob.set(a.jobId, []);
      byJob.get(a.jobId).push(a);
    }
    el.innerHTML = statement(title, sub, nowHour()) + [...byJob].map(([jobId, list]) => {
      const job = state.jobs.find((j) => j.id === jobId);
      return `<section class="section"><div class="label">${esc(job.title)}<small>Hiring manager ${esc(job.hm)}<br>Recruiter ${esc(job.recruiter)}</small></div>
        <ul class="people">${list.map((a) => personRow(a, isRecruiter)).join('')}</ul></section>`;
    }).join('') || '<p class="empty">No candidates yet.</p>';
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => appAction(b.dataset.act, visible.find((a) => a.id === b.dataset.app))));
  },

  async interviews(el) {
    const mine = store.get('tf_mine', '1') !== '0';
    const status = store.get('tf_status', 'scheduled');
    const list = await api('GET', `/api/interviews?status=${status}${mine ? '&mine=1' : ''}`);
    const clock = await api('GET', '/api/clock');
    const now = Date.parse(clock.now);
    const week = list.filter((iv) => Date.parse(iv.start) - now < 7 * 864e5 && Date.parse(iv.start) > now).length;
    const title = status === 'scheduled'
      ? (list.length ? `${plural(week, 'interview')} in the next seven days.` : 'No interviews booked yet.')
      : `${plural(list.length, 'interview')} marked ${status.replace(/_/g, ' ')}.`;
    const statuses = { scheduled: 'Upcoming', held: 'Held', rescheduled: 'Moved', cancelled: 'Cancelled', no_show_candidate: 'Candidate no-show', no_show_interviewer: 'Interviewer no-show', all: 'All' };
    el.innerHTML = statement(title, 'Times show in your zone first, with the candidate\'s beside them. The sun shows where it falls in their day.', nowHour()) + `
      <section class="section"><div class="label">Showing<small>
        <label class="row" style="font-weight:400;margin:10px 0"><input type="checkbox" class="toggle" id="mine" ${mine ? 'checked' : ''}> Only mine</label></small>
        <select id="status" aria-label="Status">${Object.entries(statuses).map(([k, v]) => `<option ${k === status ? 'selected' : ''} value="${k}">${v}</option>`).join('')}</select></div>
        <div>${list.length ? `<ul class="meetings">${list.map((iv) => meetingRow(iv, now)).join('')}</ul>` : '<p class="empty">Nothing here.</p>'}</div></section>`;
    $('#mine').addEventListener('change', (e) => { store.set('tf_mine', e.target.checked ? '1' : '0'); render(); });
    $('#status').addEventListener('change', (e) => { store.set('tf_status', e.target.value); render(); });
    el.querySelectorAll('[data-iv]').forEach((b) => b.addEventListener('click', () => interviewAction(b.dataset.ivact, list.find((x) => x.id === b.dataset.iv))));
  },

  async availability(el) {
    const me = state.me;
    const events = await api('GET', `/api/users/${me.id}/events`);
    const days = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
    const openDays = days.filter(([k]) => me.interview_hours[k]?.length).map(([, l]) => l);
    const zones = [...new Set([me.tz, 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Singapore', 'Asia/Kolkata', 'Australia/Sydney'])];
    const byDay = new Map();
    for (const ev of events) {
      const key = new Intl.DateTimeFormat('en-US', { timeZone: me.tz, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(ev.start));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(ev);
    }
    const title = openDays.length
      ? `You take interviews ${openDays.join(',') === 'Mon,Tue,Wed,Thu,Fri' ? 'every weekday' : `on ${openDays.join(', ')}`}, up to ${me.max_per_day} a day.`
      : 'You are not taking interviews right now.';
    el.innerHTML = statement(title, 'Candidates are only offered times inside these hours, under your limits, and clear of anything busy in your calendar. TalentFlow reads free and busy times, never event details.', nowHour()) + `
      <form id="hours-form">
        <section class="section"><div class="label">Interview hours<small>In ${esc(city(me.tz))} time</small></div>
          <div>
            <div class="week">${days.map(([k, label]) => {
              const r = me.interview_hours[k]?.[0];
              return `<div class="weekday ${r ? '' : 'off'}"><strong>${label}</strong>
                <input type="checkbox" class="toggle" data-day="${k}" ${r ? 'checked' : ''} aria-label="Take interviews on ${label}">
                <span class="row times"><input type="time" data-from="${k}" value="${r?.[0] || '10:00'}" aria-label="${label} from"> <span class="muted">to</span> <input type="time" data-to="${k}" value="${r?.[1] || '16:00'}" aria-label="${label} to"></span></div>`;
            }).join('')}</div>
            <div class="numbers">
              <div><label for="maxd">Most per day</label><input id="maxd" type="number" min="0" value="${me.max_per_day}"></div>
              <div><label for="maxw">Most per week</label><input id="maxw" type="number" min="0" value="${me.max_per_week}"></div>
              <div><label for="buf">Gap between meetings</label><div class="row"><input id="buf" type="number" min="0" value="${me.buffer_min}"><span class="muted small">minutes</span></div></div>
              <div><label for="tz">Time zone</label><select id="tz">${zones.map((z) => `<option ${z === me.tz ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>
            </div>
            <label class="row" style="font-weight:400;margin:22px 0"><input type="checkbox" class="toggle" id="connected" ${me.calendar_connected ? 'checked' : ''}> Calendar connected (${esc(me.calendar_provider === 'google' ? 'Google Calendar' : 'Microsoft 365')})</label>
            <button class="primary" type="submit">Save availability</button>
          </div></section>
      </form>
      <section class="section"><div class="label">Your calendar<small>Next three weeks. This is a simulated calendar: add a busy block and watch those times disappear from candidates' links.</small></div>
        <div>
          <form id="busy-form" class="row">
            <input type="date" id="b-date" required aria-label="Date">
            <input type="time" id="b-from" value="10:00" required aria-label="From">
            <input type="time" id="b-to" value="11:00" required aria-label="To">
            <input type="text" id="b-title" placeholder="What is it?" aria-label="Title" style="width:150px">
            <button type="submit">Add busy time</button>
          </form>
          <div class="agenda">${[...byDay].map(([day, evs]) => `<div class="dayhead">${esc(day)}</div>
            ${evs.map((ev) => `<div class="ev ${ev.source === 'talentflow' ? 'interview' : ''}">
              <span><span class="tm">${esc(clockOnly(new Date(ev.start).toISOString(), me.tz))}–${esc(clockOnly(new Date(ev.end).toISOString(), me.tz))}</span>${esc(ev.title)}</span>
              ${ev.source === 'external' ? `<button class="quiet small" data-del="${esc(ev.id)}" aria-label="Remove ${esc(ev.title)}">Remove</button>` : ''}</div>`).join('')}`).join('') || '<p class="empty">Your calendar is clear.</p>'}</div>
        </div></section>`;
    el.querySelectorAll('[data-day]').forEach((t) => t.addEventListener('change', () => t.closest('.weekday').classList.toggle('off', !t.checked)));
    $('#hours-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hours = {};
      for (const [k] of days) hours[k] = $(`[data-day="${k}"]`).checked ? [[$(`[data-from="${k}"]`).value, $(`[data-to="${k}"]`).value]] : [];
      try {
        await api('PUT', `/api/users/${me.id}/settings`, {
          tz: $('#tz').value, interview_hours: hours, max_per_day: Number($('#maxd').value), max_per_week: Number($('#maxw').value),
          buffer_min: Number($('#buf').value), calendar_connected: $('#connected').checked,
        });
        state.me = await api('GET', '/api/me');
        toast('Availability saved.');
        render();
      } catch (err) { toast(err.message); }
    });
    $('#busy-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = $('#b-date').value;
      try {
        await api('POST', `/api/users/${me.id}/events`, {
          start: wallToIso(`${d}T${$('#b-from').value}`, me.tz), end: wallToIso(`${d}T${$('#b-to').value}`, me.tz), title: $('#b-title').value || 'Busy',
        });
        toast('Busy time added.');
        render();
      } catch (err) { toast(err.message); }
    });
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { await api('DELETE', `/api/events/${b.dataset.del}`); render(); }));
  },

  async inbox(el) {
    const msgs = await api('GET', '/api/outbox');
    const filter = store.get('tf_inbox', '');
    const recipients = [...new Set(msgs.map((m) => m.to_addr))].sort();
    const shown = filter ? msgs.filter((m) => m.to_addr === filter) : msgs;
    const kinds = { email: ['sea', 'Email'], calendar: ['leaf', 'Calendar invite'], slack: ['sun', 'Slack'] };
    el.innerHTML = statement(msgs.length ? `${plural(msgs.length, 'message')} sent so far.` : 'Nothing has been sent yet.',
      'Every email, calendar invite and Slack message TalentFlow would send. Booking links in candidate emails open the real candidate page.', null) + `
      <section class="section"><div class="label">Recipient<small><select id="to" aria-label="Recipient" style="margin-top:10px;max-width:100%"><option value="">Everyone</option>${recipients.map((r) => `<option ${r === filter ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></small></div>
        <div>${shown.length ? `<ul class="letters">${shown.map((m) => `<li class="letter">
          <div class="subject">${esc(m.subject)}</div>
          <div class="meta"><span class="tag ${kinds[m.channel]?.[0] || ''}">${esc(kinds[m.channel]?.[1] || m.channel)}</span><span>to ${esc(m.to_addr)}</span><span>${esc(fmt(new Date(m.created_at).toISOString(), state.me.tz))}</span></div>
          <pre>${linkify(esc(m.body))}</pre></li>`).join('')}</ul>` : '<p class="empty">Nothing for this recipient.</p>'}</div></section>`;
    $('#to').addEventListener('change', (e) => { store.set('tf_inbox', e.target.value); render(); });
  },

  async dashboard(el) {
    const m = await api('GET', '/api/metrics');
    const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
    const hrs = (x) => (x == null ? '–' : x < 1 ? `${Math.round(x * 60)} min` : `${x.toFixed(1)} h`);
    const title = m.medianHoursToSchedule == null
      ? 'No interviews have been booked through a link yet.'
      : `Candidates book in a median of ${hrs(m.medianHoursToSchedule)}.`;
    const maxSlots = Math.max(10, ...m.hmAvailability.map((h) => h.freeSlots45));
    el.innerHTML = statement(title, 'The goal is under four hours from link to booking, with at least four in five interviews booked by the candidate.', nowHour()) + `
      <section class="section"><div class="label">This period<small>A sun marks a figure on target.</small></div>
        <div class="figures">
          ${figure(hrs(m.medianHoursToSchedule), 'Median time from link sent to booked', m.medianHoursToSchedule != null && m.medianHoursToSchedule < 4)}
          ${figure(pct(m.selfScheduleRate), 'Booked by the candidate themselves', m.selfScheduleRate != null && m.selfScheduleRate >= 0.8)}
          ${figure(pct(m.rescheduleRate), 'Interviews that had to move', m.rescheduleRate != null && m.rescheduleRate < 0.15)}
          ${figure(pct(m.noShowRate), 'Candidates who did not show', m.noShowRate != null && m.noShowRate < 0.05)}
          ${figure(`${m.linksBooked} of ${m.linksSent}`, 'Links booked')}
        </div></section>
      <section class="section"><div class="label">Hiring managers<small>Free 45-minute interview slots in the next five working days. Fewer than three slows hiring down.</small></div>
        <div class="bars">${m.hmAvailability.map((h) => `<div class="bar-row"><span>${esc(h.name)}${h.calendarConnected ? '' : ' <span class="tag rose">disconnected</span>'}</span>
          <div class="track"><div class="fill ${h.freeSlots45 < 3 ? 'low' : ''}" style="width:${Math.max(3, (h.freeSlots45 / maxSlots) * 100)}%"></div></div><strong>${h.freeSlots45}</strong></div>`).join('')}</div></section>
      <section class="section"><div class="label">By role</div>
        <div class="table-wrap"><table><thead><tr><th>Role</th><th>Booked</th><th>Median time to book</th></tr></thead><tbody>
          ${m.byJob.map((j) => `<tr><td>${esc(j.job)}</td><td>${j.booked}</td><td>${hrs(j.medianHoursToSchedule)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No bookings yet.</td></tr>'}
        </tbody></table></div></section>`;
  },

  async audit(el) {
    const rows = await api('GET', '/api/audit');
    const sources = { web: 'Web app', candidate: 'Candidate page', calendar: 'Calendar', system: 'TalentFlow', seed: 'Demo setup' };
    el.innerHTML = statement('Everything that happened, and who did it.', 'Actions from the web app, candidates, calendars and AI assistants all land here.', null) + `
      <section class="section"><div class="label">Latest first</div>
        <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>From</th><th>What</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td class="muted small" style="white-space:nowrap">${esc(fmt(new Date(r.at).toISOString(), state.me.tz, { zone: false }))}</td><td>${esc(r.actor)}</td>
          <td><span class="tag ${r.source.startsWith('mcp') ? 'sun' : ''}">${esc(r.source.startsWith('mcp:') ? `AI assistant (${r.source.slice(4)})` : sources[r.source] || r.source)}</span></td>
          <td>${esc(r.action.replace(/[._]/g, ' '))}<div class="muted small"><code>${esc(r.details)}</code></div></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'}
        </tbody></table></div></section>`;
  },

  async connect(el) {
    const me = state.me;
    const origin = location.origin;
    const claudeConfig = JSON.stringify({
      mcpServers: {
        talentflow: { command: 'node', args: ['--disable-warning=ExperimentalWarning', '<path to talentflow-scheduling>/src/mcp-stdio.js'], env: { TALENTFLOW_TOKEN: me.apiToken } },
      },
    }, null, 2);
    el.innerHTML = statement('Schedule interviews from ChatGPT or Claude.',
      `Your assistant acts as ${esc(me.name)}, with the same permissions. It shows you a preview and waits for your yes before it sends, books, moves or cancels anything.`, nowHour()) + `
      <section class="section"><div class="label">How it works</div>
        <div><p>See the <a href="/how-ai-connects.html">technical breakdown with diagrams</a>: how the assistant reaches TalentFlow, what each request looks like, and where the safety checks happen.</p></div></section>
      <section class="section"><div class="label">Your token<small>Keep it private. In production this becomes sign-in through your company account.</small></div>
        <div><code style="word-break:break-all;font-size:14px">${esc(me.apiToken)}</code></div></section>
      <section class="section"><div class="label">Claude Desktop</div>
        <div><p>Add this to <code>claude_desktop_config.json</code> (Settings, Developer, Edit config), replace the path, then restart Claude.</p>
          <pre class="email-preview">${esc(claudeConfig)}</pre></div></section>
      <section class="section"><div class="label">Claude or ChatGPT on the web</div>
        <div><p>Connect to <code>${esc(origin)}/mcp</code> with the header <code>Authorization: Bearer</code> and your token. Web assistants can't reach your computer directly, so share it first, for example with <code>cloudflared tunnel --url ${esc(origin)}</code>, and use the address it prints.</p>
          <p class="muted">ChatGPT developer mode can't send headers, so it can use <code>/mcp?token=</code> followed by your token. Use that only for testing.</p></div></section>
      <section class="section"><div class="label">Things to ask</div>
        <div><ul class="letters">
          <li class="letter"><div class="subject">"Set up an HR screen for Leo, mornings PT, not Friday."</div></li>
          <li class="letter"><div class="subject">"When could Ben meet Marcus next week?"</div></li>
          <li class="letter"><div class="subject">"Something came up. Move my interview with Ben."</div></li>
        </ul></div></section>`;
  },
};

function figure(value, label, good) {
  return `<div class="figure"><div class="num">${esc(value)}${good ? '<span class="ok" title="On target" aria-label="On target"></span>' : ''}</div><div class="lbl">${esc(label)}</div></div>`;
}

function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

// ---------------------------------------------------------------- pipeline rows & actions

function needsAction(a) {
  if (a.stage === 'rejected' || a.nextInterview || a.latestLink?.status === 'active') return false;
  return ['applied', 'hr_screen', 'hm_interview'].includes(a.stage);
}

function journey(stage) {
  const steps = ['applied', 'hr_screen', 'hm_interview'];
  if (stage === 'rejected') return `<div class="journey" aria-hidden="true"><i></i><b></b><i></i><b></b><i class="closed"></i></div>`;
  const at = stage === 'offer' ? 3 : steps.indexOf(stage);
  return `<div class="journey" aria-hidden="true">${steps.map((_, i) => `${i ? `<b class="${i <= at ? 'done' : ''}"></b>` : ''}<i class="${i < at ? 'done' : i === at ? 'now' : ''}"></i>`).join('')}</div>`;
}

function schedulingStatus(a) {
  const tz = state.me.tz;
  if (a.nextInterview) return `<span class="tag leaf">${esc(TYPE_NAMES[a.nextInterview.type])} booked</span><div class="sched-when">${esc(fmt(a.nextInterview.start, tz))}</div>`;
  if (a.latestLink?.status === 'active') return `<span class="tag sun">Choosing a time</span><div class="sched-when">Link open until ${esc(fmt(a.latestLink.expiresAt, tz, { zone: false }))}</div>`;
  if (a.latestLink?.status === 'expired') return `<span class="tag rose">Link expired</span><div class="sched-when">Send new times or close</div>`;
  if (a.lastCompleted?.status === 'held') return `<span class="tag sea">${esc(TYPE_NAMES[a.lastCompleted.type])} done</span>`;
  if (a.lastCompleted) return `<span class="tag rose">${esc(a.lastCompleted.status === 'no_show_candidate' ? 'Missed' : 'Interviewer missed')} ${esc(TYPE_NAMES[a.lastCompleted.type])}</span>`;
  if (a.stage === 'rejected') return '<span class="tag rose">Closed</span>';
  return '<span class="tag">Not scheduled</span>';
}

function personRow(a, isRecruiter) {
  const now = new Date().toISOString();
  const btn = (act, label, cls = '') => `<button class="small ${cls}" data-act="${act}" data-app="${esc(a.id)}">${label}</button>`;
  const actions = [];
  if (isRecruiter && a.stage !== 'rejected') {
    const screenDone = a.lastCompleted?.type === 'hr_screen' && a.lastCompleted.status === 'held';
    const linkOpen = a.latestLink?.status === 'active';
    if (a.stage === 'applied') actions.push(btn('to_hr', 'Schedule HR screen', 'primary'));
    if (a.stage === 'hr_screen' && !a.nextInterview && !screenDone) actions.push(btn('link_hr', linkOpen ? 'Send new times' : 'Schedule HR screen', linkOpen ? '' : 'primary'));
    if (a.stage === 'hr_screen' && screenDone) actions.push(btn('pass', 'Passed the screen', 'primary'), btn('fail', 'Not a fit'));
    if (a.stage === 'hm_interview' && !a.nextInterview) {
      const sent = linkOpen && a.latestLink.type === 'hm_interview';
      actions.push(btn('link_hm', sent ? 'Send new times' : 'Schedule HM interview', sent ? '' : 'primary'));
    }
    if (a.stage !== 'applied') actions.push(btn('reject', 'Close', 'quiet danger'));
  }
  return `<li class="person">
    <div><div class="name">${esc(a.candidate.name)}</div>
      <div class="where">${sunArc(localHour(now, a.candidate.tz), { size: 22 })}${esc(city(a.candidate.tz))}, ${esc(clockOnly(now, a.candidate.tz))} now</div></div>
    <div>${journey(a.stage)}<div class="journey-label">${esc(STAGE_WORDS[a.stage] || a.stage)}</div></div>
    <div>${schedulingStatus(a)}</div>
    <div class="actions">${actions.join('')}</div></li>`;
}

async function appAction(act, app) {
  try {
    if (act === 'to_hr' || act === 'link_hr') return scheduleModal(app, 'hr_screen');
    if (act === 'link_hm') return scheduleModal(app, 'hm_interview');
    if (act === 'pass') {
      await api('POST', `/api/applications/${app.id}/screen`, { pass: true });
      toast(`${firstName(app.candidate.name)} moved to the hiring manager interview.`);
      return scheduleModal({ ...app, stage: 'hm_interview' }, 'hm_interview');
    }
    if (act === 'fail' || act === 'reject') {
      if (!confirm(`Close ${app.candidate.name}'s application? They'll get a kind email letting them know.`)) return;
      if (act === 'fail') await api('POST', `/api/applications/${app.id}/screen`, { pass: false });
      else await api('POST', `/api/applications/${app.id}/stage`, { stage: 'rejected' });
      toast(`Closed. ${firstName(app.candidate.name)} has been told.`);
      render();
    }
  } catch (err) { toast(err.message); }
}

function slotsHtml(slots, candidateTz, candidateName, limit = 12) {
  if (!slots.length) return '';
  const mine = state.me.tz;
  return `<p class="slot-zone">Your times, ${esc(city(mine))}</p><div class="slot-grid">${slots.slice(0, limit).map((s) => `<div class="slot">${sunArc(localHour(s.start, candidateTz), { size: 30 })}
    <div><div class="t">${esc(fmt(s.start, mine, { zone: false }))}</div>${candidateTz !== mine ? `<div class="sub">${esc(clockOnly(s.start, candidateTz))} for ${esc(firstName(candidateName))}</div>` : ''}</div></div>`).join('')}</div>
    ${slots.length > limit ? `<p class="muted small" style="margin-top:8px">And ${slots.length - limit} more.</p>` : ''}`;
}

function availabilityNotes(r) {
  const out = [];
  if (r.disconnected?.length) out.push(`<div class="note bad">${esc(r.disconnected.map((u) => u.name).join(', '))} needs to reconnect their calendar before times can be offered. You can still book a time you've agreed.</div>`);
  if (r.widened) out.push(`<div class="note warn">There were fewer than three times in the next five working days, so this looks ten days ahead. You'll get a note that availability is low.</div>`);
  else if (r.lowAvailability && r.slots.length) out.push(`<div class="note warn">Only ${plural(r.slots.length, 'time')} available. Consider asking for more interview hours.</div>`);
  if (!r.slots.length && r.outsideCandidateHours) out.push(`<div class="note bad">The interviewers are free ${plural(r.outsideCandidateHours, 'time')}, but every one is before 07:00 or after 21:00 in ${esc(city(r.application.candidateTz))}. Agree a time with ${esc(firstName(r.application.candidate))} and book it below.</div>`);
  else if (!r.slots.length && !r.disconnected?.length) out.push('<div class="note bad">No free times in the next ten working days, so nothing will be sent. Ask the interviewer to open more hours.</div>');
  return out.join('');
}

async function scheduleModal(app, type) {
  const typeName = TYPE_NAMES[type];
  const now = new Date().toISOString();
  const first = firstName(app.candidate.name);
  const modal = openModal(`
    <header><div><h2>${esc(typeName)} with ${esc(app.candidate.name)}</h2>
      <div class="muted">${esc(app.job)}. ${esc(first)} is in ${esc(city(app.candidate.tz))}, where it's ${esc(clockOnly(now, app.candidate.tz))}.</div></div>
      <button class="close" data-close aria-label="Close">✕</button></header>
    <div class="field"><label for="pref">Any preferences?</label>
      <div class="row"><input type="text" id="pref" class="grow" placeholder="Mornings, not Friday, next week after 2pm…"><button id="refresh">Update times</button></div></div>
    <div id="preview"><p class="muted">Finding times…</p></div>
    <div class="field" style="margin-top:18px"><label for="note">Add a note to the email</label><textarea id="note" placeholder="Optional. For example: Looking forward to speaking with you."></textarea></div>
    <footer><button class="quiet" data-close>Cancel</button><button class="primary" id="send" disabled>Send times to ${esc(first)}</button></footer>
    <hr class="rule">
    <h3>Already agreed a time with ${esc(first)}?</h3>
    <div class="row"><input type="datetime-local" id="direct" aria-label="Agreed time"><span class="muted small">your time (${esc(city(state.me.tz))})</span><button id="direct-check">Check this time</button></div>
    <div id="direct-out" style="margin-top:12px"></div>`, `${typeName} with ${app.candidate.name}`);
  const load = async () => {
    const box = $('#preview', modal);
    box.innerHTML = '<p class="muted">Finding times…</p>';
    try {
      show(await api('POST', `/api/applications/${app.id}/links`, { type, text: $('#pref', modal).value, confirm: false }));
    } catch (err) {
      if (err.data?.slots) show(err.data); else box.innerHTML = `<div class="note bad">${esc(err.message)}</div>`;
    }
  };
  const show = (r) => {
    const people = r.required.map((u) => u.name).join(' and ');
    $('#preview', modal).innerHTML = `
      ${r.understood?.length ? `<div class="understood">Looking for ${r.understood.map((u) => `<span>${esc(u)}</span>`).join('')}</div>` : ''}
      ${availabilityNotes(r)}
      ${r.slots.length ? `<p><strong>${plural(r.slots.length, 'time')}</strong> when ${esc(people)} ${r.required.length > 1 ? 'are' : 'is'} free${r.optional?.length ? `, with ${esc(r.optional.map((u) => u.name).join(', '))} joining when free` : ''}. ${esc(first)} picks one.</p>` : ''}
      ${slotsHtml(r.slots, r.application.candidateTz, r.application.candidate)}
      ${r.email ? `<details style="margin-top:14px"><summary>See the email ${esc(first)} will get</summary><div class="email-preview"><div class="subject">${esc(r.email.subject)}</div><pre>${esc(r.email.body)}</pre></div></details>` : ''}`;
    $('#send', modal).disabled = !r.slots.length;
  };
  $('#refresh', modal).addEventListener('click', load);
  $('#pref', modal).addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  $('#send', modal).addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/applications/${app.id}/links`, { type, text: $('#pref', modal).value, message: $('#note', modal).value || undefined });
      closeModal();
      toast(`Sent ${plural(r.slots.length, 'time')} to ${first}.`);
      render();
    } catch (err) { toast(err.message); }
  });
  $('#direct-check', modal).addEventListener('click', async () => {
    const v = $('#direct', modal).value;
    const out = $('#direct-out', modal);
    if (!v) { out.innerHTML = '<div class="note">Pick a date and time first.</div>'; return; }
    const start = wallToIso(v, state.me.tz);
    try {
      const p = await api('POST', `/api/applications/${app.id}/book`, { type, start, confirm: false });
      out.innerHTML = `<div class="note ${p.warnings.length ? 'warn' : 'good'}">
        <div class="row">${sunArc(localHour(start, app.candidate.tz), { size: 30 })}<span><strong>${esc(p.candidateTime)}</strong> for ${esc(first)}. With ${esc(p.attendees.map((x) => `${x.name} (${x.time})`).join(', '))}.</span></div>
        ${p.warnings.map((w) => `<div style="margin-top:6px">${esc(w)}</div>`).join('')}</div><button class="primary" id="direct-confirm">Book it and send invites</button>`;
      $('#direct-confirm', modal).addEventListener('click', async () => {
        try {
          await api('POST', `/api/applications/${app.id}/book`, { type, start });
          closeModal();
          toast('Booked. Invites are on their way.');
          render();
        } catch (err) { toast(err.message); }
      });
    } catch (err) { out.innerHTML = `<div class="note bad">${esc(err.message)}</div>`; }
  });
  load();
}

// ---------------------------------------------------------------- interviews

function meetingRow(iv, now) {
  const tz = state.me.tz;
  const started = Date.parse(iv.start) <= now;
  const attending = iv.attendees.some((a) => a.id === state.me.id);
  const statusTag = { scheduled: ['leaf', 'Booked'], held: ['sea', 'Held'], cancelled: ['rose', 'Cancelled'], rescheduled: ['', 'Moved'], no_show_candidate: ['rose', 'Candidate missed it'], no_show_interviewer: ['rose', 'Interviewer missed it'] }[iv.status] || ['', iv.status];
  const b = (act, label, cls = '') => `<button class="small ${cls}" data-iv="${esc(iv.id)}" data-ivact="${act}">${label}</button>`;
  const actions = [];
  if (iv.status === 'scheduled') {
    if (!started) actions.push(b('reschedule', 'Move'), b('cancel', 'Cancel', 'quiet danger'));
    if (!started && attending) actions.push(b('decline', 'Decline in my calendar', 'quiet'));
    if (started) actions.push(b('held', 'It happened', 'primary'), b('no_show_candidate', 'Candidate didn\'t join'), b('no_show_interviewer', 'Interviewer didn\'t join'));
  }
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).format(new Date(iv.start));
  const part = (o) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date(iv.start));
  const wm = `${part({ weekday: 'short' })}, ${part({ month: 'short' })}`;
  const first = firstName(iv.candidate);
  return `<li class="meeting">
    <div class="day"><div class="d">${esc(day)}</div><div class="m">${esc(wm)}</div></div>
    <div><h3>${esc(iv.typeName)} with ${esc(iv.candidate)}</h3>
      <div class="when">${sunArc(localHour(iv.start, iv.candidateTz), { size: 30 })}
        <span><strong>${esc(clockOnly(iv.start, tz))}</strong> <span class="muted">for you${iv.candidateTz !== tz ? `, ${esc(clockOnly(iv.start, iv.candidateTz))} for ${esc(first)} in ${esc(city(iv.candidateTz))}` : ''}</span></span></div>
      <div class="muted small">${esc(iv.job)}. With ${esc(iv.attendees.map((a) => a.name).join(' and '))}. ${iv.bookedVia === 'link' ? `${esc(first)} chose this time.` : 'Booked directly.'}</div>
      <div class="row" style="margin-top:8px"><span class="tag ${statusTag[0]}">${esc(statusTag[1])}</span>
        ${iv.accommodationRequested ? '<span class="tag sun">Accommodation requested</span>' : ''}
        ${iv.videoUrl && iv.status === 'scheduled' ? `<a class="small" href="${esc(iv.videoUrl)}" target="_blank" rel="noopener">Video link</a>` : ''}</div>
    </div>
    <div class="actions">${actions.join('')}</div></li>`;
}

async function interviewAction(act, iv) {
  const first = firstName(iv.candidate);
  try {
    if (act === 'reschedule') return rescheduleModal(iv);
    if (act === 'cancel') {
      const reason = prompt(`Cancel the ${iv.typeName} with ${iv.candidate}? Everyone will be told. Reason:`, 'The role is on hold');
      if (reason === null) return;
      await api('POST', `/api/interviews/${iv.id}/cancel`, { reason });
      toast('Cancelled. Everyone has been told.');
    } else if (act === 'decline') {
      if (!confirm(`This acts as if you declined the invite in your calendar. ${first} will get new times with an apology. Continue?`)) return;
      await api('POST', `/api/interviews/${iv.id}/decline`);
      toast(`Declined. ${first} has new times to choose from.`);
    } else {
      const r = await api('POST', `/api/interviews/${iv.id}/outcome`, { outcome: act });
      toast(act === 'held' ? 'Marked as held. Scorecard reminders sent.' : r.rebookLink ? `Recorded. ${first} has a link to pick a new time.` : 'Recorded.');
    }
    render();
  } catch (err) { toast(err.message); }
}

function rescheduleModal(iv) {
  const first = firstName(iv.candidate);
  const modal = openModal(`
    <header><div><h2>Move the ${esc(iv.typeName)} with ${esc(iv.candidate)}</h2>
      <div class="muted">Now ${esc(fmt(iv.start, state.me.tz))}</div></div><button class="close" data-close aria-label="Close">✕</button></header>
    <div class="field"><label for="reason">Why is it moving?</label><input type="text" id="reason" class="wide" value="A conflict came up"></div>
    <div class="field"><label for="pref">Any preferences for the new time?</label>
      <div class="row"><input type="text" id="pref" class="grow" placeholder="Next week, mornings…"><button id="refresh">Update times</button></div></div>
    <div id="preview"><p class="muted">Finding times…</p></div>
    <footer><button class="quiet" data-close>Keep the current time</button><button class="primary" id="go">Send ${esc(first)} new times</button></footer>`, `Move interview with ${iv.candidate}`);
  const load = async () => {
    try {
      const r = await api('POST', `/api/interviews/${iv.id}/reschedule`, { reason: $('#reason', modal).value, text: $('#pref', modal).value, confirm: false });
      $('#preview', modal).innerHTML = `${availabilityNotes(r.next)}${r.next.slots.length ? `<p>${esc(first)} will get <strong>${plural(r.next.slots.length, 'new time')}</strong> and a short apology. The current time is released for everyone.</p>` : ''}
        ${slotsHtml(r.next.slots, r.next.application.candidateTz, iv.candidate, 9)}`;
      $('#go', modal).disabled = !r.next.slots.length;
    } catch (err) { $('#preview', modal).innerHTML = `<div class="note bad">${esc(err.message)}</div>`; }
  };
  $('#refresh', modal).addEventListener('click', load);
  $('#go', modal).addEventListener('click', async () => {
    try {
      await api('POST', `/api/interviews/${iv.id}/reschedule`, { reason: $('#reason', modal).value, text: $('#pref', modal).value });
      closeModal();
      toast(`Moved. ${first} has new times to choose from.`);
      render();
    } catch (err) { toast(err.message); }
  });
  load();
}

// ---------------------------------------------------------------- router

async function render() {
  const view = (location.hash.replace(/^#\//, '').split('/')[0]) || 'pipeline';
  const name = views[view] ? view : 'pipeline';
  document.querySelectorAll('#tabs a').forEach((a) => {
    const on = a.dataset.view === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const el = $('#view');
  try {
    await views[name](el);
  } catch (err) {
    el.innerHTML = `<div class="note bad" style="margin-top:40px">${esc(err.message)}</div>`;
  }
  refreshClock().catch(() => {});
  refreshInboxCount().catch(() => {});
}

window.addEventListener('hashchange', render);
loadBase().then(render).catch((err) => { $('#view').innerHTML = `<div class="note bad">${esc(err.message)}</div>`; });
setInterval(() => { refreshClock().catch(() => {}); }, 30_000);
