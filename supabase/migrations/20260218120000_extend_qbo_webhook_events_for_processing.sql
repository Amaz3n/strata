alter table if exists qbo_webhook_events
  add column if not exists realm_id text,
  add column if not exists entity_name text,
  add column if not exists entity_qbo_id text,
  add column if not exists operation text,
  add column if not exists last_updated timestamptz,
  add column if not exists process_status text not null default 'pending',
  add column if not exists process_error text,
  add column if not exists processed_at timestamptz;

create index if not exists qbo_webhook_events_process_idx
  on qbo_webhook_events (process_status, received_at desc);
