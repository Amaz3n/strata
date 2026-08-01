-- Portal + invite tokens at rest
--
-- portal_access_tokens.token and memberships.invite_token were stored in
-- plaintext, so any DB read — a backup, a log line, an over-broad select —
-- yielded working credentials into client financials and org membership.
--
-- Each gets two derived columns instead:
--   token_hash      HMAC, indexed. The only thing authentication reads.
--   token_encrypted AES-256-GCM. Read only where a builder must re-display or
--                   reuse a link they already issued (ensurePortalLink,
--                   access-token-list). Bid tokens need no equivalent — they
--                   are never re-displayed, which is why they were hash-only
--                   from the start.
--
-- Additive on purpose. The plaintext columns are dropped in a follow-up once
-- the backfill (scripts/backfill-portal-token-hashes.ts) has run and the
-- application reads the derived columns.

alter table public.portal_access_tokens
  add column if not exists token_hash text,
  add column if not exists token_encrypted text;

alter table public.memberships
  add column if not exists invite_token_hash text;

create index if not exists portal_access_tokens_token_hash_idx
  on public.portal_access_tokens (token_hash)
  where token_hash is not null;

create index if not exists memberships_invite_token_hash_idx
  on public.memberships (invite_token_hash)
  where invite_token_hash is not null;

-- ── Session hygiene ──────────────────────────────────────────────────────────
-- Nothing ever swept expired external sessions; they accumulated forever.
create or replace function public.purge_expired_external_sessions(retain_days integer default 30)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  removed integer;
begin
  delete from public.external_identity_sessions
  where expires_at < now() - make_interval(days => retain_days)
     or (revoked_at is not null and revoked_at < now() - make_interval(days => retain_days));

  get diagnostics removed = row_count;

  delete from public.auth_rate_limits
  where window_start < now() - interval '2 days';

  return removed;
end;
$$;

-- ── Legacy access counter ────────────────────────────────────────────────────
-- record_portal_access superseded this long ago; the service still carried a
-- console.warn fallback path to it.
drop function if exists public.increment_portal_access(uuid);

-- ── Naming coherence after the identity migration ────────────────────────────
alter table public.vendor_company_claims
  rename column external_portal_account_id to external_identity_id;
