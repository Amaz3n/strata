-- Phase 6 financial ecosystem:
-- fixed-fee / construction-management fee schedules, fee billings, and invoice links.

create table if not exists public.project_fee_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid references public.contracts(id) on delete set null,
  name text not null default 'Construction management fee',
  status text not null default 'active'
    check (status in ('draft', 'active', 'closed', 'voided')),
  fee_basis text not null default 'fixed_fee'
    check (fee_basis in ('fixed_fee', 'percent_of_costs', 'manual')),
  earned_calculation text not null default 'percent_complete'
    check (earned_calculation in ('percent_complete', 'manual', 'milestone')),
  total_fee_cents integer not null default 0 check (total_fee_cents >= 0),
  currency text not null default 'usd',
  effective_date date,
  closed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_fee_schedules_active_project_uq
  on public.project_fee_schedules (org_id, project_id)
  where status in ('draft', 'active');

create index if not exists project_fee_schedules_org_project_status_idx
  on public.project_fee_schedules (org_id, project_id, status);

create index if not exists project_fee_schedules_contract_fk_idx
  on public.project_fee_schedules (contract_id)
  where contract_id is not null;

create index if not exists project_fee_schedules_created_by_fk_idx
  on public.project_fee_schedules (created_by)
  where created_by is not null;

create index if not exists project_fee_schedules_updated_by_fk_idx
  on public.project_fee_schedules (updated_by)
  where updated_by is not null;

drop trigger if exists project_fee_schedules_set_updated_at on public.project_fee_schedules;
create trigger project_fee_schedules_set_updated_at
  before update on public.project_fee_schedules
  for each row execute function public.tg_set_updated_at();

alter table public.project_fee_schedules enable row level security;

drop policy if exists project_fee_schedules_access on public.project_fee_schedules;
create policy project_fee_schedules_access
  on public.project_fee_schedules
  using ((auth.role() = 'service_role') or (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))))
  with check ((auth.role() = 'service_role') or (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))));

grant all on table public.project_fee_schedules to authenticated, service_role;

create table if not exists public.project_fee_schedule_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  schedule_id uuid not null references public.project_fee_schedules(id) on delete cascade,
  billing_period_id uuid references public.project_billing_periods(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  invoice_line_id uuid references public.invoice_lines(id) on delete set null,
  name text not null,
  description text,
  status text not null default 'unbilled'
    check (status in ('planned', 'earned', 'unbilled', 'partially_billed', 'billed', 'voided')),
  scheduled_fee_cents integer not null default 0 check (scheduled_fee_cents >= 0),
  earned_fee_cents integer not null default 0 check (earned_fee_cents >= 0),
  billed_fee_cents integer not null default 0 check (billed_fee_cents >= 0),
  percent_complete numeric(7,4) not null default 0 check (percent_complete >= 0 and percent_complete <= 100),
  earned_at timestamptz,
  billed_at timestamptz,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_fee_schedule_lines_org_project_status_idx
  on public.project_fee_schedule_lines (org_id, project_id, status);

create index if not exists project_fee_schedule_lines_schedule_fk_idx
  on public.project_fee_schedule_lines (schedule_id);

create index if not exists project_fee_schedule_lines_billing_period_fk_idx
  on public.project_fee_schedule_lines (billing_period_id)
  where billing_period_id is not null;

create index if not exists project_fee_schedule_lines_invoice_fk_idx
  on public.project_fee_schedule_lines (invoice_id)
  where invoice_id is not null;

create index if not exists project_fee_schedule_lines_invoice_line_fk_idx
  on public.project_fee_schedule_lines (invoice_line_id)
  where invoice_line_id is not null;

create index if not exists project_fee_schedule_lines_created_by_fk_idx
  on public.project_fee_schedule_lines (created_by)
  where created_by is not null;

create index if not exists project_fee_schedule_lines_updated_by_fk_idx
  on public.project_fee_schedule_lines (updated_by)
  where updated_by is not null;

drop trigger if exists project_fee_schedule_lines_set_updated_at on public.project_fee_schedule_lines;
create trigger project_fee_schedule_lines_set_updated_at
  before update on public.project_fee_schedule_lines
  for each row execute function public.tg_set_updated_at();

alter table public.project_fee_schedule_lines enable row level security;

drop policy if exists project_fee_schedule_lines_access on public.project_fee_schedule_lines;
create policy project_fee_schedule_lines_access
  on public.project_fee_schedule_lines
  using ((auth.role() = 'service_role') or (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))))
  with check ((auth.role() = 'service_role') or (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))));

grant all on table public.project_fee_schedule_lines to authenticated, service_role;

create table if not exists public.project_fee_billings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  schedule_id uuid not null references public.project_fee_schedules(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  billing_period_id uuid references public.project_billing_periods(id) on delete set null,
  status text not null default 'billed'
    check (status in ('draft', 'billed', 'voided')),
  fee_line_ids uuid[] not null default '{}'::uuid[],
  subtotal_fee_cents integer not null default 0 check (subtotal_fee_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  total_fee_cents integer not null default 0 check (total_fee_cents >= 0),
  billed_at timestamptz,
  voided_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_fee_billings_invoice_uq
  on public.project_fee_billings (org_id, invoice_id)
  where invoice_id is not null and status <> 'voided';

create index if not exists project_fee_billings_org_project_status_idx
  on public.project_fee_billings (org_id, project_id, status);

create index if not exists project_fee_billings_schedule_fk_idx
  on public.project_fee_billings (schedule_id);

create index if not exists project_fee_billings_billing_period_fk_idx
  on public.project_fee_billings (billing_period_id)
  where billing_period_id is not null;

create index if not exists project_fee_billings_created_by_fk_idx
  on public.project_fee_billings (created_by)
  where created_by is not null;

create index if not exists project_fee_billings_updated_by_fk_idx
  on public.project_fee_billings (updated_by)
  where updated_by is not null;

drop trigger if exists project_fee_billings_set_updated_at on public.project_fee_billings;
create trigger project_fee_billings_set_updated_at
  before update on public.project_fee_billings
  for each row execute function public.tg_set_updated_at();

alter table public.project_fee_billings enable row level security;

drop policy if exists project_fee_billings_access on public.project_fee_billings;
create policy project_fee_billings_access
  on public.project_fee_billings
  using ((auth.role() = 'service_role') or (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))))
  with check ((auth.role() = 'service_role') or (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))));

grant all on table public.project_fee_billings to authenticated, service_role;
