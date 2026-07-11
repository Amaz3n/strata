-- Safety incidents contain private personnel and medical information. Separate
-- read access from ordinary org membership and seed it only to safety-capable roles.
insert into public.permissions (key, description) values
  ('safety.read', 'View safety incidents and investigation details')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, 'safety.read'
from public.roles
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm', 'field')
on conflict (role_id, permission_key) do nothing;

create or replace function public.has_org_permission(check_org_id uuid, check_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    exists (
      select 1
      from public.memberships m
      left join public.role_permissions rp
        on rp.role_id = m.role_id and rp.permission_key = check_permission
      left join public.membership_permission_overrides mpo
        on mpo.membership_id = m.id
       and mpo.permission_key = check_permission
       and mpo.effect = 'grant'
      where m.org_id = check_org_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
        and (rp.permission_key is not null or mpo.permission_key is not null)
    )
    and not exists (
      select 1
      from public.memberships m
      join public.membership_permission_overrides mpo
        on mpo.membership_id = m.id
       and mpo.permission_key = check_permission
       and mpo.effect = 'deny'
      where m.org_id = check_org_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
    );
$$;

revoke all on function public.has_org_permission(uuid, text) from public, anon;
grant execute on function public.has_org_permission(uuid, text) to authenticated, service_role;

drop policy if exists safety_incidents_org_access on public.safety_incidents;
create policy safety_incidents_read on public.safety_incidents
  for select to authenticated
  using (public.has_org_permission(org_id, 'safety.read'));
create policy safety_incidents_insert on public.safety_incidents
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'safety.write'));
create policy safety_incidents_update on public.safety_incidents
  for update to authenticated
  using (public.has_org_permission(org_id, 'safety.write'))
  with check (public.has_org_permission(org_id, 'safety.write'));
create policy safety_incidents_delete on public.safety_incidents
  for delete to authenticated
  using (public.has_org_permission(org_id, 'safety.write'));
