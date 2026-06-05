-- Phase 4 financial ecosystem:
-- add project billing periods and link approved-cost billing rows to periods.

create table if not exists public.project_billing_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'invoiced', 'closed', 'reopened')),
  invoice_ids uuid[] not null default '{}'::uuid[],
  closed_by uuid references public.app_users(id) on delete set null,
  closed_at timestamptz,
  reopened_by uuid references public.app_users(id) on delete set null,
  reopened_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_billing_periods_date_order check (period_start <= period_end),
  constraint project_billing_periods_project_dates_unique unique (org_id, project_id, period_start, period_end)
);

create index if not exists project_billing_periods_org_project_status_idx
  on public.project_billing_periods (org_id, project_id, status);

create index if not exists project_billing_periods_org_project_dates_idx
  on public.project_billing_periods (org_id, project_id, period_start, period_end);

drop trigger if exists project_billing_periods_set_updated_at on public.project_billing_periods;
create trigger project_billing_periods_set_updated_at
  before update on public.project_billing_periods
  for each row
  execute function public.tg_set_updated_at();

alter table public.project_billing_periods enable row level security;

drop policy if exists project_billing_periods_access on public.project_billing_periods;
create policy project_billing_periods_access
  on public.project_billing_periods
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.project_billing_periods to authenticated, service_role;

alter table public.invoices
  add column if not exists billing_period_id uuid references public.project_billing_periods(id) on delete set null;

create index if not exists invoices_billing_period_idx
  on public.invoices (org_id, billing_period_id)
  where billing_period_id is not null;

alter table public.billable_costs
  add column if not exists billing_period_id uuid references public.project_billing_periods(id) on delete set null,
  add column if not exists late_to_billing_period_id uuid references public.project_billing_periods(id) on delete set null;

create index if not exists billable_costs_billing_period_idx
  on public.billable_costs (org_id, project_id, billing_period_id)
  where billing_period_id is not null;

create index if not exists billable_costs_late_to_billing_period_idx
  on public.billable_costs (org_id, project_id, late_to_billing_period_id)
  where late_to_billing_period_id is not null;
