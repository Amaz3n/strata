-- Phase 7 financial ecosystem:
-- add GMP classification and contract-aware forecast snapshots.

alter table public.change_order_lines
  add column if not exists gmp_classification text not null default 'inside_gmp',
  add column if not exists gmp_impact text not null default 'none',
  add column if not exists gmp_delta_cents integer not null default 0;

alter table public.change_order_lines
  drop constraint if exists change_order_lines_gmp_classification_check,
  add constraint change_order_lines_gmp_classification_check
    check (gmp_classification in ('inside_gmp', 'outside_gmp'));

alter table public.change_order_lines
  drop constraint if exists change_order_lines_gmp_impact_check,
  add constraint change_order_lines_gmp_impact_check
    check (gmp_impact in ('none', 'increase_gmp', 'decrease_gmp', 'outside_gmp'));

alter table public.budget_revision_lines
  add column if not exists gmp_classification text not null default 'inside_gmp',
  add column if not exists gmp_impact text not null default 'none',
  add column if not exists gmp_delta_cents integer not null default 0;

alter table public.budget_revision_lines
  drop constraint if exists budget_revision_lines_gmp_classification_check,
  add constraint budget_revision_lines_gmp_classification_check
    check (gmp_classification in ('inside_gmp', 'outside_gmp'));

alter table public.budget_revision_lines
  drop constraint if exists budget_revision_lines_gmp_impact_check,
  add constraint budget_revision_lines_gmp_impact_check
    check (gmp_impact in ('none', 'increase_gmp', 'decrease_gmp', 'outside_gmp'));

alter table public.billable_costs
  add column if not exists gmp_classification text not null default 'inside_gmp',
  add column if not exists gmp_exposure_cents integer not null default 0;

alter table public.billable_costs
  drop constraint if exists billable_costs_gmp_classification_check,
  add constraint billable_costs_gmp_classification_check
    check (gmp_classification in ('inside_gmp', 'outside_gmp'));

alter table public.job_cost_entries
  add column if not exists gmp_classification text not null default 'inside_gmp';

alter table public.job_cost_entries
  drop constraint if exists job_cost_entries_gmp_classification_check,
  add constraint job_cost_entries_gmp_classification_check
    check (gmp_classification in ('inside_gmp', 'outside_gmp'));

create index if not exists change_order_lines_gmp_classification_idx
  on public.change_order_lines (org_id, gmp_classification);

create index if not exists change_order_lines_gmp_impact_idx
  on public.change_order_lines (org_id, gmp_impact)
  where gmp_impact <> 'none';

create index if not exists budget_revision_lines_gmp_classification_idx
  on public.budget_revision_lines (org_id, gmp_classification);

create index if not exists budget_revision_lines_gmp_impact_idx
  on public.budget_revision_lines (org_id, gmp_impact)
  where gmp_impact <> 'none';

create index if not exists billable_costs_gmp_classification_idx
  on public.billable_costs (org_id, project_id, gmp_classification);

create index if not exists job_cost_entries_gmp_classification_idx
  on public.job_cost_entries (org_id, project_id, gmp_classification);

create table if not exists public.project_gmp_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid references public.contracts(id) on delete set null,
  snapshot_date date not null default current_date,
  billing_model text not null default 'cost_plus_gmp',
  base_gmp_cents integer not null default 0,
  approved_gmp_change_cents integer not null default 0,
  revised_gmp_cents integer not null default 0,
  inside_gmp_eac_cents integer not null default 0,
  outside_gmp_eac_cents integer not null default 0,
  inside_gmp_actual_cents integer not null default 0,
  outside_gmp_actual_cents integer not null default 0,
  savings_cents integer not null default 0,
  overrun_cents integer not null default 0,
  owner_savings_cents integer not null default 0,
  builder_savings_cents integer not null default 0,
  status text not null default 'ok' check (status in ('ok', 'watch', 'overrun', 'not_configured')),
  warnings jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_gmp_snapshots_unique_date unique (org_id, project_id, snapshot_date)
);

create index if not exists project_gmp_snapshots_project_idx
  on public.project_gmp_snapshots (org_id, project_id, snapshot_date desc);

create index if not exists project_gmp_snapshots_contract_fk_idx
  on public.project_gmp_snapshots (contract_id)
  where contract_id is not null;

create index if not exists project_gmp_snapshots_created_by_fk_idx
  on public.project_gmp_snapshots (created_by)
  where created_by is not null;

create index if not exists project_gmp_snapshots_updated_by_fk_idx
  on public.project_gmp_snapshots (updated_by)
  where updated_by is not null;

drop trigger if exists project_gmp_snapshots_set_updated_at on public.project_gmp_snapshots;
create trigger project_gmp_snapshots_set_updated_at
  before update on public.project_gmp_snapshots
  for each row
  execute function public.tg_set_updated_at();

alter table public.project_gmp_snapshots enable row level security;

drop policy if exists project_gmp_snapshots_access on public.project_gmp_snapshots;
create policy project_gmp_snapshots_access
  on public.project_gmp_snapshots
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.project_gmp_snapshots to authenticated, service_role;
