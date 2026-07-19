insert into public.permissions (key, description) values
  ('community.read', 'View communities, phases, lots, and takedowns'),
  ('community.write', 'Create and manage communities, phases, and lot takedowns'),
  ('lot.write', 'Create and edit lots and lot status'),
  ('division.manage', 'Create and manage organization divisions and division scoping')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, 'community.read' from public.roles
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'org_user', 'org_viewer', 'org_estimator', 'pm', 'field')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select id, 'community.write' from public.roles
where key in ('org_owner', 'org_admin', 'org_office_admin')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select id, 'lot.write' from public.roles
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select id, 'division.manage' from public.roles
where key in ('org_owner', 'org_admin')
on conflict (role_id, permission_key) do nothing;

insert into public.roles (key, label, scope, description) values
  ('org_land_manager', 'Land & Community Manager', 'org',
   'Land pipeline and community operations. Manages communities, phases, lots, and takedowns without job-financial access.')
on conflict (key) do update
  set label = excluded.label, scope = excluded.scope, description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, permission_key
from public.roles r
cross join unnest(array[
  'org.member', 'org.read', 'project.read', 'report.read', 'community.read',
  'community.write', 'lot.write', 'directory.read', 'docs.read', 'docs.download'
]) as permission_key
where r.key = 'org_land_manager'
on conflict (role_id, permission_key) do nothing;
