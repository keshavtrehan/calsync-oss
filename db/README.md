# Database Setup

Fresh installs should run [schema.sql](schema.sql) in the Supabase SQL editor before adding Google accounts, calendars, or sync rules.

The other SQL files in this folder are historical incremental migrations from the original private deployment. They are retained for existing deployments that need to move toward the current schema without recreating data.

## Fresh Install

Run only:

```sql
\i db/schema.sql
```

If you are using the Supabase SQL editor, paste the contents of `schema.sql` and run it there.

`schema.sql` creates the CalSync tables, constraints, indexes, triggers, and enables Row Level Security on all CalSync tables. The backend is expected to use `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS and must stay server-side.

## Existing Deployments

For older deployments, apply the historical SQL files in this order:

1. `create_processing_locks.sql`
2. `add_sync_token_to_calendars.sql`
3. `add_unique_constraint_event_sync_index.sql`
4. `add_title_visibility_sync_rule_fields.sql`
5. `remove_description_affixes_from_sync_rules.sql`
6. `sync_rules_triggers.sql`

These files are written to be safe to re-run where practical. The unique index/constraint migration may still fail if existing duplicate `(source_event_id, sync_rule_id)` rows exist; deduplicate those rows before applying it.

## Validation

After configuring `.env`, run:

```sh
npm run validate:setup
```

The validation script is read-only. It checks required environment variables and verifies the required Supabase tables/columns exist by issuing zero-row selects.

## Example Rows

See [../examples/setup.sql](../examples/setup.sql) for placeholder inserts that show the expected setup flow:

1. authenticate a Google account,
2. add source and target calendar rows,
3. create an inactive sync rule,
4. register a webhook,
5. activate the rule when ready.
