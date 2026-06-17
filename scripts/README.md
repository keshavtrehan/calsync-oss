# Scripts

These scripts are meant to be run **locally only**. They are never run by the hosted server process.

Each script in this folder is a one-time or manual operation — things like running the Google OAuth flow, registering webhooks, or checking calendar API access. They are not part of the server process.

To run a script:
```
node scripts/<script-name>.js
```

The OAuth script requires a label and email:
```
node scripts/authenticate.js --label "Personal Gmail" --email "you@example.com"
```

Scripts that target a calendar require the calendar ID as an argument:
```
node scripts/registerWebhook.js <calendar-id>
node scripts/testListEvents.js <calendar-id>
```

To validate environment variables and required Supabase tables:
```
npm run validate:setup
```

## Security notes

- `authenticate.js` saves OAuth tokens to Supabase and only prints them when `--print-tokens` is passed. Run that debug mode only on a trusted machine.
- `registerWebhook.js` writes webhook channel metadata back to Supabase.
- `testListEvents.js` prints a small event preview for debugging. Avoid sharing that output publicly if it contains real event details.
- `validateSetup.js` is read-only and checks env/schema shape before setup or deployment.
