-- Example CalSync setup rows.
-- Replace every placeholder before running. Do not commit real calendar IDs or emails.

-- 1. Authenticate the Google account first:
-- node scripts/authenticate.js --label "Personal Gmail" --email "you@example.com"

-- 2. Add calendars for that Google account.
insert into public.calendars (
  google_account_id,
  calendar_id,
  label
)
select
  id,
  'source-calendar-id@example.com',
  'Source calendar'
from public.google_accounts
where email = 'you@example.com'
limit 1;

insert into public.calendars (
  google_account_id,
  calendar_id,
  label
)
select
  id,
  'target-calendar-id@example.com',
  'Target calendar'
from public.google_accounts
where email = 'you@example.com'
limit 1;

-- 3. Create an inactive sync rule.
-- Keep rules inactive while editing. Setting is_active to true starts backfill.
insert into public.sync_rules (
  label,
  source_calendar_id,
  target_calendar_id,
  is_active,
  copy_title,
  title_prefix,
  title_suffix,
  target_visibility,
  override_color,
  copy_description,
  copy_location,
  copy_conference_link,
  copy_attendees
)
select
  'Source to target mirror',
  source_calendar.id,
  target_calendar.id,
  false,
  true,
  '[Source] ',
  '',
  'private',
  null,
  true,
  true,
  false,
  false
from public.calendars source_calendar
cross join public.calendars target_calendar
where source_calendar.calendar_id = 'source-calendar-id@example.com'
  and target_calendar.calendar_id = 'target-calendar-id@example.com'
limit 1;

-- 4. Register the source webhook after creating calendar rows:
-- node scripts/registerWebhook.js source-calendar-id@example.com

-- 5. Activate the rule after reviewing its configuration:
-- update public.sync_rules
-- set is_active = true
-- where label = 'Source to target mirror';
