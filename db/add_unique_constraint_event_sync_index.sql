do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_sync_index_source_event_rule_unique'
  ) then
    alter table event_sync_index
      add constraint event_sync_index_source_event_rule_unique
      unique (source_event_id, sync_rule_id);
  end if;
end $$;
