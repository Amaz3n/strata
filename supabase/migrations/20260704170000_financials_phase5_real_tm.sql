-- Phase 5: real time-and-materials rate schedules and field tickets.

alter table public.time_entries
  add column if not exists is_double_time boolean not null default false,
  add column if not exists dt_multiplier numeric not null default 2.0;

alter table public.time_entries
  drop constraint if exists time_entries_dt_multiplier_check,
  add constraint time_entries_dt_multiplier_check check (dt_multiplier >= 1.0 and dt_multiplier <= 4.0);

alter table public.time_entries
  drop constraint if exists time_entries_ot_dt_exclusive_check,
  add constraint time_entries_ot_dt_exclusive_check check (not (is_overtime and is_double_time));

create table if not exists public.billing_rate_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active',
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_rate_schedules_status_check check (status in ('draft', 'active', 'archived')),
  constraint billing_rate_schedules_name_check check (length(trim(name)) > 0)
);

create unique index if not exists billing_rate_schedules_org_name_active_uq
  on public.billing_rate_schedules (org_id, lower(name))
  where status <> 'archived';

create index if not exists billing_rate_schedules_org_status_idx
  on public.billing_rate_schedules (org_id, status);

drop trigger if exists billing_rate_schedules_set_updated_at on public.billing_rate_schedules;
create trigger billing_rate_schedules_set_updated_at
  before update on public.billing_rate_schedules
  for each row execute function public.tg_set_updated_at();

alter table public.billing_rate_schedules enable row level security;
drop policy if exists "billing_rate_schedules_access" on public.billing_rate_schedules;
create policy "billing_rate_schedules_access"
  on public.billing_rate_schedules
  for all
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.billing_rate_schedules to authenticated, service_role;

alter table public.contracts
  add column if not exists rate_schedule_id uuid references public.billing_rate_schedules(id) on delete set null;

create index if not exists contracts_rate_schedule_idx
  on public.contracts (org_id, rate_schedule_id);

create table if not exists public.billing_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  schedule_id uuid not null references public.billing_rate_schedules(id) on delete cascade,
  kind text not null,
  role_name text,
  user_id uuid references public.app_users(id) on delete cascade,
  equipment_name text,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  rate_cents integer,
  markup_percent numeric,
  ot_multiplier numeric not null default 1.5,
  dt_multiplier numeric not null default 2.0,
  unit text not null default 'hour',
  effective_from date not null default current_date,
  effective_to date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_rates_kind_check check (kind in ('labor_role', 'person', 'equipment', 'material')),
  constraint billing_rates_unit_check check (unit in ('hour', 'day', 'each')),
  constraint billing_rates_amount_check check (
    (kind = 'material' and (markup_percent is not null or rate_cents is not null))
    or (kind <> 'material' and rate_cents is not null and rate_cents >= 0)
  ),
  constraint billing_rates_markup_check check (markup_percent is null or (markup_percent >= 0 and markup_percent <= 300)),
  constraint billing_rates_multiplier_check check (ot_multiplier >= 1.0 and ot_multiplier <= 4.0 and dt_multiplier >= 1.0 and dt_multiplier <= 4.0),
  constraint billing_rates_dates_check check (effective_to is null or effective_to >= effective_from),
  constraint billing_rates_target_check check (
    (kind = 'labor_role' and role_name is not null and user_id is null and equipment_name is null)
    or (kind = 'person' and user_id is not null and role_name is null and equipment_name is null)
    or (kind = 'equipment' and equipment_name is not null and user_id is null)
    or (kind = 'material')
  )
);

create index if not exists billing_rates_schedule_kind_idx
  on public.billing_rates (schedule_id, kind, effective_from, effective_to);

create index if not exists billing_rates_org_person_idx
  on public.billing_rates (org_id, user_id)
  where kind = 'person';

create index if not exists billing_rates_org_role_idx
  on public.billing_rates (org_id, lower(role_name))
  where kind = 'labor_role';

create index if not exists billing_rates_org_cost_code_idx
  on public.billing_rates (org_id, cost_code_id)
  where kind = 'material';

drop trigger if exists billing_rates_set_updated_at on public.billing_rates;
create trigger billing_rates_set_updated_at
  before update on public.billing_rates
  for each row execute function public.tg_set_updated_at();

alter table public.billing_rates enable row level security;
drop policy if exists "billing_rates_access" on public.billing_rates;
create policy "billing_rates_access"
  on public.billing_rates
  for all
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.billing_rates to authenticated, service_role;

