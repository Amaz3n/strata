-- Punch create/edit/assign now authorizes `punch.write` on the item's project
-- (lib/services/punch-lists.ts); before, the workbench actions checked only org
-- membership. The roles that run a job in the field held every neighbouring
-- field permission but never the punch keys, so enforcing the key would have
-- locked them out of a list they work every day. Grant read + write to the
-- owner (also covered by 20261009010000_owner_holds_admin_permissions once
-- applied), the project lead, the project manager, and the project-level field
-- role. `punch.close` stays where it is: closing is gated on evidence, not on a
-- separate key.

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['punch.read', 'punch.write']) p(permission_key)
where r.key in ('org_owner', 'org_project_lead', 'pm', 'field')
on conflict do nothing;
