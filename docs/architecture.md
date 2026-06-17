# CalSync Architecture
**Version:** 1.0
**Maintainer:** CalSync contributors
**Last Updated:** June 2026
**Status:** Public architecture reference

---

## 1. What This Is

CalSync is a self-hosted backend service that syncs Google Calendar events across multiple calendars and multiple Google accounts — one-way, per sync rule, with per-rule field-level customization. There is no UI. All configuration is done directly in the database. The service runs headlessly on a Node.js host and is triggered by Google Calendar webhooks.

The first public release is a single-operator tool for people who want to run calendar sync infrastructure for their own accounts. It is not a hosted SaaS and does not include multi-tenancy.

---

## 2. Goals

- Sync events from any calendar (source) to any other calendar (target), one-way
- Support multiple Google accounts, each authenticated separately
- Support many-to-many sync rules (A→B, A→C, B→D, etc.)
- Allow field-level customization per sync rule (title prefix/suffix, visibility, color override, description copy, hide conference link, hide location, etc.)
- All configuration managed via database rows — no code changes needed to add a new calendar or sync rule
- Changes to sync rule configuration should trigger a re-sync of affected events automatically
- Logs of every action taken should be visible and persistent

---

## 3. Non-Goals (for now)

- No UI or dashboard
- No two-way sync (intentionally one-way only, can be extended later)
- No public access or multi-user support
- No mobile app or notifications
- No conflict resolution (target calendar is always overwritten by source)

---

## 4. Architecture Overview

```
Google Calendar (source)
        │
        │ webhook push notification
        ▼
  Hosted Server (Node.js / Express)
        │
        ├── checks Supabase for matching sync rules
        ├── fetches full event from source calendar
        ├── applies field transformations per rule
        ├── creates/updates/deletes event on target calendar
        └── writes log entry to Supabase

  Supabase (Postgres)
        ├── google_accounts       — authenticated Google accounts
        ├── calendars             — calendar IDs linked to accounts
        ├── sync_rules            — which calendar syncs to which, with config
        ├── event_sync_index      — maps source event ID to target event ID
        └── sync_logs             — audit log of every action taken
```

---

## 5. Database Schema

### 5.1 `google_accounts`
Stores one row per authenticated Google account.

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | auto-generated |
| label | text | friendly name, e.g. "Personal Gmail", "Work Gmail" |
| email | text | Google account email |
| access_token | text | OAuth access token (short-lived) |
| refresh_token | text | OAuth refresh token (long-lived, used to renew) |
| token_expiry | timestamp | when access_token expires |
| created_at | timestamp | auto |

**Notes:**
- You add a new Google account by running the OAuth flow once via a local script
- Tokens are stored here and refreshed automatically by the service
- Never expose this table publicly

---

### 5.2 `calendars`
Stores one row per calendar you want to use as a source or target.

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | auto-generated |
| google_account_id | uuid (FK → google_accounts) | which account owns this calendar |
| calendar_id | text | Google's calendar ID (e.g. `abc123@group.calendar.google.com`) |
| label | text | friendly name, e.g. "Personal", "Work", "Family" |
| webhook_channel_id | text | Google's watch channel ID (for webhook registration) |
| webhook_expiry | timestamp | when the watch channel expires (must be renewed every 7 days) |
| sync_token | text | Google incremental sync token for this calendar |
| created_at | timestamp | auto |

**Notes:**
- You add calendars manually by inserting rows here
- The `calendar_id` comes from Google Calendar settings (Settings → [Calendar name] → Integrate Calendar)
- Webhook registration can be run manually with `scripts/registerWebhook.js`; the server also renews missing or expiring source-calendar webhooks

---

### 5.3 `sync_rules`
Each row defines one one-way sync from a source calendar to a target calendar, with full customization config.

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | auto-generated |
| label | text | friendly name, e.g. "Work → Personal mirror" |
| source_calendar_id | uuid (FK → calendars) | |
| target_calendar_id | uuid (FK → calendars) | |
| is_active | boolean | set to true to activate sync |
| copy_title | boolean | default true; when false, source title is not copied and title_prefix is mandatory |
| title_prefix | text | text to prepend to event title, e.g. "[Work] " |
| title_suffix | text | text to append to event title, e.g. " (copy)" |
| target_visibility | text | `private` or `default`; controls destination event visibility |
| override_color | text | Google color ID (1–11) or null to copy source color |
| copy_description | boolean | default true |
| copy_location | boolean | default true |
| copy_conference_link | boolean | default false |
| copy_attendees | boolean | default false |
| created_at | timestamp | auto |
| updated_at | timestamp | auto-updated on any change |

