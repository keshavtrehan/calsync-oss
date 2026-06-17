-- Trigger 1: Prevent changing source_calendar_id or target_calendar_id after creation
create or replace function prevent_sync_rule_calendar_change()
returns trigger as $$
begin
  if new.source_calendar_id <> old.source_calendar_id or
     new.target_calendar_id <> old.target_calendar_id then
    raise exception 'source_calendar_id and target_calendar_id cannot be changed after creation.';
  end if;
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'sync_rules_immutable_calendars'
  ) then
    create trigger sync_rules_immutable_calendars
    before update on sync_rules
    for each row execute function prevent_sync_rule_calendar_change();
  end if;
end $$;

-- Trigger 2: Prevent modifying config fields while is_active is true
create or replace function prevent_sync_rule_config_change_while_active()
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
    select 1
    from pg_trigger
    where tgname = 'sync_rules_no_config_change_while_active'
  ) then
    create trigger sync_rules_no_config_change_while_active
    before update on sync_rules
    for each row execute function prevent_sync_rule_config_change_while_active();
  end if;
end $$;