create table if not exists public.billing_rate_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid references public.contracts(id) on delete cascade,
  schedule_id uuid references public.billing_rate_schedules(id) on delete set null,
  kind text not null,
  role_name text,
  user_id uuid references public.app_users(id) on delete cascade,
  equipment_name text,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  rate_cents integer,
  markup_percent numeric,
  ot_multiplier numeric not null default 1.5,
  dt_multiplier numeric not null default 2.0,
  unit text not null default 'hour',
  effective_from date not null default current_date,
  effective_to date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_rate_overrides_kind_check check (kind in ('labor_role', 'person', 'equipment', 'material')),
  constraint billing_rate_overrides_unit_check check (unit in ('hour', 'day', 'each')),
  constraint billing_rate_overrides_amount_check check (
    (kind = 'material' and (markup_percent is not null or rate_cents is not null))
    or (kind <> 'material' and rate_cents is not null and rate_cents >= 0)
  ),
  constraint billing_rate_overrides_markup_check check (markup_percent is null or (markup_percent >= 0 and markup_percent <= 300)),
  constraint billing_rate_overrides_multiplier_check check (ot_multiplier >= 1.0 and ot_multiplier <= 4.0 and dt_multiplier >= 1.0 and dt_multiplier <= 4.0),
  constraint billing_rate_overrides_dates_check check (effective_to is null or effective_to >= effective_from),
  constraint billing_rate_overrides_target_check check (
    (kind = 'labor_role' and role_name is not null and user_id is null and equipment_name is null)
    or (kind = 'person' and user_id is not null and role_name is null and equipment_name is null)
    or (kind = 'equipment' and equipment_name is not null and user_id is null)
    or (kind = 'material')
  )
);

create index if not exists billing_rate_overrides_project_kind_idx
  on public.billing_rate_overrides (org_id, project_id, kind, effective_from, effective_to);

create index if not exists billing_rate_overrides_contract_idx
  on public.billing_rate_overrides (org_id, contract_id);

drop trigger if exists billing_rate_overrides_set_updated_at on public.billing_rate_overrides;
create trigger billing_rate_overrides_set_updated_at
  before update on public.billing_rate_overrides
  for each row execute function public.tg_set_updated_at();

alter table public.billing_rate_overrides enable row level security;
drop policy if exists "billing_rate_overrides_access" on public.billing_rate_overrides;
create policy "billing_rate_overrides_access"
  on public.billing_rate_overrides
  for all
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.billing_rate_overrides to authenticated, service_role;

create table if not exists public.tm_tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid references public.contracts(id) on delete set null,
  ticket_number text not null,
  work_date date not null,
  status text not null default 'draft',
  notes text,
  submitted_at timestamptz,
  submitted_by uuid references public.app_users(id) on delete set null,
  client_signed_at timestamptz,
  client_signer_name text,
  client_signer_email text,
  client_signer_ip text,
  signature_data jsonb,
  signature_token_hash text,
  signature_token_expires_at timestamptz,
  invoice_id uuid references public.invoices(id) on delete set null,
  backup_file_id uuid references public.files(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tm_tickets_status_check check (status in ('draft', 'submitted', 'client_signed', 'billed', 'voided')),
  constraint tm_tickets_number_check check (length(trim(ticket_number)) > 0)
);

create unique index if not exists tm_tickets_project_number_uq
  on public.tm_tickets (org_id, project_id, lower(ticket_number))
  where status <> 'voided';

create index if not exists tm_tickets_project_status_idx
  on public.tm_tickets (org_id, project_id, status, work_date desc);

create unique index if not exists tm_tickets_signature_token_hash_uq
  on public.tm_tickets (signature_token_hash)
  where signature_token_hash is not null;

drop trigger if exists tm_tickets_set_updated_at on public.tm_tickets;
create trigger tm_tickets_set_updated_at
  before update on public.tm_tickets
  for each row execute function public.tg_set_updated_at();

alter table public.tm_tickets enable row level security;
drop policy if exists "tm_tickets_access" on public.tm_tickets;
create policy "tm_tickets_access"
  on public.tm_tickets
  for all
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.tm_tickets to authenticated, service_role;

create table if not exists public.tm_ticket_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  ticket_id uuid not null references public.tm_tickets(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  source_type text not null,
  source_id text not null,
  billable_cost_id uuid references public.billable_costs(id) on delete set null,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  occurred_on date not null,
  description text,
  quantity numeric not null default 1,
  cost_cents integer not null default 0,
  billable_cents integer not null default 0,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tm_ticket_items_source_type_check check (source_type in ('time_entry', 'project_expense', 'project_expense_line'))
);

create unique index if not exists tm_ticket_items_ticket_source_uq
  on public.tm_ticket_items (org_id, ticket_id, source_type, source_id);

create index if not exists tm_ticket_items_project_source_idx
  on public.tm_ticket_items (org_id, project_id, source_type, source_id);

create index if not exists tm_ticket_items_billable_cost_idx
  on public.tm_ticket_items (org_id, billable_cost_id);

drop trigger if exists tm_ticket_items_set_updated_at on public.tm_ticket_items;
create trigger tm_ticket_items_set_updated_at
  before update on public.tm_ticket_items
  for each row execute function public.tg_set_updated_at();

alter table public.tm_ticket_items enable row level security;
drop policy if exists "tm_ticket_items_access" on public.tm_ticket_items;
create policy "tm_ticket_items_access"
  on public.tm_ticket_items
  for all
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.tm_ticket_items to authenticated, service_role;
