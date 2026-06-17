# Security

CalSync is a self-hosted backend that stores Google OAuth tokens and uses a Supabase service-role key. Treat every deployment as private infrastructure.

## Sensitive Data

Never commit or share:

- `.env` files.
- `SUPABASE_SERVICE_ROLE_KEY`.
- Google OAuth client secrets.
- Google OAuth access or refresh tokens.
- Calendar IDs, webhook channel IDs, sync tokens, event IDs, attendee emails, event descriptions, or conference links from a real deployment.

## Supabase

The app tables enable Row Level Security and are intended to be accessed by the backend with the Supabase service-role key. The service-role key bypasses RLS and must only be used on a trusted server.

Do not put the service-role key in frontend code, mobile apps, public logs, issue reports, screenshots, or client-side environment variables.

## Google OAuth

The local OAuth helper saves tokens directly to Supabase and does not print tokens by default. Only use `--print-tokens` on a trusted machine when debugging, and clear terminal history/logs if needed.

## Webhooks

Google Calendar webhooks require a public HTTPS URL. Avoid exposing development machines or private networks without understanding the risk. CalSync validates the incoming Google channel ID against the stored calendar channel before processing events.

## Reporting

If you find a security issue, open a private report or contact the maintainer without posting secrets or exploitable details in a public issue.
