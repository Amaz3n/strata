-- AI search: answer caching + proactive standing questions.
--
-- Applied 2026-08-08. Two tables, both additive; nothing existing is altered
-- or dropped.
--
-- NOTE ON GRANTS: this project's default privileges hand every client role full
-- access to new public tables, so the `grant` below does not restrict anything
-- on its own — RLS is the enforcement layer throughout this schema. The answer
-- cache is therefore created with RLS on and NO policy, and a follow-up
-- migration revokes the client grants outright.
--
-- ai_search_answer_cache
--   Repeat questions ("what is our open AR?") re-run the whole tool loop today —
--   several model calls and a fistful of queries for an answer that has not
--   changed since the last person asked it twenty minutes ago.
--
--   The cache key is the load-bearing part and is computed in application code
--   (lib/ai/answer-cache-key.ts) from FOUR things: the normalized question, the
--   project scope, the assistant mode, and a fingerprint of the asker's granted
--   permissions. That last one is not an optimisation — without it, an answer
--   computed for a controller who can see invoices would be replayed verbatim to
--   a superintendent who cannot, and the cache would become a way around RBAC.
--   The permission fingerprint is stored as a column as well as being folded
--   into the key, so a leak would be auditable rather than invisible.
--
--   `data_version` is a fingerprint of the latest `updated_at` across the entity
--   types the answer drew on. Any write to a dependency changes it and the entry
--   stops being served. `expires_at` is the backstop for everything the version
--   fingerprint cannot see.
--
-- ai_standing_questions
--   Questions an org wants answered on a schedule rather than on demand — "which
--   commitments are over budget", "which RFIs are past due with no response" —
--   run by cron so an anomaly surfaces before somebody thinks to ask. The last
--   answer and the last CHANGED answer are both kept: the point of a standing
--   question is the delta, and re-notifying an unchanged answer every morning is
--   how a useful alert becomes one people filter to a folder.

begin;

-- ---------------------------------------------------------------------------
-- Answer cache
-- ---------------------------------------------------------------------------

create table if not exists public.ai_search_answer_cache (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- sha256 of (normalized question, scope, mode, permission fingerprint).
  cache_key text not null,
  question text not null,
  project_id uuid references public.projects(id) on delete cascade,
  assistant_mode text not null default 'org',
  -- Stored alongside the key so a mis-served answer can be traced to a
  -- clearance mismatch instead of being indistinguishable from a hash collision.
  permission_fingerprint text not null,
  data_version text not null,
  answer jsonb not null,
  hit_count integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_search_answer_cache_mode_check
    check (assistant_mode in ('org', 'general')),
  -- A "version" of unknown means we could not establish freshness; such an
  -- entry must never be written, let alone served.
  constraint ai_search_answer_cache_version_check
    check (data_version <> 'unknown')
);

-- One live entry per key per org: a write replaces rather than accumulates.
create unique index if not exists ai_search_answer_cache_org_key_unique
  on public.ai_search_answer_cache (org_id, cache_key);
-- The lookup path.
create index if not exists ai_search_answer_cache_lookup_idx
  on public.ai_search_answer_cache (org_id, cache_key, expires_at desc);
-- Sweeping expired rows.
create index if not exists ai_search_answer_cache_expiry_idx
  on public.ai_search_answer_cache (expires_at);
create index if not exists ai_search_answer_cache_org_project_idx
  on public.ai_search_answer_cache (org_id, project_id)
  where project_id is not null;

alter table public.ai_search_answer_cache enable row level security;

-- Deliberately NO policy at all. The cache is read and written only by the
-- service role inside the assistant, which has already checked the asker's
-- clearance; exposing the table to members directly would let one member read an
-- entry computed under another member's permissions, which is the exact thing
-- the key design exists to prevent. RLS with zero policies denies every client
-- role; the companion revoke migration makes that denial structural rather than
-- dependent on nobody ever adding a policy.
grant all on table public.ai_search_answer_cache to service_role;

drop trigger if exists ai_search_answer_cache_set_updated_at on public.ai_search_answer_cache;
create trigger ai_search_answer_cache_set_updated_at before update on public.ai_search_answer_cache
  for each row execute function public.tg_set_updated_at();

comment on table public.ai_search_answer_cache is
  'Cached assistant answers, keyed on question + scope + mode + the asker''s permission fingerprint. Service-role only: a member must never read an entry computed under a different clearance.';
comment on column public.ai_search_answer_cache.permission_fingerprint is
  'Hash of the sorted permission keys the answer was computed under. Folded into cache_key; stored separately so a mis-serve is auditable.';
comment on column public.ai_search_answer_cache.data_version is
  'Fingerprint of the latest updated_at across the entity types the answer drew on. Any dependency write invalidates the entry.';

-- ---------------------------------------------------------------------------
-- Standing questions (proactive mode)
-- ---------------------------------------------------------------------------

create table if not exists public.ai_standing_questions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  label text not null,
  question text not null,
  -- Cron cadence, kept as a coarse enum rather than a crontab: an operator
  -- picking "daily" should not be able to author an expression that runs the
  -- whole fleet's assistant every minute.
  cadence text not null default 'daily',
  enabled boolean not null default true,
  -- The role this runs AS. A standing question is answered on somebody's behalf
  -- and must obey their clearance, so the runner loads this user's permissions
  -- rather than running unrestricted.
  run_as_user_id uuid references public.app_users(id) on delete set null,
  last_run_at timestamptz,
  last_answer jsonb,
  -- Fingerprint of the last answer, so an unchanged result is not re-notified.
  last_answer_digest text,
  -- When the answer last actually CHANGED — the thing worth surfacing.
  last_changed_at timestamptz,
  last_error text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_standing_questions_cadence_check
    check (cadence in ('hourly', 'daily', 'weekly')),
  constraint ai_standing_questions_question_check
    check (char_length(btrim(question)) between 8 and 1200)
);

create index if not exists ai_standing_questions_org_idx
  on public.ai_standing_questions (org_id, enabled);
create index if not exists ai_standing_questions_project_idx
  on public.ai_standing_questions (org_id, project_id)
  where project_id is not null;
-- The runner's claim query: enabled questions, oldest run first.
create index if not exists ai_standing_questions_due_idx
  on public.ai_standing_questions (cadence, last_run_at nulls first)
  where enabled;

alter table public.ai_standing_questions enable row level security;

-- Members read and manage their own org's standing questions. `(select auth.uid())`
-- rather than a bare call: the bare form re-introduces the initplan performance
-- bug fixed in July 2026.
create policy ai_standing_questions_org_all on public.ai_standing_questions
  for all to authenticated
  using (org_id is not null and public.is_org_member(org_id))
  with check (org_id is not null and public.is_org_member(org_id));

grant select, insert, update, delete on table public.ai_standing_questions to authenticated;
grant all on table public.ai_standing_questions to service_role;

drop trigger if exists ai_standing_questions_set_updated_at on public.ai_standing_questions;
create trigger ai_standing_questions_set_updated_at before update on public.ai_standing_questions
  for each row execute function public.tg_set_updated_at();

comment on table public.ai_standing_questions is
  'Questions answered on a schedule so anomalies surface before anyone asks. Answered AS run_as_user_id, so a standing question never sees more than the person who owns it.';
comment on column public.ai_standing_questions.last_answer_digest is
  'Digest of the last answer. An unchanged digest is not re-notified — the delta is the point.';

commit;
