-- Workstream 02 phase 1: neutral relational budget templates.

create table public.budget_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  division_id uuid references public.divisions(id),
  name text not null check (length(btrim(name)) > 0),
  description text,
  property_type text,
  is_active boolean not null default true,
  created_by uuid references public.app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.budget_template_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  budget_template_id uuid not null references public.budget_templates(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id),
  cost_type public.cost_type,
  description text not null check (length(btrim(description)) > 0),
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  quantity numeric check (quantity is null or quantity >= 0),
  uom text,
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  constraint budget_template_line_basis check (
    amount_cents is not null or (quantity is not null and unit_cost_cents is not null)
  ),
  constraint budget_template_line_uom check (
    uom is null or length(btrim(uom)) > 0
  )
);

create index budget_templates_org_idx
  on public.budget_templates (org_id, is_active, name);
create index budget_templates_division_idx
  on public.budget_templates (org_id, division_id) where division_id is not null;
create index budget_template_lines_template_idx
  on public.budget_template_lines (org_id, budget_template_id, sort_order);
create index budget_template_lines_cost_code_idx
  on public.budget_template_lines (cost_code_id) where cost_code_id is not null;

create trigger budget_templates_set_updated_at
  before update on public.budget_templates
  for each row execute function public.tg_set_updated_at();

alter table public.budget_templates enable row level security;
alter table public.budget_template_lines enable row level security;

create policy budget_templates_org_access on public.budget_templates
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
create policy budget_template_lines_org_access on public.budget_template_lines
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

grant select, insert, update, delete on public.budget_templates,
  public.budget_template_lines to authenticated;
grant all on public.budget_templates, public.budget_template_lines to service_role;
