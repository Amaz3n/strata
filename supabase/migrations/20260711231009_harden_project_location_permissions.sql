-- Wave 2 follow-up: preserve unrestricted org reads while requiring the
-- project.manage permission for every direct Data API mutation.
create policy project_locations_insert_permission
  on public.project_locations
  as restrictive
  for insert
  to authenticated
  with check (public.has_org_permission(org_id, 'project.manage'));

create policy project_locations_update_permission
  on public.project_locations
  as restrictive
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'project.manage'))
  with check (public.has_org_permission(org_id, 'project.manage'));

create policy project_locations_delete_permission
  on public.project_locations
  as restrictive
  for delete
  to authenticated
  using (public.has_org_permission(org_id, 'project.manage'));

create unique index project_locations_id_org_project_uidx
  on public.project_locations (id, org_id, project_id);

alter table public.project_locations
  add constraint project_locations_id_org_project_key
  unique using index project_locations_id_org_project_uidx;

alter table public.project_locations
  add constraint project_locations_parent_identity_fkey
  foreign key (parent_id, org_id, project_id)
  references public.project_locations (id, org_id, project_id)
  not valid;

alter table public.punch_items
  add constraint punch_items_location_identity_fkey
  foreign key (location_id, org_id, project_id)
  references public.project_locations (id, org_id, project_id)
  not valid;

alter table public.inspections
  add constraint inspections_location_identity_fkey
  foreign key (location_id, org_id, project_id)
  references public.project_locations (id, org_id, project_id)
  not valid;

alter table public.observations
  add constraint observations_location_identity_fkey
  foreign key (location_id, org_id, project_id)
  references public.project_locations (id, org_id, project_id)
  not valid;

alter table public.safety_incidents
  add constraint safety_incidents_location_identity_fkey
  foreign key (location_id, org_id, project_id)
  references public.project_locations (id, org_id, project_id)
  not valid;

alter table public.daily_log_entries
  add constraint daily_log_entries_location_identity_fkey
  foreign key (location_id, org_id, project_id)
  references public.project_locations (id, org_id, project_id)
  not valid;

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
  if not public.has_org_permission(p_org_id, 'project.manage') then
    raise exception 'Insufficient permission';
  end if;

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
    left join public.project_locations parent
      on parent.id = location.parent_id
      and parent.org_id = location.org_id
      and parent.project_id = location.project_id
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
  where location.id = paths.id
    and location.org_id = p_org_id
    and location.project_id = p_project_id;
end;
$$;
