# TalentFlow — AI Interview Scheduling (MVP)

A working build of the *Feature Spec — AI Interview Scheduling*. Recruiters send a candidate one link; the candidate picks a time that is already cleared with HR and the hiring manager; everyone gets invites, reminders and a clean reschedule path. The same scheduling engine is exposed to ChatGPT and Claude as MCP tools.

No dependencies: Node.js 22.13+ and its built-in SQLite. Calendars, video links and email are simulated (see **What's simulated**).

## Quick start

```bash
cd ~/talentflow-scheduling
npm start          # http://localhost:4300  (loads demo data on first run)
npm test           # 32 tests: engine, end-to-end flows, MCP over stdio and HTTP
npm run seed       # reset the demo data
```

## Five-minute demo

1. Open http://localhost:4300. You are **Riya Patel, recruiter**.
2. **Pipeline → Ana Silva → Schedule HR screen.** Type `not Friday` and press Update: the preview shows the parsed preference, the slots in your time and Ana's (Lisbon), and the email. Send it.
3. **Inbox** shows the email. Open the booking link: that is the candidate page. Pick a time, add an accommodation note, confirm. Back in the app, Riya's calendar (**My availability**) now has the interview, and the Inbox has the confirmation, the invite and a private accommodation note.
4. **Ben Ortiz → Schedule HM interview.** Marcus is busy, so the search widens to 10 working days and warns you (SCH-7).
5. Switch **Acting as → Marcus Lee**. **Interviews → Decline in my calendar**: the slot is cancelled, Ben gets new times with an apology, Riya gets a Slack notice.
6. **Ravi Kumar → Schedule HR screen**: Riya's 9–5 Pacific has no overlap with 07:00–21:00 in India, so nothing is sent and the modal explains why. Book a specific agreed time at the bottom instead.
7. Open **Demo** in the header and use **+1 day / +1 hour** to move the demo clock: 24 h and 1 h reminders, the 48 h link reminder, 72 h link expiry and the "Did it happen?" no-show prompt fire. **Insights** shows time-to-schedule, self-schedule rate and which HM has the least free time.

## Connect ChatGPT or Claude

The **AI assistants** page shows your personal token and ready-made config. The assistant acts as that user with that user's permissions.

**Claude Desktop (stdio):** add to `claude_desktop_config.json`, then restart Claude:

```json
{
  "mcpServers": {
    "talentflow": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "/Users/eugenia/talentflow-scheduling/src/mcp-stdio.js"],
      "env": { "TALENTFLOW_TOKEN": "<token from the AI assistants page>" }
    }
  }
}
```

**Remote (Claude connectors, ChatGPT developer mode):** the server speaks MCP Streamable HTTP (JSON responses) at `/mcp` with `Authorization: Bearer <token>`. Cloud assistants can't reach localhost, so expose it with a tunnel (e.g. `cloudflared tunnel --url http://localhost:4300`) and set `BASE_URL` to the HTTPS address so booking links in emails point there. ChatGPT developer mode can't send headers, so `/mcp?token=<token>` is accepted for development only.

### Tools

| Tool | Type | Purpose |
| --- | --- | --- |
| `list_applications` | read | Resolve a candidate name to an application |
| `list_interviews` | read | Find an interview to change ("my interview with Ana") |
| `get_interview_types` | read | Durations and attendees per job |
| `find_interview_slots` | read | Free slots, with natural-language `when` ("mornings PT, not Friday") |
| `send_scheduling_link` | write | Email the candidate a self-booking link |
| `book_interview` | write | Book a time already agreed with the candidate |
| `reschedule_interview` | write | Cancel and send new options (or book `new_start`) |
| `cancel_interview` | write | Cancel for everyone |

Every write tool is **two-phase**: without `confirm: true` it returns a preview and changes nothing. That enforces "confirm before every write" even in hosts that don't prompt on their own. Hiring managers can reschedule or cancel interviews they attend, but only the recruiter or a coordinator can send links or book. Every call is in the audit log as `mcp:<client name>`.

Try: *"Set up an HR screen for Leo, mornings PT, not Friday."* · *"When could Ben meet Marcus next week?"* · *"Something came up — move my interview with Ben."*

## Design

The interface takes its cues from [Little Plains](https://littleplains.com): white paper, harbour-navy ink (`#13294B`), IBM Plex Mono throughout (hierarchy from size and weight), a floating pill navigation, one centred statement per page, and an editorial label-and-content layout with hairline rules instead of boxed cards.

The one signature element is the **sun arc** (`public/sun.js`): next to every time it shows where that moment falls in the *candidate's* day, sunrise to sunset, with a moon at night. It makes the most common scheduling mistake, a time that is fine for you but 11 pm for them, visible at a glance. When a candidate confirms, a large sun rises to their interview hour; that is the only animation, and it is off for people who prefer reduced motion.

Fonts load from Google Fonts; offline, the app falls back to the system monospace font.

## How it fits together

```
public/app.html, app.js    recruiter / HM web app (pipeline, interviews, availability, inbox, insights, activity, AI assistants)
public/sun.js              the sun-arc graphic shared by both pages
public/styles.css          the visual system (tokens at the top)
public/book.html, book.js  candidate booking page (no login; the link token is the credential)
src/server.js              HTTP: internal API, public candidate API, /mcp, static files, job loop (every 30 s)
src/scheduler.js           every business rule: slots, links, holds, booking, changes, reminders, metrics
src/slots.js               pure slot engine: hours, buffers, caps, holidays, constraints
src/constraints.js         natural-language preferences → structured filters
src/mcp.js, mcp-stdio.js   MCP tools and the stdio transport
src/calendar.js            calendar/video provider interface + the mock implementation
src/tz.js                  time-zone maths on Intl (DST-safe, no libraries)
src/seed.js                demo data relative to today
```

## Spec coverage

| Req | Status | Notes |
| --- | --- | --- |
| SCH-1 Calendar connect, free/busy only | Simulated | `MockCalendarProvider`; real Google/M365 adapters implement the same 4 methods |
| SCH-2 Interview hours, caps, buffers | Done | My availability page |
| SCH-3 Interview types per job | Partial | Seeded (HR screen 30 min, HM interview 45/60 min); no admin editor yet |
| SCH-4 Video link per interview | Simulated | Unique placeholder Zoom/Meet links |
| SCH-5 All required attendees free | Done | |
| SCH-6 Window: 5 working days from +24 h | Done | Configurable |
| SCH-7 Widen to 10 days + alert when < 3 | Done | |
| SCH-8 Optional attendees don't block | Done | Recruiter is optional on HM interviews |
| SCH-9 15-minute hold | Done | Held slots disappear for other candidates |
| SCH-10 Email link, 72 h expiry, reminder | Done | Email shown in Inbox; SMS is V1 per spec |
| SCH-11 Candidate time zone, no calendar details | Done | Auto-detected, switchable |
| SCH-12 No login, single-candidate token | Done | 144-bit random token |
| SCH-13 Candidate suggests 3 times | Done | Sent to the recruiter |
| SCH-14 Confirmation + .ics + email | Done | |
| SCH-15 Invites within 60 s | Done | Synchronous, written to (mock) calendars |
| SCH-16 Interview linked to application | Partial | Linked to application/stage; scorecards live in the wider platform, links are placeholders |
| SCH-17 Calendar changes sync back | Partial | Decline is simulated with a button; real webhooks need the provider adapters |
| SCH-18 Candidate reschedule once, cancel ≥ 4 h | Done | Second request escalates to the recruiter |
| SCH-19 Recruiter/HM reschedule from anywhere | Partial | Web app and AI assistant done; Slack is simulated as messages (no Slack app) |
| SCH-20 Reminders 24 h / 1 h | Done | Interviewers get résumé + scorecard links at 1 h |
| SCH-21 No-show prompt + one re-book | Done | Interviewer no-show sends an apology + wider window |
| SCH-22 MCP tools | Done | 6 from the spec + 2 lookup tools |
| SCH-23 Natural-language constraints | Done | Rule-based, English; shown back as "Understood" |
| SCH-24 Dashboard | Done | |

Edge cases from the spec handled: time zones and DST, double booking, stale slots (re-validated on every page load and at booking), disconnected calendars, no slots, link expiry, interviewer decline, candidate and interviewer no-shows, public holidays, 24 h minimum notice, private accommodation requests, calendar privacy, and duplicate links.

**One decision beyond the spec:** candidates are never offered times outside 07:00–21:00 in their own time zone (`candidateHours` in `DEFAULT_CONFIG`). When that leaves no slots, the recruiter is told why and can book an agreed time directly.

## What's simulated or not built

- **Sign-in:** the "Acting as" picker stands in for SSO; MCP uses per-user API tokens instead of OAuth 2.1.
- **Calendars, video, email, Slack:** simulated and shown in the app (My availability, Inbox). Nothing leaves your machine.
- **Not built:** admin editor for interview types, scorecards, panels of 3+ interviewers, room booking, SMS, ChatGPT in-chat UI cards (tools return `structuredContent` that a card can render later).

Before production: real Google/Microsoft adapters (free/busy scope only), OAuth 2.1 for MCP, an email provider, HTTPS, rate limiting, and removal of the `?token=` and demo-clock routes.
