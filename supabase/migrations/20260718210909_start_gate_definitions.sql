-- Workstream 05 phase 1: configurable start-readiness gates.

create table public.start_gate_definitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text not null,
  description text,
  check_kind text not null default 'manual'
    check (check_kind in ('auto','manual')),
  auto_source text check (auto_source is null or auto_source in (
    'selections_locked','budget_generated','pos_generated','plan_pinned',
    'plot_plan_file','po_exceptions_clear'
  )),
  requires_attestation_permission text references public.permissions(key),
  applies_when text not null default 'always'
    check (applies_when in ('always','financed_only','purchasing_enabled')),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key),
  constraint start_gate_definition_kind check (
    (check_kind = 'auto' and auto_source is not null)
    or (check_kind = 'manual' and auto_source is null)
  )
);

create index start_gate_definitions_org_idx
  on public.start_gate_definitions (org_id, is_active, sort_order);

create trigger start_gate_definitions_set_updated_at
  before update on public.start_gate_definitions
  for each row execute function public.tg_set_updated_at();

alter table public.start_gate_definitions enable row level security;
create policy start_gate_definitions_org_access on public.start_gate_definitions
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

grant select, insert, update, delete on public.start_gate_definitions to authenticated;
grant all on public.start_gate_definitions to service_role;
