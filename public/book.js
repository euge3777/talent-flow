// Candidate booking page (SCH-10..14, SCH-18). No login: the link token is the credential.

import { localHour, sunArc } from '/sun.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = location.pathname.split('/').pop();
const page = $('#page');

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
let tz = store.get('tf_cand_tz', detected);
let data = null;
let hold = null;
let holdTimer = null;

async function api(method, path, body) {
  const res = await fetch(`/api/public/links/${encodeURIComponent(token)}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || 'Something went wrong. Try again in a moment.');
    err.code = json.error;
    err.data = json.data;
    throw err;
  }
  return json;
}

const city = (z) => z.split('/').pop().replace(/_/g, ' ');
const fmtWeekday = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(iso));
const fmtDate = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric' }).format(new Date(iso));
const fmtTime = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const fmtLong = (iso) => `${fmtWeekday(iso)}, ${fmtDate(iso)} at ${fmtTime(iso)}`;
const meetWith = () => (data.interviewers?.length ? ` to meet ${data.interviewers.join(' and ')}` : '');

function brand() {
  $('#brand').innerHTML = `<em>${esc(data.company)}</em><span>${esc(data.job)}</span>`;
  document.title = `${data.interviewType.name} with ${data.company}`;
}

function zonePicker() {
  const zones = [...new Set([tz, detected, data?.candidate?.tz, 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'Europe/London', 'Europe/Lisbon', 'Europe/Rome', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney'].filter(Boolean))];
  return `<div class="zone"><label class="chip">Times in<select id="tz" aria-label="Time zone">${zones.map((z) => `<option value="${esc(z)}" ${z === tz ? 'selected' : ''}>${esc(city(z))}</option>`).join('')}</select></label></div>`;
}

function bindZone() {
  $('#tz')?.addEventListener('change', (e) => {
    tz = e.target.value;
    store.set('tf_cand_tz', tz);
    render();
  });
}

async function load() {
  try {
    data = await api('GET', '');
  } catch (err) {
    page.innerHTML = `<section class="statement"><h1>This link isn't working.</h1><p>${esc(err.message)} Check the latest email from your recruiter.</p></section>`;
    return;
  }
  if (data.nextToken && data.status === 'rescheduled') {
    location.replace(`/book/${data.nextToken}`);
    return;
  }
  brand();
  render();
}

function render() {
  clearInterval(holdTimer);
  if (data.status === 'active') return hold ? renderConfirm() : renderSlots();
  if (data.status === 'booked') return renderBooked();
  const why = {
    expired: "This link has expired. Your recruiter knows and will send new times if you're still interested.",
    void: 'A newer link was sent to you. Use the most recent email from your recruiter.',
    rescheduled: 'This interview moved. Check your email for the new times.',
  }[data.status] || 'This link can no longer be used.';
  page.innerHTML = `<section class="statement"><h1>This link is closed.</h1><p>${esc(why)}</p></section>`;
}

