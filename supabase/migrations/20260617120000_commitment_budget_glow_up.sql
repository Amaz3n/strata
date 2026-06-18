-- PM-grade commitment and no-cost-code budget foundations.
-- Additive only: existing commitments, bills, and budgets continue to work.

alter table public.change_order_lines
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

alter table public.budget_revision_lines
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

create index if not exists change_order_lines_budget_line_idx
  on public.change_order_lines (budget_line_id)
  where budget_line_id is not null;

create index if not exists budget_revision_lines_budget_line_idx
  on public.budget_revision_lines (budget_line_id)
  where budget_line_id is not null;

alter table public.commitments
  add column if not exists contract_number text,
  add column if not exists scope text,
  add column if not exists terms text,
  add column if not exists retainage_percent numeric(5,2) not null default 0,
  add column if not exists executed_at timestamptz,
  add column if not exists executed_file_id uuid references public.files(id) on delete set null,
  add column if not exists source_document_id uuid references public.documents(id) on delete set null,
  add column if not exists signature_envelope_id uuid references public.envelopes(id) on delete set null,
  add column if not exists commitment_type text not null default 'subcontract';

alter table public.commitments
  drop constraint if exists commitments_retainage_percent_check,
  add constraint commitments_retainage_percent_check
    check (retainage_percent >= 0 and retainage_percent <= 100);

alter table public.commitment_lines
  add column if not exists scheduled_value_cents integer,
  add column if not exists retainage_percent numeric(5,2);

alter table public.commitment_lines
  drop constraint if exists commitment_lines_retainage_percent_check,
  add constraint commitment_lines_retainage_percent_check
    check (retainage_percent is null or (retainage_percent >= 0 and retainage_percent <= 100));

create table if not exists public.commitment_change_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  commitment_id uuid not null references public.commitments(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'approved', 'rejected', 'voided')),
  total_cents integer not null default 0,
  currency text not null default 'usd',
  approved_at timestamptz,
  approved_by uuid references public.app_users(id) on delete set null,
  source_document_id uuid references public.documents(id) on delete set null,
  executed_file_id uuid references public.files(id) on delete set null,
  signature_envelope_id uuid references public.envelopes(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.commitment_change_order_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  commitment_change_order_id uuid not null references public.commitment_change_orders(id) on delete cascade,
  commitment_line_id uuid references public.commitment_lines(id) on delete set null,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  budget_line_id uuid references public.budget_lines(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer not null default 0,
  amount_cents integer not null default 0,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.commitment_sov_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  commitment_id uuid not null references public.commitments(id) on delete cascade,
  commitment_line_id uuid references public.commitment_lines(id) on delete set null,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  budget_line_id uuid references public.budget_lines(id) on delete set null,
  description text not null,
  scheduled_value_cents integer not null default 0,
  previous_billed_cents integer not null default 0,
  current_billed_cents integer not null default 0,
  stored_materials_cents integer not null default 0,
  retainage_held_cents integer not null default 0,
  retainage_released_cents integer not null default 0,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vendor_bill_sov_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  bill_id uuid not null references public.vendor_bills(id) on delete cascade,
  commitment_id uuid references public.commitments(id) on delete cascade,
  commitment_line_id uuid references public.commitment_lines(id) on delete set null,
  commitment_sov_line_id uuid references public.commitment_sov_lines(id) on delete set null,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  budget_line_id uuid references public.budget_lines(id) on delete set null,
  previous_billed_cents integer not null default 0,
  current_billed_cents integer not null default 0,
  stored_materials_cents integer not null default 0,
  retainage_held_cents integer not null default 0,
  retainage_released_cents integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists commitment_change_orders_commitment_idx
  on public.commitment_change_orders (org_id, commitment_id);
create index if not exists commitment_change_orders_project_status_idx
  on public.commitment_change_orders (org_id, project_id, status);
create index if not exists commitment_change_order_lines_cco_idx
  on public.commitment_change_order_lines (org_id, commitment_change_order_id);
create index if not exists commitment_sov_lines_commitment_idx
  on public.commitment_sov_lines (org_id, commitment_id);
create index if not exists vendor_bill_sov_allocations_bill_idx
  on public.vendor_bill_sov_allocations (org_id, bill_id);

alter table public.commitment_change_orders enable row level security;
alter table public.commitment_change_order_lines enable row level security;
alter table public.commitment_sov_lines enable row level security;
alter table public.vendor_bill_sov_allocations enable row level security;

drop policy if exists commitment_change_orders_access on public.commitment_change_orders;
create policy commitment_change_orders_access on public.commitment_change_orders
  for all
  using (
    auth.role() = 'service_role'
    or (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id)))
  )
  with check (
    auth.role() = 'service_role'
    or (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id)))
  );

drop policy if exists commitment_change_order_lines_access on public.commitment_change_order_lines;
create policy commitment_change_order_lines_access on public.commitment_change_order_lines
  for all
  using (
    auth.role() = 'service_role'
    or public.is_org_member(org_id)
  )
  with check (
    auth.role() = 'service_role'
    or public.is_org_member(org_id)
  );

drop policy if exists commitment_sov_lines_access on public.commitment_sov_lines;
create policy commitment_sov_lines_access on public.commitment_sov_lines
  for all
  using (
    auth.role() = 'service_role'
    or public.is_org_member(org_id)
  )
  with check (
    auth.role() = 'service_role'
    or public.is_org_member(org_id)
  );

drop policy if exists vendor_bill_sov_allocations_access on public.vendor_bill_sov_allocations;
create policy vendor_bill_sov_allocations_access on public.vendor_bill_sov_allocations
  for all
  using (
    auth.role() = 'service_role'
    or public.is_org_member(org_id)
  )
  with check (
    auth.role() = 'service_role'
    or public.is_org_member(org_id)
  );

grant all on table public.commitment_change_orders to anon, authenticated, service_role;
grant all on table public.commitment_change_order_lines to anon, authenticated, service_role;
grant all on table public.commitment_sov_lines to anon, authenticated, service_role;
grant all on table public.vendor_bill_sov_allocations to anon, authenticated, service_role;
