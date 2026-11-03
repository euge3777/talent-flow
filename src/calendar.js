// Calendar and video providers.
//
// MockCalendarProvider stores events in SQLite so the app runs with no
// external accounts. A Google or Microsoft 365 provider implements the same
// four methods (freeBusy, listEvents, createEvent, deleteEventsForInterview)
// using the providers' free/busy and events APIs. Per SCH-1, the real
// adapters must request free/busy scope only and never store event titles.

import { randomBytes } from 'node:crypto';
import { all, run } from './db.js';

export const newId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;

export class MockCalendarProvider {
  constructor(db) {
    this.db = db;
  }

  /** Busy blocks for a user between `from` and `to` (UTC ms). */
  freeBusy(userId, from, to, { excludeInterviewId } = {}) {
    return all(this.db,
      `SELECT start, end FROM calendar_events
       WHERE user_id = ? AND end > ? AND start < ? AND (interview_id IS NULL OR interview_id != ?)`,
      userId, from, to, excludeInterviewId || '');
  }

  listEvents(userId, from, to) {
    return all(this.db,
      'SELECT * FROM calendar_events WHERE user_id = ? AND end > ? AND start < ? ORDER BY start',
      userId, from, to);
  }

  createEvent(userId, { start, end, title, interviewId = null, source = 'talentflow' }) {
    const id = newId('ev');
    run(this.db,
      'INSERT INTO calendar_events (id, user_id, start, end, title, source, interview_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, userId, start, end, title, source, interviewId);
    return id;
  }

  deleteEvent(eventId) {
    run(this.db, 'DELETE FROM calendar_events WHERE id = ?', eventId);
  }

  deleteEventsForInterview(interviewId) {
    run(this.db, 'DELETE FROM calendar_events WHERE interview_id = ?', interviewId);
  }
}

const VIDEO_HOSTS = {
  zoom: 'zoom.example.com/j',
  google_meet: 'meet.example.com',
  teams: 'teams.example.com/l/meetup-join',
};

/** Mock video link. A real adapter calls the Zoom / Meet / Teams API (SCH-4). */
export function createVideoLink(provider) {
  const host = VIDEO_HOSTS[provider] || VIDEO_HOSTS.zoom;
  return `https://${host}/${randomBytes(5).toString('hex')}`;
}
