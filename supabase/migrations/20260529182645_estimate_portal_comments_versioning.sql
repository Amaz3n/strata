-- Estimate client portal + back-and-forth + versioning
-- All additive and idempotent.

-- 1) Portal + decision + versioning columns on estimates
alter table public.estimates
  add column if not exists token_hash text,
  add column if not exists sent_at timestamptz,
  add column if not exists viewed_at timestamptz,
  add column if not exists responded_at timestamptz,
  add column if not exists decision_note text,
  add column if not exists client_decision_name text,
  add column if not exists client_decision_email text,
  add column if not exists version_group_id uuid,
  add column if not exists is_current_version boolean not null default true,
  add column if not exists supersedes_estimate_id uuid;

-- Backfill version_group_id so every existing estimate is its own family head
update public.estimates
  set version_group_id = id
  where version_group_id is null;

create index if not exists idx_estimates_token_hash
  on public.estimates (token_hash)
  where token_hash is not null;

create index if not exists idx_estimates_version_group
  on public.estimates (org_id, version_group_id);

-- 2) Estimate comments / activity thread (builder <-> client back-and-forth)
create table if not exists public.estimate_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  estimate_id uuid not null references public.estimates(id) on delete cascade,
  version_group_id uuid,
  author_type text not null default 'builder',          -- 'builder' | 'client'
  author_user_id uuid,
  author_name text,
  author_email text,
  kind text not null default 'comment',                  -- comment | sent | approval | rejection | changes_requested | revision | viewed
  body text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_estimate_comments_estimate
  on public.estimate_comments (org_id, estimate_id, created_at);

create index if not exists idx_estimate_comments_version_group
  on public.estimate_comments (org_id, version_group_id, created_at);

alter table public.estimate_comments enable row level security;

drop policy if exists estimate_comments_access on public.estimate_comments;
create policy estimate_comments_access on public.estimate_comments
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));
