alter table if exists qbo_connections
  add column if not exists refresh_token_expires_at timestamp with time zone,
  add column if not exists refresh_failure_count integer not null default 0;

create index if not exists qbo_connections_refresh_expiry_idx
  on qbo_connections (status, refresh_token_expires_at)
  where status = 'active';
