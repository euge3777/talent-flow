// Demo data. Run `npm run seed` to reset the database.
// Busy blocks are generated relative to today so the demo always has
// realistic calendars: Marcus (Engineering HM) is busy but workable, Dana
// (Design HM) is overbooked, which shows the low-availability path (SCH-7).

import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { DEFAULT_DB, openDb, run, tx } from './db.js';
import { addDaysKey, dateKey, weekdayOfKey, zonedToUtc } from './tz.js';
import { Scheduler } from './scheduler.js';

const weekdays = (from, to) => ({ mon: [[from, to]], tue: [[from, to]], wed: [[from, to]], thu: [[from, to]], fri: [[from, to]] });

const USERS = [
  {
    id: 'u_riya', name: 'Riya Patel', email: 'riya@acme.example', role: 'recruiter', tz: 'America/Los_Angeles',
    hours: weekdays('09:00', '17:00'), maxDay: 6, maxWeek: 25, buffer: 10, region: 'US',
  },
  {
    id: 'u_marcus', name: 'Marcus Lee', email: 'marcus@acme.example', role: 'hm', tz: 'America/Los_Angeles',
    hours: { tue: [['10:00', '16:00']], wed: [['10:00', '16:00']], thu: [['10:00', '16:00']] }, maxDay: 3, maxWeek: 8, buffer: 10, region: 'US',
  },
  {
    id: 'u_dana', name: 'Dana Kim', email: 'dana@acme.example', role: 'hm', tz: 'America/New_York',
    hours: { mon: [['13:00', '17:00']], wed: [['13:00', '17:00']], fri: [['13:00', '17:00']] }, maxDay: 2, maxWeek: 5, buffer: 10, region: 'US',
  },
  {
    id: 'u_cleo', name: 'Cleo Martin', email: 'cleo@acme.example', role: 'coordinator', tz: 'America/Los_Angeles',
    hours: weekdays('08:00', '16:00'), maxDay: 8, maxWeek: 30, buffer: 5, region: 'US',
  },
];

const CANDIDATES = [
  ['c_ana', 'Ana Silva', 'ana.silva@mail.example', 'Europe/Lisbon'],
  ['c_ben', 'Ben Ortiz', 'ben.ortiz@mail.example', 'America/Chicago'],
  ['c_leo', 'Leo Novak', 'leo.novak@mail.example', 'America/New_York'],
  ['c_chen', 'Chen Wei', 'chen.wei@mail.example', 'Asia/Singapore'],
  ['c_mia', 'Mia Rossi', 'mia.rossi@mail.example', 'Europe/Rome'],
  ['c_priya', 'Priya Shah', 'priya.shah@mail.example', 'Europe/London'],
  ['c_ravi', 'Ravi Kumar', 'ravi.kumar@mail.example', 'Asia/Kolkata'],
];

const APPLICATIONS = [
  ['app_ana', 'c_ana', 'job_backend', 'applied'],
  ['app_ben', 'c_ben', 'job_backend', 'hm_interview'],
  ['app_leo', 'c_leo', 'job_backend', 'applied'],
  ['app_chen', 'c_chen', 'job_design', 'applied'],
  ['app_mia', 'c_mia', 'job_design', 'applied'],
  ['app_priya', 'c_priya', 'job_design', 'hr_screen'],
  ['app_ravi', 'c_ravi', 'job_backend', 'applied'],
];

/** Recurring busy blocks by weekday, in each user's own time zone. */
const BUSY = {
  u_riya: {
    1: [['09:00', '09:30', 'Team standup'], ['12:00', '13:00', 'Lunch']],
    2: [['09:00', '09:30', 'Team standup'], ['12:00', '13:00', 'Lunch'], ['14:00', '15:30', 'Sourcing block']],
    3: [['09:00', '09:30', 'Team standup'], ['12:00', '13:00', 'Lunch'], ['15:00', '16:00', 'TA weekly']],
    4: [['09:00', '09:30', 'Team standup'], ['12:00', '13:00', 'Lunch'], ['10:00', '11:00', '1:1 with Dana']],
    5: [['09:00', '09:30', 'Team standup'], ['12:00', '13:00', 'Lunch'], ['13:00', '17:00', 'Focus time']],
  },
  u_marcus: {
    2: [['13:00', '15:00', 'Architecture review'], ['10:00', '10:30', 'Eng standup']],
    3: [['10:00', '12:00', 'Planning'], ['14:30', '15:00', 'Eng standup']],
    4: [['13:00', '15:00', 'Incident review'], ['10:00', '10:30', 'Eng standup']],
  },
  u_dana: {
    1: [['13:00', '16:00', 'Design crit']],
    3: [['14:00', '17:00', 'Roadmap workshop']],
    5: [['13:00', '15:30', 'Design reviews']],
  },
  u_cleo: {},
};

