-- CalSync bootstrap schema for a fresh Supabase project.
-- Run this before adding Google accounts, calendars, or sync rules.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.google_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  email text not null,
  access_token text,
  refresh_token text,
  token_expiry timestamp without time zone,
  created_at timestamp without time zone default now()
);

create table if not exists public.calendars (
  id uuid primary key default gen_random_uuid(),
  google_account_id uuid references public.google_accounts(id),
  calendar_id text not null,
  label text not null,
  webhook_channel_id text,
  webhook_expiry timestamp without time zone,
  created_at timestamp without time zone default now(),
  sync_token text
);

create index if not exists calendars_calendar_id_idx
  on public.calendars(calendar_id);

create index if not exists calendars_google_account_id_idx
  on public.calendars(google_account_id);

create table if not exists public.sync_rules (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  source_calendar_id uuid references public.calendars(id),
  target_calendar_id uuid references public.calendars(id),
  is_active boolean default false,
  title_prefix text,
  title_suffix text,
  override_color text,
  copy_description boolean default true,
  copy_location boolean default true,
  copy_conference_link boolean default false,
  copy_attendees boolean default false,
  created_at timestamp without time zone default now(),
  updated_at timestamp without time zone default now(),
  copy_title boolean not null default true,
  target_visibility text not null default 'private',
  constraint sync_rules_target_visibility_allowed
    check (target_visibility in ('private', 'default')),
  constraint sync_rules_copy_title_requires_title_prefix
    check (
      copy_title = true
      or nullif(trim(title_prefix), '') is not null
    )
);

create index if not exists sync_rules_source_calendar_id_idx
  on public.sync_rules(source_calendar_id);

create index if not exists sync_rules_target_calendar_id_idx
  on public.sync_rules(target_calendar_id);

create table if not exists public.event_sync_index (
  id uuid primary key default gen_random_uuid(),
  sync_rule_id uuid references public.sync_rules(id),
  source_event_id text not null,
  target_event_id text not null,
  last_synced_at timestamp without time zone default now(),
  constraint event_sync_index_source_event_rule_unique
    unique (source_event_id, sync_rule_id)
);

create index if not exists event_sync_index_sync_rule_id_idx
  on public.event_sync_index(sync_rule_id);

create table if not exists public.sync_logs (
  id uuid primary key default gen_random_uuid(),
  sync_rule_id uuid references public.sync_rules(id),
  action text not null,
  source_event_id text,
  target_event_id text,
  message text,
  error_detail text,
  created_at timestamp without time zone default now(),
  constraint sync_logs_action_allowed
    check (
      action in (
        'created',
        'updated',
        'deleted',
        'skipped',
        'error',
        'backfill_started',
        'backfill_complete',
        'cleanup_complete',
        'webhook_renewed'
      )
    )
);

create index if not exists sync_logs_sync_rule_id_idx
  on public.sync_logs(sync_rule_id);

create index if not exists sync_logs_created_at_idx
  on public.sync_logs(created_at desc);

create table if not exists public.processing_locks (
  id uuid primary key default gen_random_uuid(),
  calendar_id text not null unique,
  locked_at timestamp with time zone default now()
);

create or replace function public.set_sync_rules_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace function public.prevent_sync_rule_calendar_change()
returns trigger as $$
begin
  if new.source_calendar_id <> old.source_calendar_id or
     new.target_calendar_id <> old.target_calendar_id then
    raise exception 'source_calendar_id and target_calendar_id cannot be changed after creation.';
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function public.prevent_sync_rule_config_change_while_active()
returns trigger as $$
begin
  if old.is_active = true and (
    new.copy_title is distinct from old.copy_title or
    new.title_prefix is distinct from old.title_prefix or
    new.title_suffix is distinct from old.title_suffix or
    new.target_visibility is distinct from old.target_visibility or
    new.override_color is distinct from old.override_color or
    new.copy_description is distinct from old.copy_description or
    new.copy_location is distinct from old.copy_location or
    new.copy_conference_link is distinct from old.copy_conference_link or
    new.copy_attendees is distinct from old.copy_attendees
  ) then
    raise exception 'Cannot modify sync rule configuration while is_active is true. Set is_active to false first, then make changes, then re-activate.';
  end if;
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'sync_rules_set_updated_at'
  ) then
    create trigger sync_rules_set_updated_at
    before update on public.sync_rules
    for each row execute function public.set_sync_rules_updated_at();
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'sync_rules_immutable_calendars'
  ) then
    create trigger sync_rules_immutable_calendars
    before update on public.sync_rules
    for each row execute function public.prevent_sync_rule_calendar_change();
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'sync_rules_no_config_change_while_active'
  ) then
    create trigger sync_rules_no_config_change_while_active
    before update on public.sync_rules
    for each row execute function public.prevent_sync_rule_config_change_while_active();
  end if;
end $$;

alter table public.google_accounts enable row level security;
alter table public.calendars enable row level security;
alter table public.sync_rules enable row level security;
alter table public.event_sync_index enable row level security;
alter table public.sync_logs enable row level security;
alter table public.processing_locks enable row level security;
