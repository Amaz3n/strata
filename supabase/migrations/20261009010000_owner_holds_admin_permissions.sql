-- An organization's owner holds at least every permission its admins hold. The
-- catalog grew keys granted to org_admin but not org_owner (drawings, warranty,
-- closeout, decisions, time, punch, messages, pipeline, proposals, signatures),
-- so an owner was refused pages an admin could open. Found by the app-wide
-- browser sweep (B15.3); supabase/tests/owner_permissions.test.sql keeps it so.
insert into public.role_permissions (role_id, permission_key)
select owner.id, granted.permission_key
from public.roles owner
cross join (
  select rp.permission_key
  from public.role_permissions rp
  join public.roles admin on admin.id = rp.role_id
  where admin.key = 'org_admin'
) granted
where owner.key = 'org_owner'
on conflict do nothing;
