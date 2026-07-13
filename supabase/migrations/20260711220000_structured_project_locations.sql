-- Wave 2 commercial hardening: reusable, hierarchical project locations.

create table public.project_locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  parent_id uuid references public.project_locations(id),
  name text not null check (length(btrim(name)) > 0 and position('>' in name) = 0),
  full_path text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index project_locations_org_project_idx
  on public.project_locations (org_id, project_id, sort_order, name);
create index project_locations_parent_idx
  on public.project_locations (parent_id);

create trigger project_locations_set_updated_at
  before update on public.project_locations
  for each row execute function public.tg_set_updated_at();

alter table public.project_locations enable row level security;
create policy project_locations_org_access on public.project_locations
  for all to authenticated
  using (exists (
    select 1 from public.memberships membership
    where membership.org_id = project_locations.org_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
  ))
  with check (exists (
    select 1 from public.memberships membership
    where membership.org_id = project_locations.org_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
  ));

alter table public.punch_items
  add column location_id uuid references public.project_locations(id);
alter table public.inspections
  add column location_id uuid references public.project_locations(id);
alter table public.observations
  add column location_id uuid references public.project_locations(id);
alter table public.safety_incidents
  add column location_id uuid references public.project_locations(id);
-- Daily-log locations are entry-level in the existing model. The legacy text
-- mirror is daily_log_entries.location, not a column on daily_logs.
alter table public.daily_log_entries
  add column location_id uuid references public.project_locations(id);

create index punch_items_location_idx on public.punch_items (location_id);
create index inspections_location_idx on public.inspections (location_id);
create index observations_location_idx on public.observations (location_id);
create index safety_incidents_location_idx on public.safety_incidents (location_id);
create index daily_log_entries_location_idx on public.daily_log_entries (location_id);

create or replace function public.rename_project_location(
  p_org_id uuid,
  p_project_id uuid,
  p_location_id uuid,
  p_name text
) returns void
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  if btrim(p_name) = '' or position('>' in p_name) > 0 then
    raise exception 'Invalid location name';
  end if;

  if not exists (
    select 1 from public.project_locations
    where id = p_location_id and org_id = p_org_id and project_id = p_project_id
  ) then
    raise exception 'Location not found';
  end if;

  with recursive paths as (
    select location.id,
      btrim(p_name) as next_name,
      case when parent.id is null then btrim(p_name)
        else parent.full_path || ' > ' || btrim(p_name) end as next_path
    from public.project_locations location
    left join public.project_locations parent on parent.id = location.parent_id
    where location.id = p_location_id
      and location.org_id = p_org_id
      and location.project_id = p_project_id
    union all
    select child.id, child.name, paths.next_path || ' > ' || child.name
    from public.project_locations child
    join paths on child.parent_id = paths.id
    where child.org_id = p_org_id and child.project_id = p_project_id
  )
  update public.project_locations location
  set name = paths.next_name, full_path = paths.next_path
  from paths
  where location.id = paths.id;
end;
$$;

grant select, insert, update, delete on table public.project_locations to authenticated;
grant all on table public.project_locations to service_role;
grant execute on function public.rename_project_location(uuid, uuid, uuid, text)
  to authenticated, service_role;