function renderSlots(notice) {
  const t = data.interviewType;
  const groups = new Map();
  for (const s of data.slots) {
    const key = `${fmtWeekday(s.start)}|${fmtDate(s.start)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  page.innerHTML = `
    <section class="statement">
      <span class="ornament">${sunArc(localHour(new Date().toISOString(), tz), { size: 72 })}</span>
      <h1>Hi ${esc(data.candidate.firstName)}, pick a time${esc(meetWith())}.</h1>
      <p>${esc(t.name)} for ${esc(data.job)}. ${t.durationMin} minutes, on ${esc(t.format)}.</p>
      ${t.prepNotes ? `<p class="prep">${esc(t.prepNotes)}</p>` : ''}
    </section>
    ${zonePicker()}
    ${notice ? `<div class="panel"><div class="note warn">${esc(notice)}</div></div>` : ''}
    ${data.slots.length ? `<div class="days">${[...groups].map(([key, slots]) => {
      const [weekday, date] = key.split('|');
      return `<section class="section"><div class="label">${esc(weekday)}<small>${esc(date)}</small></div>
        <div class="times">${slots.map((s) => `<button data-start="${esc(s.start)}" aria-label="${esc(fmtLong(s.start))}">${sunArc(localHour(s.start, tz), { size: 26 })}${esc(fmtTime(s.start))}</button>`).join('')}</div></section>`;
    }).join('')}</div>` : '<p class="empty">There are no open times right now. Suggest some below and your recruiter will get back to you.</p>'}
    <details class="other" ${data.slots.length ? '' : 'open'}><summary>None of these work for me</summary>
      <form id="suggest" style="margin-top:16px">
        <p class="muted">Suggest up to three times in ${esc(city(tz))} time. Your recruiter will reply by email.</p>
        ${[1, 2, 3].map((i) => `<div class="field"><input type="datetime-local" name="t${i}" aria-label="Suggested time ${i}" ${i === 1 ? 'required' : ''}></div>`).join('')}
        <div class="field"><textarea name="note" placeholder="Anything we should know? (optional)"></textarea></div>
        <button type="submit">Send my times</button>
      </form></details>`;
  bindZone();
  page.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.start, b)));
  $('#suggest').addEventListener('submit', suggest);
}

async function pick(start, btn) {
  btn.setAttribute('aria-pressed', 'true');
  btn.disabled = true;
  try {
    hold = await api('POST', '/hold', { start });
    render();
    window.scrollTo({ top: 0 });
  } catch (err) {
    if (err.data?.slots) data.slots = err.data.slots;
    renderSlots(err.message);
  }
}

function renderConfirm(notice) {
  page.innerHTML = `
    <section class="statement hold">
      <span class="ornament">${sunArc(localHour(hold.start, tz), { size: 120 })}</span>
      <h1>${esc(fmtLong(hold.start))}</h1>
      <p>${esc(city(tz))} time. We're holding it for you for <strong class="left" id="countdown">15:00</strong>.</p>
    </section>
    <div class="panel">
      ${notice ? `<div class="note bad">${esc(notice)}</div>` : ''}
      <div class="field"><label for="acc">Do you need anything to make the interview work for you?</label>
        <textarea id="acc" placeholder="Optional and private: captions, extra time, a step-free route. Only your recruiter sees this."></textarea></div>
      <div class="actions-center"><button class="quiet" id="back">Pick another time</button><button class="primary" id="confirm">Confirm this time</button></div>
    </div>`;
  const tick = () => {
    const left = Math.max(0, Date.parse(hold.expiresAt) - Date.now());
    const el = $('#countdown');
    if (el) el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  };
  tick();
  holdTimer = setInterval(tick, 1000);
  $('#back').addEventListener('click', async () => { hold = null; await load(); });
  $('#confirm').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Confirming…';
    try {
      await api('POST', '/book', { holdId: hold.holdId, tz, accommodation: $('#acc').value.trim() || undefined });
      hold = null;
      justBooked = true;
      await load();
    } catch (err) {
      hold = null;
      if (err.data?.slots) data.slots = err.data.slots;
      renderSlots(err.message);
    }
  });
}

let justBooked = false;

function renderBooked(notice) {
  const iv = data.interview;
  const cancelled = iv.status !== 'scheduled';
  page.innerHTML = `
    <section class="statement">
      ${cancelled ? '' : `<span class="ornament">${sunArc(localHour(iv.start, tz), { size: 160, rise: justBooked })}</span>`}
      <h1>${cancelled ? 'This interview was cancelled.' : `You're booked, ${esc(data.candidate.firstName)}.`}</h1>
      <p>${esc(fmtLong(iv.start))}, ${esc(city(tz))} time${iv.interviewers.length ? `, with ${esc(iv.interviewers.join(' and '))}` : ''}.</p>
    </section>
    ${zonePicker()}
    ${notice ? `<div class="panel"><div class="note">${esc(notice)}</div></div>` : ''}
    <dl class="facts">
      <dt>Interview</dt><dd>${esc(data.interviewType.name)} for ${esc(data.job)}</dd>
      <dt>Length</dt><dd>${data.interviewType.durationMin} minutes</dd>
      ${iv.videoUrl && !cancelled ? `<dt>Join</dt><dd><a href="${esc(iv.videoUrl)}" target="_blank" rel="noopener">${esc(iv.videoUrl)}</a></dd>` : ''}
      ${data.interviewType.prepNotes ? `<dt>Prepare</dt><dd>${esc(data.interviewType.prepNotes)}</dd>` : ''}
    </dl>
    ${cancelled ? '' : `<div class="actions-center">
      <a class="btn primary" href="/api/public/links/${encodeURIComponent(token)}/ics">Add to my calendar</a>
      ${iv.canReschedule ? `<button id="resched">${iv.rescheduleGoesToRecruiter ? 'Ask to change the time' : 'Change the time'}</button>` : ''}
      ${iv.canCancel ? '<button class="quiet danger" id="cancel">Cancel interview</button>' : ''}
    </div>
    ${!iv.canReschedule ? '<p class="muted small" style="text-align:center;margin-top:18px">Changes are possible up to four hours before. After that, reply to your recruiter\'s email.</p>' : ''}`}`;
  justBooked = false;
  bindZone();
  $('#resched')?.addEventListener('click', async () => {
    const msg = iv.rescheduleGoesToRecruiter
      ? "You've already changed the time once, so we'll ask your recruiter to find a new time with you. Continue?"
      : 'Release this time and pick a new one?';
    if (!confirm(msg)) return;
    try {
      const r = await api('POST', '/reschedule');
      if (r.nextToken) location.replace(`/book/${r.nextToken}`);
      else renderBooked(r.message);
    } catch (err) { renderBooked(err.message); }
  });
  $('#cancel')?.addEventListener('click', async () => {
    const reason = prompt('Cancel your interview? You can tell us why (optional):', '');
    if (reason === null) return;
    try {
      await api('POST', '/cancel', { reason: reason || undefined });
      await load();
    } catch (err) { renderBooked(err.message); }
  });
}

function wallToIso(v) {
  const [d, t] = v.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, h, mi);
  const off = (ms) => {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  };
  return new Date(guess - off(guess - off(guess))).toISOString();
}

async function suggest(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const times = ['t1', 't2', 't3'].map((k) => f.get(k)).filter(Boolean).map(wallToIso);
  try {
    await api('POST', '/suggest', { times, note: f.get('note') || undefined });
    page.innerHTML = `<section class="statement"><h1>Thanks. Your times are with your recruiter.</h1><p>They'll confirm one with you by email.</p></section>`;
  } catch (err) { renderSlots(err.message); }
}

load();
