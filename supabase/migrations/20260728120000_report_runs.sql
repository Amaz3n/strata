-- Report runs: an immutable record of every report pulled out of Arc.
--
-- A WIP schedule sent to a lender in July is asked about again in October, by
-- which time the underlying invoices have moved. Without a snapshot there is no
-- way to answer "what did the numbers say when we sent it". Every export writes
-- one row here carrying the exact parameters and the rendered result, so a pull
-- can be reproduced byte-for-byte long after the live data has drifted.
--
-- Rows are append-only by design: no update policy, no updated_at. A run that
-- could be edited would be worthless as evidence.

create table if not exists public.report_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- Registry slug (lib/reports/registry.ts). Deliberately not a FK: the catalog
  -- is code, and a retired report's history must survive its definition.
  slug text not null,
  scope text not null check (scope in ('org', 'project')),
  project_id uuid references public.projects(id) on delete cascade,
  -- Ambient lens at run time, so a division-scoped pull can be told apart from
  -- an org-wide one with otherwise identical parameters.
  division_id uuid references public.divisions(id) on delete set null,
  community_id uuid references public.communities(id) on delete set null,
  -- The exact parameter set, as parsed. Replaying these reproduces the request.
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  -- The rendered ReportResult: stats, tables, totals. The evidence itself.
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  row_count integer not null default 0,
  -- 'view' when opened on screen, 'csv'/'pdf' when a file left the building.
  format text not null default 'view' check (format in ('view', 'csv', 'pdf', 'json')),
  title text not null,
  subtitle text,
  run_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint report_runs_project_scope check (
    (scope = 'project' and project_id is not null) or (scope = 'org' and project_id is null)
  )
);

create index if not exists report_runs_org_slug_idx
  on public.report_runs (org_id, slug, created_at desc);
create index if not exists report_runs_org_created_idx
  on public.report_runs (org_id, created_at desc);
create index if not exists report_runs_project_idx
  on public.report_runs (org_id, project_id, created_at desc)
  where project_id is not null;
create index if not exists report_runs_run_by_idx
  on public.report_runs (org_id, run_by, created_at desc);

alter table public.report_runs enable row level security;

-- Anyone who can read reports can read the history; runs are written server-side
-- by the report service. No update or delete policy: history is append-only.
create policy report_runs_read on public.report_runs
  for select to authenticated
  using (public.has_org_permission(org_id, 'report.read'));

create policy report_runs_insert on public.report_runs
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'report.read'));

grant select, insert on table public.report_runs to authenticated;
grant all on table public.report_runs to service_role;
