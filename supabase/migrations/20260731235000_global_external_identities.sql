-- Global external identities
--
-- external_portal_accounts was scoped per builder org (UNIQUE (org_id, email)),
-- so a sub working for two Arc builders got two accounts and could only ever
-- reach one of them per sign-in. Identity is now global; org scoping lives
-- entirely on the grants, which already carry org_id.
--
-- Also adds email verification + password reset state (neither existed) and
-- the rate-limit substrate for unauthenticated auth surfaces.

-- ── Rate limiting ────────────────────────────────────────────────────────────
create table if not exists public.auth_rate_limits (
  action text not null,
  identifier text not null,
  window_start timestamptz not null,
  attempts integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (action, identifier, window_start)
);

alter table public.auth_rate_limits enable row level security;

drop policy if exists auth_rate_limits_service_role on public.auth_rate_limits;
create policy auth_rate_limits_service_role on public.auth_rate_limits
  for all using ((select auth.role()) = 'service_role');

create index if not exists auth_rate_limits_window_idx
  on public.auth_rate_limits (window_start);

create or replace function public.increment_auth_rate_limit(
  action_input text,
  identifier_input text,
  window_start_input timestamptz
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  next_attempts integer;
begin
  insert into public.auth_rate_limits (action, identifier, window_start, attempts, updated_at)
  values (action_input, identifier_input, window_start_input, 1, now())
  on conflict (action, identifier, window_start)
  do update set attempts = public.auth_rate_limits.attempts + 1, updated_at = now()
  returning attempts into next_attempts;

  return next_attempts;
end;
$$;

-- ── Identity table ───────────────────────────────────────────────────────────
alter table public.external_portal_accounts rename to external_identities;

-- Collapse an email that was claimed separately under multiple builders onto a
-- single identity. Canonical row = the one the old sign-in path would have
-- picked (most recent login, then most recent creation), so nobody's working
-- password changes.
create or replace view public.external_identity_merge_plan as
with ranked as (
  select
    id,
    email,
    first_value(id) over (
      partition by email
      order by last_login_at desc nulls last, created_at desc, id
    ) as canonical_id
  from public.external_identities
)
select id, canonical_id from ranked where id <> canonical_id;

update public.external_portal_account_grants g
set account_id = m.canonical_id
from public.external_identity_merge_plan m
where g.account_id = m.id;

update public.external_portal_sessions s
set account_id = m.canonical_id
from public.external_identity_merge_plan m
where s.account_id = m.id;

-- Carry a payments identity onto the survivor if it lacked one.
update public.external_identities canonical
set vendor_identity_id = dupe.vendor_identity_id
from public.external_identity_merge_plan m
join public.external_identities dupe on dupe.id = m.id
where canonical.id = m.canonical_id
  and canonical.vendor_identity_id is null
  and dupe.vendor_identity_id is not null;

delete from public.external_identities
where id in (select id from public.external_identity_merge_plan);

drop view public.external_identity_merge_plan;

-- Identity is global: org scoping belongs to the grants.
drop index if exists public.external_portal_accounts_identity_org_uidx;
drop index if exists public.external_portal_accounts_org_status_idx;

alter table public.external_identities drop column org_id;

alter table public.external_identities
  add constraint external_identities_email_key unique (email);

create unique index external_identities_vendor_identity_uidx
  on public.external_identities (vendor_identity_id)
  where vendor_identity_id is not null;

create index external_identities_status_idx
  on public.external_identities (status);

-- Verification + reset state. Claiming a link previously created a usable
-- account with no proof the claimer owned the mailbox, and there was no
-- recovery path at all once a password was forgotten.
alter table public.external_identities
  add column email_verified_at timestamptz,
  add column verification_token_hash text,
  add column verification_sent_at timestamptz,
  add column reset_token_hash text,
  add column reset_token_expires_at timestamptz;

create index external_identities_verification_idx
  on public.external_identities (verification_token_hash)
  where verification_token_hash is not null;

create index external_identities_reset_idx
  on public.external_identities (reset_token_hash)
  where reset_token_hash is not null;

-- Existing accounts predate verification; they were reachable only by holding a
-- valid builder-issued link, so treat that as the verification event rather
-- than locking live users out.
update public.external_identities
set email_verified_at = coalesce(last_login_at, created_at)
where email_verified_at is null;

alter table public.external_identities rename constraint external_portal_accounts_pkey
  to external_identities_pkey;
alter table public.external_identities rename constraint external_portal_accounts_status_check
  to external_identities_status_check;
alter table public.external_identities rename constraint external_portal_accounts_created_by_fkey
  to external_identities_created_by_fkey;
alter table public.external_identities rename constraint external_portal_accounts_vendor_identity_id_fkey
  to external_identities_vendor_identity_id_fkey;

-- ── Grants: the org-scoping layer ────────────────────────────────────────────
alter table public.external_portal_account_grants rename to external_identity_grants;
alter table public.external_identity_grants rename column account_id to identity_id;

alter index public.external_portal_grants_account_bid_token_uidx
  rename to external_identity_grants_bid_token_uidx;
alter index public.external_portal_grants_account_portal_token_uidx
  rename to external_identity_grants_portal_token_uidx;
alter index public.external_portal_grants_bid_token_idx
  rename to external_identity_grants_bid_token_idx;
alter index public.external_portal_grants_portal_token_idx
  rename to external_identity_grants_portal_token_idx;

create index if not exists external_identity_grants_identity_org_idx
  on public.external_identity_grants (identity_id, org_id, status);

-- ── Sessions: identity-scoped, not org-scoped ────────────────────────────────
-- A session proves who you are. Which builder you are currently looking at is a
-- view concern resolved from grants, not something baked into the credential.
alter table public.external_portal_sessions rename to external_identity_sessions;
alter table public.external_identity_sessions rename column account_id to identity_id;
alter table public.external_identity_sessions drop column org_id;

alter index public.external_portal_sessions_account_idx
  rename to external_identity_sessions_identity_idx;

-- ── Redundant FKs that made PostgREST embeds ambiguous ───────────────────────
-- Each of these duplicates a composite (org_id, project_id) FK that already
-- enforces the same integrity, and their presence is what made
-- `project:projects(...)` fail to resolve.
alter table public.bid_packages drop constraint if exists bid_packages_project_id_fkey;
alter table public.compliance_documents drop constraint if exists compliance_documents_project_id_fkey;
alter table public.subtier_waiver_requirements drop constraint if exists subtier_waiver_requirements_project_id_fkey;