**Notes:**
- Setting `is_active = true` for the first time triggers an **initial backfill** (see Section 7)
- If `copy_title = true`, the target title is `title_prefix + source title + title_suffix`
- If `copy_title = false`, the target title is `title_prefix + title_suffix`; `title_prefix` must be non-empty
- `target_visibility = private` hides event details from normal calendar readers; `target_visibility = default` follows the destination calendar's default visibility behavior
- Changing any field in this row triggers a **re-sync** of all events under this rule
- You can have multiple rules with the same source (fan-out: A→B and A→C)
- You can have multiple rules with the same target (fan-in: A→C and B→C) — be careful with this

---

### 5.4 `event_sync_index`
Maps a source event to its copy on the target calendar, per sync rule.

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | auto-generated |
| sync_rule_id | uuid (FK → sync_rules) | |
| source_event_id | text | Google event ID on source calendar |
| target_event_id | text | Google event ID on target calendar |
| last_synced_at | timestamp | when this pair was last processed |

**Notes:**
- This is the core deduplication index
- Before creating a new event on the target, always check here first
- If a source event is deleted, look up the target event ID here, delete it, then delete this row

---

### 5.5 `sync_logs`
Audit trail of every action the service takes.

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | auto-generated |
| sync_rule_id | uuid (FK → sync_rules) | nullable |
| action | text | `created`, `updated`, `deleted`, `skipped`, `error`, `backfill_started`, `backfill_complete`, `cleanup_complete`, `webhook_renewed` |
| source_event_id | text | nullable |
| target_event_id | text | nullable |
| message | text | human-readable description of what happened |
| error_detail | text | full error if action = `error` |
| created_at | timestamp | auto |

**Notes:**
- This is your observability layer — you query this table to see what happened and when
- Never delete from this table; let it accumulate
- You can query it in Supabase's table editor or SQL editor at any time

---

## 6. Webhook Flow (Runtime)

This is what happens every time an event changes on a source calendar.

```
1. Google sends POST to the configured `WEBHOOK_URL`
   — Headers contain: X-Goog-Channel-ID, X-Goog-Resource-State
   — Body is empty (Google does not tell you what changed)

2. Service extracts the calendar ID from `X-Goog-Resource-URI`
   — Current implementation looks up the calendar by `calendars.calendar_id` and validates `X-Goog-Channel-ID` against `calendars.webhook_channel_id`

3. Service fetches recent changes from Google Calendar API
   — Uses the stored `sync_token`, or falls back to the rolling sync window

4. For each changed event:
   a. Find all active sync_rules where source_calendar_id matches
   b. For each matching rule:
      i.  Check event_sync_index — does a copy already exist on target?
      ii. Apply field transformations from sync_rule config
      iii. Create or update event on target calendar via API
      iv. Upsert row in event_sync_index
      v.  Write entry to sync_logs

5. If event status = "cancelled" (deleted):
   a. Look up target_event_id in event_sync_index
   b. Delete event on target calendar
   c. Delete row from event_sync_index
   d. Write log entry
```

---

## 7. Initial Backfill Logic (Hard-coded)

When a sync rule is set to `is_active = true` for the first time, the service runs a one-time backfill. This logic is intentionally hard-coded and not configurable.

**Backfill window:**
- Events from **7 days before today** through **1 year from today**
- Events older than 7 days or more than 1 year in the future are ignored
- If a previously synced event later moves outside this rolling window, the target copy is deleted and its `event_sync_index` row is removed

**Backfill process:**
1. Log `backfill_started` to sync_logs
2. Fetch all events in the window from source calendar
3. For each event, check event_sync_index — skip if already synced
4. Apply transformations and create on target calendar
5. Write to event_sync_index
6. Log `backfill_complete` when done

**Re-sync on rule config change:**
- When any field in sync_rules is updated (detected via `updated_at` change or a Supabase realtime trigger)
- Re-apply transformations to all events already in event_sync_index for that rule
- This is an update, not a create — use existing target_event_id

---

## 8. Webhook Renewal (Cron Job)

Google Calendar webhooks expire every **7 days**. The service includes a cron job that runs daily and:

1. Finds source calendars referenced by `sync_rules`
2. Queries source calendars where `webhook_expiry` is null or `webhook_expiry < now() + 2 days`
3. Registers a new watch channel with Google for each missing/expiring calendar
4. Updates `webhook_channel_id` and `webhook_expiry` in the calendars table
5. Logs the renewal

The deployed service also runs the renewal check shortly after startup. OAuth access tokens are refreshed just-in-time before Google API calls, not by a blind daily token refresh.

---

## 9. Google Color Reference

When setting `override_color` in a sync rule, use Google's color IDs:

| ID | Color Name |
|---|---|
| 1 | Lavender |
| 2 | Sage |
| 3 | Grape |
| 4 | Flamingo |
| 5 | Banana |
| 6 | Tangerine |
| 7 | Peacock |
| 8 | Graphite |
| 9 | Blueberry |
| 10 | Basil |
| 11 | Tomato |

---

