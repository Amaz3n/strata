-- Phase 3: schema updates for proposals, contracts, retainage, allowances, estimate templates

-- Estimate templates (templated estimates)
create table if not exists estimate_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  description text,
  lines jsonb not null default '[]'::jsonb,
  is_default boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists estimate_templates_org_idx on estimate_templates (org_id);
create trigger estimate_templates_set_updated_at before update on estimate_templates for each row execute function public.tg_set_updated_at();

-- Proposal enhancements
alter table proposals add column if not exists number text;
alter table proposals add column if not exists title text;
alter table proposals add column if not exists summary text;
alter table proposals add column if not exists terms text;
alter table proposals add column if not exists valid_until date;
alter table proposals add column if not exists total_cents integer;
alter table proposals add column if not exists signature_required boolean default true;
alter table proposals add column if not exists signature_data jsonb;
alter table proposals add column if not exists token_hash text;
alter table proposals add column if not exists viewed_at timestamptz;

create unique index if not exists proposals_token_hash_idx on proposals (token_hash) where token_hash is not null;
create unique index if not exists proposals_org_number_idx on proposals (org_id, number) where number is not null;

-- Proposal lines
create table if not exists proposal_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  proposal_id uuid not null references proposals(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  line_type text not null default 'item' check (line_type in ('item', 'section', 'allowance', 'option')),
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  markup_percent numeric,
  is_optional boolean default false,
  is_selected boolean default true,
  allowance_cents integer,
  notes text,
  sort_order integer default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists proposal_lines_org_idx on proposal_lines (org_id);
create index if not exists proposal_lines_proposal_idx on proposal_lines (proposal_id);

-- Contract enhancements
alter table contracts add column if not exists number text;
alter table contracts add column if not exists contract_type text default 'fixed' check (contract_type in ('fixed', 'cost_plus', 'time_materials'));
alter table contracts add column if not exists markup_percent numeric;
alter table contracts add column if not exists retainage_percent numeric default 0;
alter table contracts add column if not exists retainage_release_trigger text;
alter table contracts add column if not exists signature_data jsonb;

create unique index if not exists contracts_org_number_idx on contracts (org_id, number) where number is not null;

-- Retainage tracking
create table if not exists retainage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contract_id uuid not null references contracts(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null default 'held' check (status in ('held', 'released', 'invoiced', 'paid')),
  held_at timestamptz not null default now(),
  released_at timestamptz,
  release_invoice_id uuid references invoices(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists retainage_org_idx on retainage (org_id);
create index if not exists retainage_project_idx on retainage (project_id);
create index if not exists retainage_contract_idx on retainage (contract_id);
create index if not exists retainage_status_idx on retainage (status);
create trigger retainage_set_updated_at before update on retainage for each row execute function public.tg_set_updated_at();

-- Allowance tracking
create table if not exists allowances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contract_id uuid references contracts(id) on delete set null,
  selection_category_id uuid,
  name text not null,
  budget_cents integer not null check (budget_cents >= 0),
  used_cents integer not null default 0 check (used_cents >= 0),
  status text not null default 'open' check (status in ('open', 'at_budget', 'over', 'closed')),
  overage_handling text default 'co' check (overage_handling in ('co', 'client_direct', 'absorb')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists allowances_org_idx on allowances (org_id);
create index if not exists allowances_project_idx on allowances (project_id);
create trigger allowances_set_updated_at before update on allowances for each row execute function public.tg_set_updated_at();

-- Enable RLS
alter table estimate_templates enable row level security;
alter table proposal_lines enable row level security;
alter table retainage enable row level security;
alter table allowances enable row level security;

-- Policies
create policy "estimate_templates_access" on estimate_templates
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "proposal_lines_access" on proposal_lines
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "retainage_access" on retainage
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "allowances_access" on allowances
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));
;
