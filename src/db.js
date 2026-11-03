// SQLite storage via Node's built-in node:sqlite (Node 22.5+). No dependencies.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DB = process.env.TALENTFLOW_DB || join(ROOT, 'data', 'talentflow.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,                       -- recruiter | hm | coordinator
  tz TEXT NOT NULL, calendar_provider TEXT NOT NULL DEFAULT 'google',
  calendar_connected INTEGER NOT NULL DEFAULT 1,
  interview_hours TEXT NOT NULL,            -- JSON {mon:[["10:00","16:00"]],...}
  max_per_day INTEGER NOT NULL DEFAULT 4, max_per_week INTEGER NOT NULL DEFAULT 15,
  buffer_min INTEGER NOT NULL DEFAULT 10, holiday_region TEXT NOT NULL DEFAULT 'US',
  api_token TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS holidays (region TEXT NOT NULL, date TEXT NOT NULL, name TEXT, PRIMARY KEY (region, date));

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, company TEXT NOT NULL,
  recruiter_id TEXT NOT NULL REFERENCES users(id), hm_id TEXT NOT NULL REFERENCES users(id),
  video_provider TEXT NOT NULL DEFAULT 'zoom'
);

CREATE TABLE IF NOT EXISTS interview_types (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  key TEXT NOT NULL,                        -- hr_screen | hm_interview
  name TEXT NOT NULL, duration_min INTEGER NOT NULL,
  required_roles TEXT NOT NULL, optional_roles TEXT NOT NULL DEFAULT '[]',
  format TEXT NOT NULL DEFAULT 'video', prep_notes TEXT NOT NULL DEFAULT '',
  UNIQUE (job_id, key)
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, tz TEXT NOT NULL, resume_url TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  stage TEXT NOT NULL DEFAULT 'applied',    -- applied | hr_screen | hm_interview | offer | rejected
  no_shows INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  start INTEGER NOT NULL, end INTEGER NOT NULL, title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'external',  -- external | talentflow
  interview_id TEXT
);
CREATE INDEX IF NOT EXISTS ev_user ON calendar_events (user_id, start);

CREATE TABLE IF NOT EXISTS scheduling_links (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
  application_id TEXT NOT NULL REFERENCES applications(id),
  interview_type_id TEXT NOT NULL REFERENCES interview_types(id),
  constraints TEXT NOT NULL DEFAULT '{}', message TEXT,
  status TEXT NOT NULL DEFAULT 'active',    -- active | booked | expired | void | rescheduled
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, booked_at INTEGER,
  reminded INTEGER NOT NULL DEFAULT 0, expiry_notified INTEGER NOT NULL DEFAULT 0,
  candidate_reschedules INTEGER NOT NULL DEFAULT 0,
  reschedule_of TEXT, window_days INTEGER NOT NULL DEFAULT 5,
  interview_id TEXT, created_by TEXT, source TEXT
);

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES scheduling_links(id),
  start INTEGER NOT NULL, end INTEGER NOT NULL, user_ids TEXT NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id),
  interview_type_id TEXT NOT NULL REFERENCES interview_types(id),
  start INTEGER NOT NULL, end INTEGER NOT NULL,
  attendee_ids TEXT NOT NULL,               -- JSON, interviewers only
  video_url TEXT, candidate_tz TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | held | cancelled | rescheduled | no_show_candidate | no_show_interviewer
  booked_via TEXT NOT NULL,                 -- link | direct
  link_id TEXT, candidate_reschedules INTEGER NOT NULL DEFAULT 0,
  accommodation TEXT, reminded_24 INTEGER NOT NULL DEFAULT 0, reminded_1 INTEGER NOT NULL DEFAULT 0,
  noshow_prompted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, cancel_reason TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL,  -- email | slack | calendar
  to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  related_id TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
  source TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}'
);
`;

export function openDb(file = DEFAULT_DB) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export const all = (db, sql, ...p) => db.prepare(sql).all(...p);
export const get = (db, sql, ...p) => db.prepare(sql).get(...p);
export const run = (db, sql, ...p) => db.prepare(sql).run(...p);

/** Run `fn` inside a write transaction (nested calls join the outer one). */
const IN_TX = Symbol('inTx');

export function tx(db, fn) {
  if (db[IN_TX]) return fn();
  db.exec('BEGIN IMMEDIATE');
  db[IN_TX] = true;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db[IN_TX] = false;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = get(db, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(db, key, value) {
  run(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}
