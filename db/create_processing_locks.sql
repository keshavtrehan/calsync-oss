create table if not exists processing_locks (
  id uuid primary key default gen_random_uuid(),
  calendar_id text not null unique,
  locked_at timestamp with time zone default now()
);

alter table processing_locks enable row level security;
