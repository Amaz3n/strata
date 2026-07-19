-- Workstream 09: production onboarding state and generic staged-import evidence.

create table public.onboarding_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null default 'production' check (kind in ('production')),
  status text not null default 'active' check (status in ('active','live','abandoned')),
  stages jsonb not null default '{}'::jsonb check (jsonb_typeof(stages) = 'object'),
  pilot_community_id uuid references public.communities(id) on delete set null,
  pilot_division_id uuid references public.divisions(id) on delete set null,
  target_live_date date,
  notes text,
  readiness_audit jsonb not null default '[]'::jsonb check (jsonb_typeof(readiness_audit) = 'array'),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index onboarding_runs_one_active_idx
  on public.onboarding_runs (org_id) where status = 'active';
create index onboarding_runs_org_status_idx
  on public.onboarding_runs (org_id, status, created_at desc);
create index onboarding_runs_pilot_community_idx
  on public.onboarding_runs (pilot_community_id) where pilot_community_id is not null;
create index onboarding_runs_pilot_division_idx
  on public.onboarding_runs (pilot_division_id) where pilot_division_id is not null;

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  importer text not null check (importer in (
    'cost_codes','plan_library','option_catalog','price_book',
    'communities_lots','open_wip','team'
  )),
  status text not null default 'parsing'
    check (status in ('parsing','staged','committing','committed','failed','discarded')),
  source_file_id uuid references public.files(id) on delete set null,
  source_filename text,
  column_mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(column_mapping) = 'object'),
  row_count integer not null default 0 check (row_count between 0 and 10000),
  valid_count integer not null default 0 check (valid_count >= 0),
  warning_count integer not null default 0 check (warning_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  committed_count integer not null default 0 check (committed_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  report jsonb not null default '{}'::jsonb check (jsonb_typeof(report) = 'object'),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  update_existing boolean not null default false,
  onboarding_run_id uuid references public.onboarding_runs(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index import_batches_org_status_idx
  on public.import_batches (org_id, importer, status, created_at desc);
create index import_batches_onboarding_run_idx
  on public.import_batches (onboarding_run_id, importer, created_at desc)
  where onboarding_run_id is not null;
create index import_batches_source_file_idx
  on public.import_batches (source_file_id) where source_file_id is not null;

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  raw jsonb not null check (jsonb_typeof(raw) = 'object'),
  parsed jsonb not null default '{}'::jsonb check (jsonb_typeof(parsed) = 'object'),
  status text not null default 'pending'
    check (status in ('pending','valid','warning','error','committed','skipped')),
  issues jsonb not null default '[]'::jsonb check (jsonb_typeof(issues) = 'array'),
  natural_key text not null,
  target_entity_type text,
  target_entity_id uuid,
  action text check (action in ('created','updated','skipped_existing','skipped_error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, row_number)
);

create index import_rows_batch_status_idx
  on public.import_rows (batch_id, status, row_number);
create index import_rows_org_natural_key_idx
  on public.import_rows (org_id, batch_id, natural_key);

create table public.import_mapping_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  importer text not null check (importer in (
    'cost_codes','plan_library','option_catalog','price_book',
    'communities_lots','open_wip','team'
  )),
  source_signature text not null,
  column_mapping jsonb not null check (jsonb_typeof(column_mapping) = 'object'),
  created_by uuid references public.app_users(id) on delete set null,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, importer, source_signature)
);

create index import_mapping_profiles_org_idx
  on public.import_mapping_profiles (org_id, importer, last_used_at desc);

drop trigger if exists onboarding_runs_set_updated_at on public.onboarding_runs;
create trigger onboarding_runs_set_updated_at before update on public.onboarding_runs
  for each row execute function public.tg_set_updated_at();
drop trigger if exists import_batches_set_updated_at on public.import_batches;
create trigger import_batches_set_updated_at before update on public.import_batches
  for each row execute function public.tg_set_updated_at();
drop trigger if exists import_rows_set_updated_at on public.import_rows;
create trigger import_rows_set_updated_at before update on public.import_rows
  for each row execute function public.tg_set_updated_at();
drop trigger if exists import_mapping_profiles_set_updated_at on public.import_mapping_profiles;
create trigger import_mapping_profiles_set_updated_at before update on public.import_mapping_profiles
  for each row execute function public.tg_set_updated_at();

alter table public.onboarding_runs enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
alter table public.import_mapping_profiles enable row level security;

create policy onboarding_runs_org_access on public.onboarding_runs
  for all to authenticated
  using (public.has_org_permission(org_id, 'import.manage'))
  with check (public.has_org_permission(org_id, 'import.manage'));
create policy import_batches_org_access on public.import_batches
  for all to authenticated
  using (public.has_org_permission(org_id, 'import.manage'))
  with check (public.has_org_permission(org_id, 'import.manage'));
create policy import_rows_org_access on public.import_rows
  for all to authenticated
  using (public.has_org_permission(org_id, 'import.manage'))
  with check (public.has_org_permission(org_id, 'import.manage'));
create policy import_mapping_profiles_org_access on public.import_mapping_profiles
  for all to authenticated
  using (public.has_org_permission(org_id, 'import.manage'))
  with check (public.has_org_permission(org_id, 'import.manage'));

-- Sample plan versions are intentionally removable by the guarded platform reset.
-- Normal released/superseded versions retain their immutability guarantees.
create or replace function public.tg_house_plan_version_immutable()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or exists (
      select 1 from public.house_plans p
      where p.id = old.house_plan_id and p.org_id = old.org_id
        and p.metadata @> '{"is_sample":true}'::jsonb
    ) then return old; end if;
    raise exception 'Released or superseded plan versions are immutable';
  end if;
  if old.status = 'draft' then return new; end if;
  if old.status = 'released'
     and new.status = 'superseded'
     and (to_jsonb(new) - 'status' - 'updated_at') = (to_jsonb(old) - 'status' - 'updated_at') then
    return new;
  end if;
  raise exception 'Released or superseded plan versions are immutable';
end;
$$;

create or replace function public.tg_house_plan_version_children_immutable()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare version_id uuid; version_status text; sample_plan boolean;
begin
  if tg_op = 'DELETE' then version_id := old.house_plan_version_id; else version_id := new.house_plan_version_id; end if;
  select v.status, coalesce(p.metadata @> '{"is_sample":true}'::jsonb, false)
    into version_status, sample_plan
  from public.house_plan_versions v join public.house_plans p on p.id = v.house_plan_id
  where v.id = version_id;
  if tg_op = 'DELETE' and sample_plan then return old; end if;
  if version_status is distinct from 'draft' then raise exception 'Released or superseded plan version contents are immutable'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

grant select, insert, update, delete on table
  public.onboarding_runs,
  public.import_batches,
  public.import_rows,
  public.import_mapping_profiles
to authenticated, service_role;

comment on table public.onboarding_runs is
  'Code-catalog-driven production-builder onboarding checklist and auditable go-live evidence.';
comment on table public.import_batches is
  'Dry-run and commit state for bounded, idempotent onboarding CSV imports.';
comment on table public.import_rows is
  'Disposable-but-retained staged import rows, validation issues, and target lineage.';
