-- Workstream 02 phases 2-4: plan catalog, immutable released versions,
-- takeoffs, template bundles, community pricing, and lot plan pinning.

create table public.house_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  division_id uuid references public.divisions(id),
  code text not null check (length(btrim(code)) > 0),
  name text not null check (length(btrim(name)) > 0),
  series text,
  status text not null default 'draft' check (status in ('draft','active','retired')),
  heated_sqft integer check (heated_sqft is null or heated_sqft > 0),
  total_sqft integer check (total_sqft is null or total_sqft > 0),
  beds numeric(3,1) check (beds is null or beds >= 0),
  baths numeric(3,1) check (baths is null or baths >= 0),
  stories numeric(2,1) check (stories is null or stories > 0),
  garage_bays numeric(2,1) check (garage_bays is null or garage_bays >= 0),
  description text,
  cover_file_id uuid references public.files(id),
  created_by uuid references public.app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

create table public.house_plan_elevations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  house_plan_id uuid not null references public.house_plans(id) on delete cascade,
  code text not null check (code ~ '^[A-Z][A-Z0-9]?$'),
  name text,
  swing_applicable boolean not null default true,
  heated_sqft_delta integer not null default 0,
  is_active boolean not null default true,
  cover_file_id uuid references public.files(id),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (house_plan_id, code)
);

create table public.house_plan_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  house_plan_id uuid not null references public.house_plans(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  status text not null default 'draft' check (status in ('draft','released','superseded')),
  label text,
  notes text,
  budget_template_id uuid references public.budget_templates(id),
  schedule_template_id uuid references public.schedule_templates(id),
  drawing_source_file_id uuid references public.files(id),
  bundle_snapshot jsonb,
  released_at timestamptz,
  released_by uuid references public.app_users(id),
  created_by uuid references public.app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (house_plan_id, version_number),
  constraint house_plan_version_release_fields check (
    (status = 'draft' and released_at is null and released_by is null and bundle_snapshot is null)
    or (status in ('released','superseded') and released_at is not null and released_by is not null and bundle_snapshot is not null)
  )
);

create table public.house_plan_version_template_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  house_plan_version_id uuid not null references public.house_plan_versions(id) on delete cascade,
  kind text not null check (kind in ('checklist','selection_category')),
  template_id uuid not null,
  sort_order integer not null default 0,
  unique (house_plan_version_id, kind, template_id)
);

create table public.house_plan_takeoff_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  house_plan_version_id uuid not null references public.house_plan_versions(id) on delete cascade,
  elevation_id uuid references public.house_plan_elevations(id),
  cost_code_id uuid not null references public.cost_codes(id),
  cost_type public.cost_type,
  description text not null check (length(btrim(description)) > 0),
  quantity numeric not null check (quantity >= 0),
  uom text not null check (length(btrim(uom)) > 0),
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.community_plan_availability (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid not null references public.communities(id) on delete cascade,
  house_plan_id uuid not null references public.house_plans(id) on delete cascade,
  elevation_id uuid references public.house_plan_elevations(id),
  is_available boolean not null default true,
  base_price_cents integer not null check (base_price_cents >= 0),
  effective_start date,
  effective_end date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_start is null or effective_end is null or effective_end >= effective_start),
  unique nulls not distinct (community_id, house_plan_id, elevation_id)
);

create index house_plans_org_status_idx on public.house_plans (org_id, status, code);
create index house_plans_division_idx on public.house_plans (org_id, division_id) where division_id is not null;
create index house_plan_elevations_plan_idx on public.house_plan_elevations (org_id, house_plan_id, sort_order);
create index house_plan_versions_plan_idx on public.house_plan_versions (org_id, house_plan_id, version_number desc);
create unique index house_plan_versions_one_released_idx on public.house_plan_versions (house_plan_id)
  where status = 'released';
create index house_plan_version_links_idx on public.house_plan_version_template_links
  (org_id, house_plan_version_id, kind, sort_order);
create index house_plan_takeoff_version_idx on public.house_plan_takeoff_lines
  (org_id, house_plan_version_id, sort_order);
create index house_plan_takeoff_cost_code_idx on public.house_plan_takeoff_lines (cost_code_id);
create index community_plan_availability_org_community_idx on public.community_plan_availability
  (org_id, community_id, is_available);

alter table public.lots
  add column house_plan_id uuid references public.house_plans(id),
  add column house_plan_version_id uuid references public.house_plan_versions(id),
  add column house_plan_elevation_id uuid references public.house_plan_elevations(id);
