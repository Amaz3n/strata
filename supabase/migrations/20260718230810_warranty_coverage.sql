-- Workstream 07 Phase 1: configurable warranty programs and immutable
-- per-home coverage snapshots.

create table public.warranty_programs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  description text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index warranty_programs_one_default
  on public.warranty_programs (org_id) where is_default;
create index warranty_programs_org_active_idx
  on public.warranty_programs (org_id, is_active, name);

create table public.warranty_coverage_terms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  program_id uuid not null references public.warranty_programs(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  label text not null,
  duration_months integer not null check (duration_months > 0),
  is_structural boolean not null default false,
  description text,
  sort_order integer not null default 0,
  unique (program_id, key)
);

create index warranty_coverage_terms_org_program_idx
  on public.warranty_coverage_terms (org_id, program_id, sort_order);

create table public.project_warranty_coverage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade unique,
  program_id uuid not null references public.warranty_programs(id),
  effective_date date not null,
  effective_source text not null default 'closing'
    check (effective_source in ('closing','manual')),
  terms_snapshot jsonb not null check (jsonb_typeof(terms_snapshot) = 'array'),
  structural_carrier text,
  structural_policy_number text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index project_warranty_coverage_org_effective_idx
  on public.project_warranty_coverage (org_id, effective_date desc);
create index project_warranty_coverage_program_idx
  on public.project_warranty_coverage (program_id);

drop trigger if exists warranty_programs_set_updated_at on public.warranty_programs;
create trigger warranty_programs_set_updated_at before update on public.warranty_programs
  for each row execute function public.tg_set_updated_at();
drop trigger if exists project_warranty_coverage_set_updated_at on public.project_warranty_coverage;
create trigger project_warranty_coverage_set_updated_at before update on public.project_warranty_coverage
  for each row execute function public.tg_set_updated_at();

alter table public.warranty_programs enable row level security;
alter table public.warranty_coverage_terms enable row level security;
alter table public.project_warranty_coverage enable row level security;

create policy warranty_programs_org_access on public.warranty_programs
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
create policy warranty_coverage_terms_org_access on public.warranty_coverage_terms
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
create policy project_warranty_coverage_org_access on public.project_warranty_coverage
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

grant select, insert, update, delete on table
  public.warranty_programs,
  public.warranty_coverage_terms,
  public.project_warranty_coverage
to authenticated, service_role;

comment on table public.project_warranty_coverage is
  'Immutable-at-enrollment warranty term snapshots for closed homes; program edits never move existing expiry dates.';
