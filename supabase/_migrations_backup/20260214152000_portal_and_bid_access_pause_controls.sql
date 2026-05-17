-- Add pause controls for external portal and bid access tokens.
alter table if exists portal_access_tokens
  add column if not exists paused_at timestamptz;

alter table if exists bid_access_tokens
  add column if not exists paused_at timestamptz;

create index if not exists portal_access_tokens_paused_idx
  on portal_access_tokens (project_id, paused_at)
  where revoked_at is null;

create index if not exists bid_access_tokens_paused_idx
  on bid_access_tokens (bid_invite_id, paused_at)
  where revoked_at is null;
