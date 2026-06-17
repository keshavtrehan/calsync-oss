# Contributing

Thanks for helping improve CalSync. This project is a self-hosted backend for single-operator Google Calendar sync, so changes should preserve private-server assumptions and avoid adding browser/client exposure for secrets.

## Local Setup

1. Install dependencies:

```sh
npm install
```

2. Copy the environment template:

```sh
cp .env.example .env
```

3. Create the Supabase schema with [db/schema.sql](db/schema.sql).

4. Check the local setup:

```sh
npm run validate:setup
```

`validate:setup` is read-only. It checks required env vars and table/column shape.

## Checks

Before opening a pull request, run:

```sh
npm test
npm audit --omit=dev
```

The test command currently performs JavaScript syntax checks across runtime services and scripts.

## Security Rules

- Do not commit `.env`, tokens, calendar IDs from real deployments, webhook channel IDs, sync tokens, event IDs, attendee emails, or logs from private calendars.
- Do not expose `SUPABASE_SERVICE_ROLE_KEY` outside trusted server-side code.
- Keep setup scripts explicit about destructive or secret-printing behavior.
- Prefer redacted logs by default. Debug logs should still avoid raw tokens and private event content.

## Pull Request Expectations

- Keep changes focused and explain any data/schema impact.
- Update `README.md`, [db/README.md](db/README.md), or [docs/architecture.md](docs/architecture.md) when behavior changes.
- For schema changes, update [db/schema.sql](db/schema.sql) and add clear upgrade guidance for existing deployments.
- Preserve one-way sync behavior unless the pull request explicitly proposes a larger design change.

## Supported Baseline

- Node.js 22 or newer.
- Supabase Postgres with the schema in this repo.
- Google Calendar API via OAuth 2.0 offline access.
- A private, always-on Node.js host with a public HTTPS webhook URL.