create index lots_plan_version_idx on public.lots (house_plan_version_id)
  where house_plan_version_id is not null;

alter table public.projects
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create trigger house_plans_set_updated_at before update on public.house_plans
  for each row execute function public.tg_set_updated_at();
create trigger house_plan_elevations_set_updated_at before update on public.house_plan_elevations
  for each row execute function public.tg_set_updated_at();
create trigger house_plan_versions_set_updated_at before update on public.house_plan_versions
  for each row execute function public.tg_set_updated_at();
create trigger house_plan_takeoff_lines_set_updated_at before update on public.house_plan_takeoff_lines
  for each row execute function public.tg_set_updated_at();
create trigger community_plan_availability_set_updated_at before update on public.community_plan_availability
  for each row execute function public.tg_set_updated_at();

create function public.tg_house_plan_version_immutable()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' then
      return old;
    end if;
    raise exception 'Released or superseded plan versions are immutable';
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  if old.status = 'released'
     and new.status = 'superseded'
     and (to_jsonb(new) - 'status' - 'updated_at') = (to_jsonb(old) - 'status' - 'updated_at') then
    return new;
  end if;
  raise exception 'Released or superseded plan versions are immutable';
end;
$$;

create function public.tg_house_plan_version_children_immutable()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare version_id uuid; version_status text;
begin
  if tg_op = 'DELETE' then
    version_id := old.house_plan_version_id;
  else
    version_id := new.house_plan_version_id;
  end if;
  select status into version_status from public.house_plan_versions where id = version_id;
  if version_status is distinct from 'draft' then
    raise exception 'Released or superseded plan version contents are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger house_plan_versions_immutable before update or delete on public.house_plan_versions
  for each row execute function public.tg_house_plan_version_immutable();
create trigger house_plan_takeoff_lines_immutable before insert or update or delete on public.house_plan_takeoff_lines
  for each row execute function public.tg_house_plan_version_children_immutable();
create trigger house_plan_version_links_immutable before insert or update or delete on public.house_plan_version_template_links
  for each row execute function public.tg_house_plan_version_children_immutable();

create function public.release_house_plan_version(
  p_org_id uuid,
  p_version_id uuid,
  p_actor_id uuid,
  p_bundle_snapshot jsonb,
  p_released_at timestamptz default now()
) returns void
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  target_plan_id uuid;
begin
  select house_plan_id into target_plan_id
  from public.house_plan_versions
  where org_id = p_org_id and id = p_version_id and status = 'draft'
  for update;

  if target_plan_id is null then
    raise exception 'Plan version is not a releasable draft';
  end if;
  if p_bundle_snapshot is null then
    raise exception 'Bundle snapshot is required';
  end if;

  perform 1 from public.house_plan_versions
  where org_id = p_org_id and house_plan_id = target_plan_id
  for update;

  update public.house_plan_versions
  set status = 'superseded'
  where org_id = p_org_id and house_plan_id = target_plan_id and status = 'released';

  update public.house_plan_versions
  set status = 'released', bundle_snapshot = p_bundle_snapshot,
      released_at = p_released_at, released_by = p_actor_id
  where org_id = p_org_id and id = p_version_id and status = 'draft';

  if not found then
    raise exception 'Plan version release lost a concurrent update';
  end if;
end;
$$;

alter table public.house_plans enable row level security;
alter table public.house_plan_elevations enable row level security;
alter table public.house_plan_versions enable row level security;
alter table public.house_plan_version_template_links enable row level security;
alter table public.house_plan_takeoff_lines enable row level security;
alter table public.community_plan_availability enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'house_plans','house_plan_elevations','house_plan_versions',
    'house_plan_version_template_links','house_plan_takeoff_lines','community_plan_availability'
  ] loop
    execute format(
      'create policy %I_org_access on public.%I for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))',
      table_name, table_name
    );
  end loop;
end $$;

grant select, insert, update, delete on public.house_plans, public.house_plan_elevations,
  public.house_plan_versions, public.house_plan_version_template_links,
  public.house_plan_takeoff_lines, public.community_plan_availability to authenticated;
grant all on public.house_plans, public.house_plan_elevations, public.house_plan_versions,
  public.house_plan_version_template_links, public.house_plan_takeoff_lines,
  public.community_plan_availability to service_role;
grant execute on function public.release_house_plan_version(uuid, uuid, uuid, jsonb, timestamptz)
  to authenticated, service_role;
