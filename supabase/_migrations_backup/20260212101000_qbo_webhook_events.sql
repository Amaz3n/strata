-- Replay protection + observability for QBO webhook deliveries
create table if not exists qbo_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists qbo_webhook_events_received_idx on qbo_webhook_events (received_at desc);

alter table qbo_webhook_events enable row level security;

create policy "qbo_webhook_events_access" on qbo_webhook_events
  for all using (auth.role() = 'service_role');