## 10. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js | Widely documented, easiest for beginners |
| Framework | Express | Minimal, sufficient for this use case |
| Google API | `googleapis` npm package | Official client |
| Database | Supabase (Postgres) | Free tier, easy to query manually, realtime capable |
| Hosting | Any Node.js host | Needs an always-on process and public HTTPS webhook URL |
| Auth | OAuth 2.0 (offline access) | Required for refresh tokens |
| Dev tunneling | ngrok or equivalent | Exposes localhost for webhook testing |
| Local dev restart | nodemon | Auto-restarts on file changes |

---

## 11. Environment Variables

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
WEBHOOK_URL=
PORT=3000
LOG_LEVEL=info
```

---

## 12. Build Order (Milestones)

| # | Milestone | What you learn |
|---|---|---|
| 1 | Project scaffold + Express server running | Node basics, npm, project structure |
| 2 | Google OAuth flow — get and store refresh token | OAuth, API credentials |
| 3 | Read events from a calendar via API | googleapis client, async/await |
| 4 | Webhook endpoint — receive and log Google's ping | Express routes, headers |
| 5 | Supabase setup — create tables, connect from code | Database client, env vars |
| 6 | One-way sync — source event creates target event | Core business logic |
| 7 | event_sync_index — update and delete handling | Deduplication, edge cases |
| 8 | Sync rule config — apply transformations | Dynamic config, field mapping |
| 9 | Backfill logic on rule activation | Batch processing |
| 10 | Webhook renewal cron job | Scheduled tasks |
| 11 | Multi-account support | Token management, account lookup |
| 12 | Deploy to a Node.js host | Environment config, production |

---

## 13. Known Risks and Things to Watch

- **Infinite loop prevention:** Always check event_sync_index before creating. Never copy an event that already exists as a target.
- **Token expiry:** Access tokens last ~1 hour. Always check expiry before API calls and refresh if needed.
- **Google webhook is a dumb ping:** It tells you something changed, not what. You must call the API to find out.
- **Deleted events:** Google marks them `status: "cancelled"` — they don't disappear. Handle this explicitly.
- **Fan-in collisions:** If A→C and B→C both match the same time slot, you may get duplicates on C. Be intentional about which rules you activate.
- **Timezone handling:** Always store and compare times in UTC. Google API returns RFC 3339 timestamps.
- **Rate limits:** Google Calendar API quotas are generous for typical self-hosted use. Still, add small delays in backfill loops to be safe.

---

*This document is the single source of truth for what CalSync is, what it does, and how it is built. Update it as decisions change.*

---

## 14. Architecture Decisions

Do not deviate from these.

- **All configuration lives in Supabase.** Never hardcode calendar IDs, sync rules, or account info in code. If something needs to be configurable, it belongs in the database.
- **Scripts in `/scripts` run locally only.** The hosted server process never runs these. They exist for one-time setup tasks (OAuth, seeding data, manual operations).
- **The `/services` folder contains reusable logic.** Routes only handle HTTP concerns (parsing the request, sending the response). Business logic, API calls, and database writes belong in services.
- **Always use async/await, never callbacks.** All asynchronous code must use async/await for consistency and readability.
- **Every significant action must write a log entry to `sync_logs`.** This includes creates, updates, deletes, skips, errors, backfill start, and backfill complete.
- **Never delete from `sync_logs`.** It is an append-only audit table. Query it freely; never truncate or delete rows.

---

## 15. Environment Variables

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console — identifies this app to Google |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret — used alongside the client ID to exchange auth codes for tokens |
| `GOOGLE_REDIRECT_URI` | The callback URL Google redirects to after OAuth consent — must match exactly what is registered in Google Cloud Console |
| `SUPABASE_URL` | The base URL for your Supabase project — used by the Supabase client to connect to the database |
| `SUPABASE_SERVICE_ROLE_KEY` | The service role key for your Supabase project — bypasses RLS, appropriate for a private backend service |
| `WEBHOOK_URL` | Public HTTPS URL Google Calendar uses for webhook delivery |
| `PORT` | The port the Express server listens on — defaults to 3000 locally |
| `LOG_LEVEL` | Runtime logging level: `error`, `warn`, `info`, or `debug`; defaults to `info` |

---

## 16. Scripts Reference

All scripts in `/scripts` are run locally from your machine. **None of these run in the hosted server process.**

| Script | What it does |
|---|---|
| `scripts/authenticate.js` | Runs the Google OAuth flow for a single account. Opens a browser, prompts for consent, exchanges the auth code for access and refresh tokens, and saves them to `google_accounts`. Run this once per Google account you want to add. |
| `scripts/registerWebhook.js` | Registers a Google Calendar watch channel for a given calendar. Writes the `webhook_channel_id` and `webhook_expiry` back to the `calendars` table. Run this after inserting a new row into `calendars`. |
| `scripts/testListEvents.js` | Uses the account linked to a calendar row and lists a small event preview for manual verification. |
| `scripts/validateSetup.js` | Read-only setup validation for required environment variables and Supabase table/column shape. |

> Add new scripts here as they are created. Always note whether a script is destructive or safe to run multiple times.
