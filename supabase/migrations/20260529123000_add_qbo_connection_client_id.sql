-- Track which QBO OAuth app (client_id) minted each connection's tokens.
-- Refresh tokens are bound to the client_id that issued them; refreshing with a
-- different client_id (e.g. development keys against a production token) is
-- rejected by Intuit and previously caused connections to be marked `expired`.
-- The application now skips refreshes when this value doesn't match the running
-- environment's client_id, so a mismatched environment can no longer disconnect
-- a live connection. Nullable: legacy rows are backfilled on the next successful
-- refresh by the owning environment.
alter table public.qbo_connections
  add column if not exists client_id text;

comment on column public.qbo_connections.client_id is
  'QBO OAuth client_id (app) that minted the stored tokens. Refreshes are only attempted when the running environment''s client_id matches.';
