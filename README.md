# CalSync

CalSync is a self-hosted Google Calendar sync service. It runs as a small Node.js/Express backend, stores configuration in Supabase, and syncs events one way from source calendars to target calendars.

The first public release is intended for a single operator managing their own calendars. It is not a hosted SaaS, multi-user app, or two-way calendar sync product.

## Features

- Sync one Google Calendar to another using database-managed rules.
- Support multiple Google accounts and calendars.
- Configure title prefixes/suffixes, target visibility, colors, description copying, location copying, conference links, and attendee summaries per rule.
- Backfill events from 7 days in the past through 1 year in the future.
- Renew Google Calendar webhook channels automatically.
- Store sync activity in Supabase for inspection and troubleshooting.

## Requirements

- Node.js 22 or newer.
- A Supabase project.
- A Google Cloud OAuth client with the Google Calendar API enabled.
- A public HTTPS URL for webhook delivery in production.

## Setup

1. Install dependencies:

```sh
npm install
```

2. Create your database schema by running [db/schema.sql](db/schema.sql) in the Supabase SQL editor.

For sample calendar and sync-rule rows, see [examples/setup.sql](examples/setup.sql).

3. Copy the example environment file and fill in your values:

```sh
cp .env.example .env
```

4. Configure these environment variables:

```sh
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
WEBHOOK_URL=
PORT=3000
LOG_LEVEL=info
```

5. Validate your local setup:

```sh
npm run validate:setup
```

6. Run OAuth locally for each Google account you want to use:

```sh
node scripts/authenticate.js --label "Personal Gmail" --email "you@example.com"
```

The script opens the Google consent URL, receives the callback on `GOOGLE_REDIRECT_URI`, and saves tokens directly to `google_accounts`. It does not print tokens by default.

7. Add calendar rows in Supabase. Use each calendar's Google Calendar ID from Google Calendar settings.

8. Register webhooks for source calendars:

```sh
node scripts/registerWebhook.js <calendar-id>
```

9. Create rows in `sync_rules`. Keep rules inactive while editing configuration, then set `is_active = true` when ready to backfill and start syncing.

10. Start the service:

```sh
npm start
```

For local development:

```sh
npm run dev
```

## Data Model

CalSync uses these Supabase tables:

- `google_accounts`: OAuth tokens for Google accounts.
- `calendars`: Google calendars attached to those accounts.
- `sync_rules`: one-way source-to-target sync configuration.
- `event_sync_index`: source event to target event mapping.
- `sync_logs`: append-only sync activity.
- `processing_locks`: lightweight duplicate webhook protection.

All app tables enable Row Level Security. The backend uses `SUPABASE_SERVICE_ROLE_KEY`, so do not expose that key to browsers, clients, logs, or public issue reports.

## Development

Run local checks:

```sh
npm test
npm audit --omit=dev
```

Run read-only setup validation after configuring `.env`:

```sh
npm run validate:setup
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [docs/architecture.md](docs/architecture.md) for the longer architecture reference.

## Sync Window

Backfill and fallback syncs use a rolling window:

- 7 days before the current date.
- 1 year after the current date.

Events outside that window are skipped. If a synced event later moves outside the window, its target copy is deleted.

## Current OSS Notes

This repo has been cleaned up for a first self-hosted release path, but a few operational notes remain:

- `scripts/authenticate.js` can print OAuth tokens only when explicitly run with `--print-tokens`.
- Runtime logs are controlled by `LOG_LEVEL` and avoid raw calendar IDs, sync tokens, webhook headers, event titles, attendee emails, and conference data by default.
- Webhook processing validates the stored Google channel ID before syncing events.
- Existing incremental SQL files in `db/` are retained for historical context; see [db/README.md](db/README.md) for fresh install and upgrade guidance.

## License

MIT