const HOLIDAYS = [
  ['US', '2026-11-26', 'Thanksgiving'], ['US', '2026-12-25', 'Christmas Day'], ['US', '2027-01-01', "New Year's Day"],
  ['US', '2027-01-18', 'Martin Luther King Jr. Day'], ['SG', '2026-12-25', 'Christmas Day'], ['SG', '2027-01-01', "New Year's Day"],
];

export function seed(db, { clock = Date.now, withBooking = true } = {}) {
  const now = clock();
  tx(db, () => {
    for (const t of ['audit', 'outbox', 'holds', 'interviews', 'scheduling_links', 'calendar_events', 'applications',
      'candidates', 'interview_types', 'jobs', 'holidays', 'users', 'settings']) {
      run(db, `DELETE FROM ${t}`);
    }
    for (const u of USERS) {
      run(db,
        `INSERT INTO users (id, name, email, role, tz, interview_hours, max_per_day, max_per_week, buffer_min, holiday_region, api_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        u.id, u.name, u.email, u.role, u.tz, JSON.stringify(u.hours), u.maxDay, u.maxWeek, u.buffer, u.region,
        `tf_${u.id.slice(2)}_${randomBytes(12).toString('hex')}`);
    }
    for (const h of HOLIDAYS) run(db, 'INSERT INTO holidays (region, date, name) VALUES (?, ?, ?)', ...h);

    run(db, `INSERT INTO jobs (id, title, company, recruiter_id, hm_id, video_provider) VALUES (?, ?, ?, ?, ?, ?)`,
      'job_backend', 'Senior Backend Engineer', 'Acme', 'u_riya', 'u_marcus', 'zoom');
    run(db, `INSERT INTO jobs (id, title, company, recruiter_id, hm_id, video_provider) VALUES (?, ?, ?, ?, ?, ?)`,
      'job_design', 'Product Designer', 'Acme', 'u_riya', 'u_dana', 'google_meet');

    const types = [
      ['it_be_hr', 'job_backend', 'hr_screen', 'HR screen', 30, ['recruiter'], [], 'A short intro call about your background and what you are looking for.'],
      ['it_be_hm', 'job_backend', 'hm_interview', 'Hiring manager interview', 60, ['hm'], ['recruiter'], 'A conversation about a system you designed. No live coding.'],
      ['it_de_hr', 'job_design', 'hr_screen', 'HR screen', 30, ['recruiter'], [], 'A short intro call about your background and what you are looking for.'],
      ['it_de_hm', 'job_design', 'hm_interview', 'Hiring manager interview', 45, ['hm'], ['recruiter'], 'Please bring one project to walk through (10 minutes).'],
    ];
    for (const [id, job, key, name, dur, req, opt, prep] of types) {
      run(db, `INSERT INTO interview_types (id, job_id, key, name, duration_min, required_roles, optional_roles, format, prep_notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'video', ?)`, id, job, key, name, dur, JSON.stringify(req), JSON.stringify(opt), prep);
    }

    for (const [id, name, email, tz] of CANDIDATES) {
      run(db, 'INSERT INTO candidates (id, name, email, tz, resume_url) VALUES (?, ?, ?, ?, ?)',
        id, name, email, tz, `https://files.example.com/resumes/${id}.pdf`);
    }
    APPLICATIONS.forEach(([id, cand, job, stage], i) => {
      run(db, 'INSERT INTO applications (id, candidate_id, job_id, stage, created_at) VALUES (?, ?, ?, ?, ?)',
        id, cand, job, stage, now - (10 - i) * 86_400_000);
    });

    // Three weeks of recurring meetings for every interviewer.
    for (const u of USERS) {
      const today = dateKey(now, u.tz);
      for (let i = -1; i < 21; i++) {
        const key = addDaysKey(today, i);
        const [y, m, d] = key.split('-').map(Number);
        for (const [s, e, title] of BUSY[u.id][weekdayOfKey(key)] || []) {
          const [sh, sm] = s.split(':').map(Number);
          const [eh, em] = e.split(':').map(Number);
          run(db, `INSERT INTO calendar_events (id, user_id, start, end, title, source) VALUES (?, ?, ?, ?, ?, 'external')`,
            `ev_${randomBytes(6).toString('hex')}`, u.id, zonedToUtc(y, m, d, sh, sm, u.tz), zonedToUtc(y, m, d, eh, em, u.tz), title);
        }
      }
    }
  });

  if (withBooking) {
    // Priya already booked her HR screen, so the Interviews tab has something in it.
    const sched = new Scheduler(db, { clock });
    const sent = sched.sendSchedulingLink('app_priya', 'hr_screen', { actor: 'riya@acme.example', source: 'seed' });
    const token = sent.link.url.split('/book/')[1];
    const hold = sched.hold(token, sent.slots[1].start);
    sched.book(token, { holdId: hold.holdId });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--reset')) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(DEFAULT_DB + suffix, { force: true });
  }
  const db = openDb();
  seed(db);
  console.log(`Seeded demo data into ${DEFAULT_DB}`);
}
