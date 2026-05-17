-- Phase 1: cost-plus and T&M billing core

alter table public.cost_codes add column if not exists is_reimbursable_default boolean not null default true;
alter table public.cost_codes add column if not exists default_markup_percent numeric check (default_markup_percent is null or (default_markup_percent >= 0 and default_markup_percent <= 200));
create index if not exists cost_codes_category_idx on public.cost_codes (category);
create index if not exists cost_codes_org_reimbursable_idx on public.cost_codes (org_id, is_reimbursable_default);

alter table public.contracts add column if not exists gmp_cents integer check (gmp_cents is null or gmp_cents >= 0);
alter table public.contracts add column if not exists savings_split_owner_pct numeric default 0 check (savings_split_owner_pct between 0 and 100);
alter table public.contracts add column if not exists savings_split_builder_pct numeric default 0 check (savings_split_builder_pct between 0 and 100);
alter table public.contracts add column if not exists labor_burden_multiplier numeric default 1.0 check (labor_burden_multiplier >= 1.0);
alter table public.contracts add column if not exists requires_client_cost_approval boolean not null default false;
alter table public.contracts add column if not exists open_book boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contracts_savings_split_total_chk'
  ) then
    alter table public.contracts
      add constraint contracts_savings_split_total_chk
      check (coalesce(savings_split_owner_pct, 0) + coalesce(savings_split_builder_pct, 0) <= 100);
  end if;
end $$;

create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  worker_user_id uuid references public.app_users(id) on delete set null,
  worker_company_id uuid references public.companies(id) on delete set null,
  worker_name text not null,
  work_date date not null,
  hours numeric(6,2) not null check (hours > 0 and hours <= 24),
  base_rate_cents integer not null check (base_rate_cents >= 0),
  burden_multiplier numeric not null default 1.0 check (burden_multiplier >= 1.0),
  cost_cents integer generated always as (round(hours * base_rate_cents * burden_multiplier)::int) stored,
  is_billable boolean not null default true,
  is_overtime boolean not null default false,
  notes text,
  attached_file_ids uuid[] not null default '{}',
  approved_by_pm_at timestamptz,
  approved_by_pm_user_id uuid references public.app_users(id),
  approved_by_client_at timestamptz,
  approval_token_hash text,
  approval_token_expires_at timestamptz,
  status text not null default 'draft' check (status in ('draft','submitted','pm_approved','client_approved','rejected','locked')),
  rejection_reason text,
  billable_cost_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists time_entries_org_idx on public.time_entries (org_id);
