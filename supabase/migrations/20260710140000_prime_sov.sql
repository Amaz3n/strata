-- Workstream 02: owner-side Schedule of Values + pay applications.
-- Mirrors the proven commitment_sov_lines model on the prime-contract side.
-- Additive only: draw, cost-plus, fee, and T&M billing paths are untouched.

-- Fixed-price projects choose how the owner is billed: milestone draws
-- (residential default) or SOV progress billing (commercial default).
alter table public.project_financial_settings
  add column if not exists fixed_price_billing_basis text not null default 'draws';

alter table public.project_financial_settings
  drop constraint if exists project_financial_settings_fixed_price_billing_basis_check,
  add constraint project_financial_settings_fixed_price_billing_basis_check
    check (fixed_price_billing_basis in ('draws', 'progress'));

create table if not exists public.prime_sov_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  line_number integer not null,
  description text not null,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  budget_line_id uuid references public.budget_lines(id) on delete set null,
  scheduled_value_cents integer not null default 0,
  -- rollups maintained by the pay-application service on each posting:
  previous_billed_cents integer not null default 0,
  stored_materials_cents integer not null default 0,
  retainage_held_cents integer not null default 0,
  retainage_released_cents integer not null default 0,
  retainage_percent_override numeric(5,2)
    check (retainage_percent_override is null or (retainage_percent_override >= 0 and retainage_percent_override <= 100)),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prime_sov_lines_contract_line_number_unique unique (contract_id, line_number)
);

create table if not exists public.pay_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  application_number integer not null,
  period_start date,
  period_end date not null,
  billing_period_id uuid references public.project_billing_periods(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft','submitted','approved','invoiced','paid','void')),
  invoice_id uuid references public.invoices(id) on delete set null,
  -- G702 summary fields, snapshotted at submit time:
  original_contract_sum_cents integer not null default 0,
  change_order_sum_cents integer not null default 0,
  contract_sum_to_date_cents integer not null default 0,
  total_completed_stored_cents integer not null default 0,
  retainage_cents integer not null default 0,
  total_earned_less_retainage_cents integer not null default 0,
  previous_certificates_cents integer not null default 0,
  current_payment_due_cents integer not null default 0,
  balance_to_finish_cents integer not null default 0,
  submitted_at timestamptz,
  approved_at timestamptz,
  pdf_file_id uuid references public.files(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pay_applications_contract_application_number_unique unique (contract_id, application_number)
);

create table if not exists public.pay_application_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  pay_application_id uuid not null references public.pay_applications(id) on delete cascade,
  prime_sov_line_id uuid not null references public.prime_sov_lines(id) on delete cascade,
  -- the G703 columns for THIS period:
  scheduled_value_cents integer not null,
  previous_billed_cents integer not null,
  this_period_cents integer not null default 0,
  stored_materials_cents integer not null default 0,
  percent_complete numeric(6,2) not null default 0,
  balance_to_finish_cents integer not null,
  retainage_cents integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  constraint pay_application_lines_app_sov_line_unique unique (pay_application_id, prime_sov_line_id)
);

create index if not exists prime_sov_lines_org_project_idx
  on public.prime_sov_lines (org_id, project_id);
create index if not exists prime_sov_lines_contract_idx
  on public.prime_sov_lines (org_id, contract_id);
create index if not exists pay_applications_org_project_idx
  on public.pay_applications (org_id, project_id);
create index if not exists pay_applications_contract_idx
  on public.pay_applications (org_id, contract_id);
create index if not exists pay_applications_invoice_idx
  on public.pay_applications (invoice_id)
  where invoice_id is not null;
create index if not exists pay_application_lines_app_idx
  on public.pay_application_lines (org_id, pay_application_id);

drop trigger if exists prime_sov_lines_set_updated_at on public.prime_sov_lines;
create trigger prime_sov_lines_set_updated_at
  before update on public.prime_sov_lines
  for each row execute function public.tg_set_updated_at();

drop trigger if exists pay_applications_set_updated_at on public.pay_applications;
create trigger pay_applications_set_updated_at
  before update on public.pay_applications
  for each row execute function public.tg_set_updated_at();

alter table public.prime_sov_lines enable row level security;
alter table public.pay_applications enable row level security;
alter table public.pay_application_lines enable row level security;

drop policy if exists prime_sov_lines_org_access on public.prime_sov_lines;
create policy prime_sov_lines_org_access
  on public.prime_sov_lines
  for all
  to authenticated
  using (public.is_org_member(org_id))
  with check (
    public.is_org_member(org_id)
    and exists (
      select 1
      from public.projects
      where projects.id = prime_sov_lines.project_id
        and projects.org_id = prime_sov_lines.org_id
    )
  );

drop policy if exists pay_applications_org_access on public.pay_applications;
create policy pay_applications_org_access
  on public.pay_applications
  for all
  to authenticated
  using (public.is_org_member(org_id))
  with check (
    public.is_org_member(org_id)
    and exists (
      select 1
      from public.projects
      where projects.id = pay_applications.project_id
        and projects.org_id = pay_applications.org_id
    )
  );

drop policy if exists pay_application_lines_org_access on public.pay_application_lines;
create policy pay_application_lines_org_access
  on public.pay_application_lines
  for all
  to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

grant all on table public.prime_sov_lines to authenticated, service_role;
grant all on table public.pay_applications to authenticated, service_role;
grant all on table public.pay_application_lines to authenticated, service_role;
