-- Vendor workspace: builder-scoped external access
--
-- Replaces the paused Phase 6 of docs/plans/external-access-gameplan.md, whose
-- premise ("a bid invite is a person on a project, pre-award") does not hold:
-- 2 of 8 bid packages carrying 3 of 14 invites have no project at all, because
-- bidding happens during estimating. `portal_access_tokens.project_id` is NOT
-- NULL, so a prospect-stage bid physically cannot mint a portal token.
--
-- The deeper problem that surfaced through: the unit of external access is one
-- level too low. A `portal_access_tokens` row is (person, project, portal_type),
-- but the real-world relationship is (person, builder). Everything awkward in
-- the current model is downstream of that mismatch:
--
--   * A vendor on six projects is six rows, six permission sets, six revokes.
--   * `external_identity_grants` has no project scope of its own — scope only
--     exists by joining through the token, which is exactly how the org-wide
--     revoke bug happened (Phase 1, WS-1.2).
--   * A bid is a relationship event, not a project event, so it has nowhere to
--     live.
--
-- This migration introduces the relationship as a first-class row, gives grants
-- their own scope, and relaxes the project requirement on access records.
--
-- ORDERING NOTE: relaxing `project_id` only *permits* null. Nothing writes null
-- until the WS-2 code lands, and every `portal_access_tokens` consumer must be
-- audited for null-project handling before it does. See the gameplan.

-- ── The relationship: one person, one builder ────────────────────────────────
create table if not exists public.external_org_relationships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  identity_id uuid not null references public.external_identities(id) on delete cascade,
  -- The company they represent to this builder. Null for an individual (a
  -- homeowner, an independent reviewer) and for a vendor whose company record
  -- has not been created yet.
  company_id uuid references public.companies(id) on delete set null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'revoked')),
  paused_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_org_relationships_unique unique (org_id, identity_id)
);

comment on table public.external_org_relationships is
  'One external person''s relationship with one builder. The parent of every project and bid grant they hold there, and the thing a vendor workspace is scoped to.';

create index if not exists external_org_relationships_org_idx
  on public.external_org_relationships (org_id, status);
create index if not exists external_org_relationships_identity_idx
  on public.external_org_relationships (identity_id, status);
create index if not exists external_org_relationships_company_idx
  on public.external_org_relationships (org_id, company_id)
  where company_id is not null;

drop trigger if exists external_org_relationships_set_updated_at
  on public.external_org_relationships;
create trigger external_org_relationships_set_updated_at
  before update on public.external_org_relationships
  for each row execute function public.tg_set_updated_at();

alter table public.external_org_relationships enable row level security;

-- Matches `external_identities` and `external_identity_grants`: external access
-- never runs under an org member's `auth.uid()`, so every read and write goes
-- through the service client in lib/services/external-portal-auth.ts.
drop policy if exists external_org_relationships_service_role
  on public.external_org_relationships;
create policy external_org_relationships_service_role
  on public.external_org_relationships
  for all using ((select auth.role()) = 'service_role');

-- ── Grants get real scope ────────────────────────────────────────────────────
alter table public.external_identity_grants
  add column if not exists relationship_id uuid
    references public.external_org_relationships(id) on delete cascade,
  -- Project scope stops being a join through the token. `revokePortalToken`'s
  -- project filter (Phase 1, WS-1.2) becomes a plain predicate.
  add column if not exists project_id uuid
    references public.projects(id) on delete cascade,
  -- A bid grant may legitimately have no project: bidding predates the job.
  add column if not exists bid_package_id uuid
    references public.bid_packages(id) on delete cascade;

comment on column public.external_identity_grants.project_id is
  'Direct project scope. Null for a bid grant on a prospect-stage package, which has no project yet.';
comment on column public.external_identity_grants.bid_package_id is
  'Set for bid access. Project-optional by design — a quarter of bid packages are pre-project.';

-- Backfill: 2 grants in production, both project-backed through their token.
update public.external_identity_grants g
set project_id = t.project_id
from public.portal_access_tokens t
where g.portal_access_token_id = t.id
  and g.project_id is null;

insert into public.external_org_relationships (org_id, identity_id, status)
select distinct g.org_id, g.identity_id, 'active'
from public.external_identity_grants g
on conflict (org_id, identity_id) do nothing;

update public.external_identity_grants g
set relationship_id = r.id
from public.external_org_relationships r
where r.org_id = g.org_id
  and r.identity_id = g.identity_id
  and g.relationship_id is null;

create index if not exists external_identity_grants_relationship_idx
  on public.external_identity_grants (relationship_id)
  where relationship_id is not null;
create index if not exists external_identity_grants_project_idx
  on public.external_identity_grants (org_id, project_id)
  where project_id is not null;
create index if not exists external_identity_grants_bid_package_idx
  on public.external_identity_grants (org_id, bid_package_id)
  where bid_package_id is not null;

-- ── Access records may be bid-scoped instead of project-scoped ───────────────
alter table public.portal_access_tokens
  alter column project_id drop not null;

-- Every access record still points at something real. `scoped_bid_invite_id`
-- was added by 20260802140000 and left unused when Phase 6 paused; this is what
-- makes it load-bearing rather than dead schema.
alter table public.portal_access_tokens
  drop constraint if exists portal_access_tokens_scope_present;
alter table public.portal_access_tokens
  add constraint portal_access_tokens_scope_present
    check (project_id is not null or scoped_bid_invite_id is not null);

comment on column public.portal_access_tokens.project_id is
  'Null only for a bid-scoped record whose package has no project yet. Every consumer must handle null before anything writes one.';