create index if not exists time_entries_project_idx on public.time_entries (project_id);
create index if not exists time_entries_status_idx on public.time_entries (status);
create index if not exists time_entries_work_date_idx on public.time_entries (work_date);
create index if not exists time_entries_org_project_status_date_idx on public.time_entries (org_id, project_id, status, work_date);
create index if not exists time_entries_approval_token_hash_idx on public.time_entries (approval_token_hash) where approval_token_hash is not null;
alter table public.time_entries enable row level security;
drop policy if exists time_entries_access on public.time_entries;
create policy time_entries_access on public.time_entries
  for all
  using ((auth.role() = 'service_role'::text) or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role'::text) or public.is_org_member(org_id));
drop trigger if exists time_entries_set_updated_at on public.time_entries;
create trigger time_entries_set_updated_at before update on public.time_entries
  for each row execute function public.tg_set_updated_at();

create table if not exists public.project_expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  vendor_company_id uuid references public.companies(id) on delete set null,
  vendor_name_text text,
  expense_date date not null,
  description text,
  amount_cents integer not null check (amount_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  payment_method text check (payment_method in ('cash','credit_card','check','ach','company_card','reimbursable_personal','other')),
  receipt_file_id uuid references public.files(id) on delete set null,
  is_billable boolean not null default true,
  markup_percent_override numeric check (markup_percent_override is null or (markup_percent_override >= 0 and markup_percent_override <= 200)),
  submitted_by_user_id uuid references public.app_users(id),
  approved_by_pm_at timestamptz,
  approved_by_pm_user_id uuid references public.app_users(id),
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','locked')),
  rejection_reason text,
  billable_cost_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists project_expenses_org_idx on public.project_expenses (org_id);
create index if not exists project_expenses_project_idx on public.project_expenses (project_id);
create index if not exists project_expenses_status_idx on public.project_expenses (status);
create index if not exists project_expenses_date_idx on public.project_expenses (expense_date);
create index if not exists project_expenses_org_project_status_date_idx on public.project_expenses (org_id, project_id, status, expense_date);
alter table public.project_expenses enable row level security;
drop policy if exists project_expenses_access on public.project_expenses;
create policy project_expenses_access on public.project_expenses
  for all
  using ((auth.role() = 'service_role'::text) or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role'::text) or public.is_org_member(org_id));
drop trigger if exists project_expenses_set_updated_at on public.project_expenses;
create trigger project_expenses_set_updated_at before update on public.project_expenses
  for each row execute function public.tg_set_updated_at();

create table if not exists public.markup_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  scope text not null check (scope in ('org','contract','cost_code')),
  contract_id uuid references public.contracts(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete cascade,
  markup_percent numeric not null check (markup_percent >= 0 and markup_percent <= 200),
  applies_to_category text,
  effective_from date,
  effective_to date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint markup_rules_scope_target check (
    (scope = 'org' and contract_id is null and cost_code_id is null) or
    (scope = 'contract' and contract_id is not null and cost_code_id is null) or
    (scope = 'cost_code' and cost_code_id is not null)
  )
);
create index if not exists markup_rules_org_idx on public.markup_rules (org_id);
create index if not exists markup_rules_contract_idx on public.markup_rules (contract_id);
create index if not exists markup_rules_cost_code_idx on public.markup_rules (cost_code_id);
create index if not exists markup_rules_org_scope_dates_idx on public.markup_rules (org_id, scope, effective_from, effective_to);
alter table public.markup_rules enable row level security;
drop policy if exists markup_rules_access on public.markup_rules;
create policy markup_rules_access on public.markup_rules
  for all
  using ((auth.role() = 'service_role'::text) or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role'::text) or public.is_org_member(org_id));
drop trigger if exists markup_rules_set_updated_at on public.markup_rules;
create trigger markup_rules_set_updated_at before update on public.markup_rules
  for each row execute function public.tg_set_updated_at();

create table if not exists public.billable_costs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  source_type text not null check (source_type in ('vendor_bill_line','project_expense','time_entry','manual_adjustment','allowance_overage')),
  source_id uuid not null,
  source_company_id uuid references public.companies(id) on delete set null,
  occurred_on date not null,
  description text,
  cost_cents integer not null,
  markup_percent_resolved numeric not null default 0,
  markup_cents integer not null default 0,
  billable_cents integer generated always as (cost_cents + markup_cents) stored,
  is_billable boolean not null default true,
  invoice_id uuid references public.invoices(id) on delete set null,
  invoice_line_id uuid,
  billed_at timestamptz,
  status text not null default 'open' check (status in ('open','locked','billed','excluded','voided')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billable_costs_org_idx on public.billable_costs (org_id);
create index if not exists billable_costs_project_idx on public.billable_costs (project_id);
create index if not exists billable_costs_status_idx on public.billable_costs (status);
create index if not exists billable_costs_invoice_idx on public.billable_costs (invoice_id);
create index if not exists billable_costs_source_idx on public.billable_costs (source_type, source_id);
create index if not exists billable_costs_org_project_status_date_idx on public.billable_costs (org_id, project_id, status, occurred_on);
create unique index if not exists billable_costs_source_uq on public.billable_costs (source_type, source_id) where status <> 'voided';
alter table public.billable_costs enable row level security;
drop policy if exists billable_costs_access on public.billable_costs;
create policy billable_costs_access on public.billable_costs
  for all
  using ((auth.role() = 'service_role'::text) or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role'::text) or public.is_org_member(org_id));
drop trigger if exists billable_costs_set_updated_at on public.billable_costs;
create trigger billable_costs_set_updated_at before update on public.billable_costs
  for each row execute function public.tg_set_updated_at();

create table if not exists public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  key text not null,
  scope text not null,
  response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, scope, key)
);
create index if not exists idempotency_keys_org_scope_idx on public.idempotency_keys (org_id, scope);
alter table public.idempotency_keys enable row level security;
drop policy if exists idempotency_keys_access on public.idempotency_keys;
create policy idempotency_keys_access on public.idempotency_keys
  for all
  using ((auth.role() = 'service_role'::text) or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role'::text) or public.is_org_member(org_id));

create table if not exists public.cost_approval_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  billable_cost_ids uuid[] not null default '{}',
  time_entry_ids uuid[] not null default '{}',
  expires_at timestamptz not null,
  approved_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cost_approval_batches_org_project_status_idx on public.cost_approval_batches (org_id, project_id, status);
alter table public.cost_approval_batches enable row level security;
drop policy if exists cost_approval_batches_access on public.cost_approval_batches;
create policy cost_approval_batches_access on public.cost_approval_batches
  for all
  using ((auth.role() = 'service_role'::text) or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role'::text) or public.is_org_member(org_id));
drop trigger if exists cost_approval_batches_set_updated_at on public.cost_approval_batches;
create trigger cost_approval_batches_set_updated_at before update on public.cost_approval_batches
  for each row execute function public.tg_set_updated_at();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'time_entries_billable_cost_fk'
  ) then
    alter table public.time_entries
      add constraint time_entries_billable_cost_fk
      foreign key (billable_cost_id) references public.billable_costs(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'project_expenses_billable_cost_fk'
  ) then
    alter table public.project_expenses
      add constraint project_expenses_billable_cost_fk
      foreign key (billable_cost_id) references public.billable_costs(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'billable_costs_invoice_line_fk'
  ) then
    alter table public.billable_costs
      add constraint billable_costs_invoice_line_fk
      foreign key (invoice_line_id) references public.invoice_lines(id) on delete set null;
  end if;
end $$;
