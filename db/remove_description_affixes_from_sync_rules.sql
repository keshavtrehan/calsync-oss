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

alter table sync_rules
  drop column if exists description_prefix,
  drop column if exists description_suffix;
