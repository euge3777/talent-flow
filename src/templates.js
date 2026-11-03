// Email and chat message templates. Plain text; the Inbox page renders them.

import { formatInTz } from './tz.js';

const first = (name) => name.split(' ')[0];

/** "Tue 10 Nov, 10:00 PST (18:00 GMT for you)" style time line. */
export function timeLine(ms, primaryTz, secondaryTz) {
  const a = formatInTz(ms, primaryTz);
  if (!secondaryTz || secondaryTz === primaryTz) return a;
  return `${a} / ${formatInTz(ms, secondaryTz, { withDate: false })}`;
}

export function schedulingLinkEmail({ candidate, job, type, url, slotCount, message, apology, recruiter }) {
  const lines = [`Hi ${first(candidate.name)},`, ''];
  if (apology) {
    lines.push(`We're sorry, but we need to move your ${type.name} for the ${job.title} role.`, '');
  }
  lines.push(
    `Please pick a time for your ${type.name} (${type.duration_min} minutes, ${type.format}) for the ${job.title} role at ${job.company}.`,
    '',
    `Choose a time: ${url}`,
    '',
    `There are ${slotCount} times available, shown in your time zone. The link expires in 72 hours.`,
  );
  if (message) lines.push('', message);
  lines.push('', 'If none of the times work, you can suggest other times from the same page.', '', `Best,`, recruiter.name, job.company);
  return { subject: `${apology ? 'New times for' : 'Schedule'} your ${type.name} — ${job.title}`, body: lines.join('\n') };
}

export function confirmationEmail({ candidate, job, type, interview, interviewers, manageUrl, icsUrl }) {
  const body = [
    `Hi ${first(candidate.name)},`,
    '',
    `Your ${type.name} for the ${job.title} role is confirmed.`,
    '',
    `When: ${timeLine(interview.start, interview.candidate_tz, interviewers[0]?.tz)}`,
    `Length: ${type.duration_min} minutes`,
    `With: ${interviewers.map((u) => u.name).join(', ')}`,
    `Join: ${interview.video_url}`,
    '',
    type.prep_notes ? `How to prepare: ${type.prep_notes}` : null,
    type.prep_notes ? '' : null,
    `Add to calendar: ${icsUrl}`,
    `Need to reschedule or cancel? ${manageUrl}`,
    '',
    job.company,
  ].filter((l) => l !== null);
  return { subject: `Confirmed: ${type.name} — ${formatInTz(interview.start, interview.candidate_tz)}`, body: body.join('\n') };
}

export function interviewerInvite({ user, candidate, job, type, interview, baseUrl, application }) {
  return {
    subject: `Invite: ${type.name} with ${candidate.name} (${job.title})`,
    body: [
      `Hi ${first(user.name)},`,
      '',
      `${candidate.name} booked a ${type.name} for ${job.title}.`,
      `When: ${timeLine(interview.start, user.tz, interview.candidate_tz)} (candidate's time)`,
      `Join: ${interview.video_url}`,
      `Résumé: ${candidate.resume_url || `${baseUrl}/#/candidates/${candidate.id}`}`,
      `Scorecard: ${baseUrl}/#/scorecards/${application.id}`,
      '',
      'This event was added to your calendar. Decline it there if you can no longer make it.',
    ].join('\n'),
  };
}

export function cancellationEmail({ candidate, type, interview, reason, toCandidate, user }) {
  const name = toCandidate ? first(candidate.name) : first(user.name);
  const tz = toCandidate ? interview.candidate_tz : user.tz;
  return {
    subject: `Cancelled: ${type.name}${toCandidate ? '' : ` with ${candidate.name}`}`,
    body: [
      `Hi ${name},`,
      '',
      `The ${type.name} on ${formatInTz(interview.start, tz)} has been cancelled.`,
      reason ? `Reason: ${reason}` : null,
      toCandidate ? "We'll be in touch about next steps." : 'It has been removed from your calendar.',
    ].filter(Boolean).join('\n'),
  };
}

export function reminderEmail({ candidate, type, interview, hours }) {
  return {
    subject: `Reminder: ${type.name} ${hours === 1 ? 'in 1 hour' : 'tomorrow'}`,
    body: [
      `Hi ${first(candidate.name)},`,
      '',
      `A reminder that your ${type.name} is at ${formatInTz(interview.start, interview.candidate_tz)}.`,
      `Join: ${interview.video_url}`,
    ].join('\n'),
  };
}

export function rejectionEmail({ candidate, job }) {
  return {
    subject: `Your application for ${job.title}`,
    body: [
      `Hi ${first(candidate.name)},`,
      '',
      `Thank you for taking the time to speak with us about the ${job.title} role.`,
      "After careful thought, we've decided not to move forward with your application at this time.",
      "We appreciated getting to know you and we'd be glad to hear from you about future roles.",
      '',
      `Best wishes,`,
      job.company,
    ].join('\n'),
  };
}
