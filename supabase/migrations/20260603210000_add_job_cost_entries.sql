-- Phase 2 financial ecosystem:
-- introduce a real job-cost actual ledger so Budget/WIP no longer derives
-- actuals only from approved vendor bill lines.

create table if not exists public.job_cost_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  source_type text not null check (source_type in ('vendor_bill_line', 'project_expense', 'time_entry', 'manual_adjustment')),
  source_id uuid not null,
  incurred_on date not null,
  cost_cents integer not null,
  status text not null default 'posted' check (status in ('pending', 'approved', 'posted', 'voided')),
  is_billable boolean not null default false,
  billable_cost_id uuid references public.billable_costs(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_cost_entries_source_unique unique (org_id, source_type, source_id)
);

create index if not exists job_cost_entries_org_project_status_idx
  on public.job_cost_entries (org_id, project_id, status);

create index if not exists job_cost_entries_org_project_cost_code_idx
  on public.job_cost_entries (org_id, project_id, cost_code_id);

create index if not exists job_cost_entries_incurred_on_idx
  on public.job_cost_entries (org_id, project_id, incurred_on);

create index if not exists job_cost_entries_billable_cost_idx
  on public.job_cost_entries (org_id, billable_cost_id)
  where billable_cost_id is not null;

drop trigger if exists job_cost_entries_set_updated_at on public.job_cost_entries;
create trigger job_cost_entries_set_updated_at
  before update on public.job_cost_entries
  for each row
  execute function public.tg_set_updated_at();

alter table public.job_cost_entries enable row level security;

drop policy if exists job_cost_entries_access on public.job_cost_entries;
create policy job_cost_entries_access
  on public.job_cost_entries
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.job_cost_entries to authenticated, service_role;

insert into public.job_cost_entries (
  org_id,
  project_id,
  cost_code_id,
  source_type,
  source_id,
  incurred_on,
  cost_cents,
  status,
  is_billable,
  billable_cost_id,
  invoice_id,
  metadata
)
select
  b.org_id,
  b.project_id,
  l.cost_code_id,
  'vendor_bill_line',
  l.id,
  coalesce(b.bill_date, b.approved_at::date, b.created_at::date),
  round(coalesce(l.unit_cost_cents, 0)::numeric * coalesce(l.quantity, 1))::integer,
  'posted',
  (bc.id is not null and bc.is_billable is true and bc.status <> 'excluded'),
  bc.id,
  bc.invoice_id,
  jsonb_build_object(
    'source_label', 'vendor_bill_line',
    'bill_id', b.id,
    'bill_number', b.bill_number,
    'bill_status', b.status,
    'description', l.description
  ) || coalesce(l.metadata, '{}'::jsonb)
from public.bill_lines l
join public.vendor_bills b
  on b.id = l.bill_id
 and b.org_id = l.org_id
left join public.billable_costs bc
  on bc.org_id = l.org_id
 and bc.source_type = 'vendor_bill_line'
 and bc.source_id = l.id
 and bc.status <> 'voided'
where b.status in ('approved', 'partial', 'paid')
  and round(coalesce(l.unit_cost_cents, 0)::numeric * coalesce(l.quantity, 1))::integer <> 0
on conflict (org_id, source_type, source_id)
do update set
  project_id = excluded.project_id,
  cost_code_id = excluded.cost_code_id,
  incurred_on = excluded.incurred_on,
  cost_cents = excluded.cost_cents,
  status = excluded.status,
  is_billable = excluded.is_billable,
  billable_cost_id = excluded.billable_cost_id,
  invoice_id = excluded.invoice_id,
  metadata = excluded.metadata;

insert into public.job_cost_entries (
  org_id,
  project_id,
  cost_code_id,
  source_type,
  source_id,
  incurred_on,
  cost_cents,
  status,
  is_billable,
  billable_cost_id,
  invoice_id,
  metadata
)
select
  e.org_id,
  e.project_id,
  e.cost_code_id,
  'project_expense',
  e.id,
  e.expense_date,
  coalesce(e.amount_cents, 0) + coalesce(e.tax_cents, 0),
  'posted',
  (bc.id is not null and bc.is_billable is true and bc.status <> 'excluded'),
  coalesce(e.billable_cost_id, bc.id),
  bc.invoice_id,
  jsonb_build_object(
    'source_label', 'project_expense',
    'expense_status', e.status,
    'description', coalesce(e.description, e.vendor_name_text),
    'vendor_company_id', e.vendor_company_id,
    'vendor_name_text', e.vendor_name_text,
    'receipt_file_id', e.receipt_file_id
  ) || coalesce(e.metadata, '{}'::jsonb)
from public.project_expenses e
left join public.billable_costs bc
  on bc.org_id = e.org_id
 and bc.source_type = 'project_expense'
 and bc.source_id = e.id
 and bc.status <> 'voided'
where e.status in ('approved', 'locked')
  and (coalesce(e.amount_cents, 0) + coalesce(e.tax_cents, 0)) <> 0
on conflict (org_id, source_type, source_id)
do update set
  project_id = excluded.project_id,
  cost_code_id = excluded.cost_code_id,
  incurred_on = excluded.incurred_on,
  cost_cents = excluded.cost_cents,
  status = excluded.status,
  is_billable = excluded.is_billable,
  billable_cost_id = excluded.billable_cost_id,
  invoice_id = excluded.invoice_id,
  metadata = excluded.metadata;

insert into public.job_cost_entries (
  org_id,
  project_id,
  cost_code_id,
  source_type,
  source_id,
  incurred_on,
  cost_cents,
  status,
  is_billable,
  billable_cost_id,
  invoice_id,
  metadata
)
select
  t.org_id,
  t.project_id,
  t.cost_code_id,
  'time_entry',
  t.id,
  t.work_date,
  coalesce(t.cost_cents, round(coalesce(t.hours, 0)::numeric * coalesce(t.base_rate_cents, 0)::numeric * coalesce(t.burden_multiplier, 1)::numeric)::integer),
  'posted',
  (bc.id is not null and bc.is_billable is true and bc.status <> 'excluded'),
  coalesce(t.billable_cost_id, bc.id),
  bc.invoice_id,
  jsonb_build_object(
    'source_label', 'time_entry',
    'time_entry_status', t.status,
    'worker_user_id', t.worker_user_id,
    'worker_company_id', t.worker_company_id,
    'worker_name', t.worker_name,
    'hours', t.hours,
    'base_rate_cents', t.base_rate_cents,
    'burden_multiplier', t.burden_multiplier
  ) || coalesce(t.metadata, '{}'::jsonb)
from public.time_entries t
left join public.billable_costs bc
  on bc.org_id = t.org_id
 and bc.source_type = 'time_entry'
 and bc.source_id = t.id
 and bc.status <> 'voided'
where t.status in ('pm_approved', 'client_approved', 'locked')
  and coalesce(t.cost_cents, round(coalesce(t.hours, 0)::numeric * coalesce(t.base_rate_cents, 0)::numeric * coalesce(t.burden_multiplier, 1)::numeric)::integer) <> 0
on conflict (org_id, source_type, source_id)
do update set
  project_id = excluded.project_id,
  cost_code_id = excluded.cost_code_id,
  incurred_on = excluded.incurred_on,
  cost_cents = excluded.cost_cents,
  status = excluded.status,
  is_billable = excluded.is_billable,
  billable_cost_id = excluded.billable_cost_id,
  invoice_id = excluded.invoice_id,
  metadata = excluded.metadata;
