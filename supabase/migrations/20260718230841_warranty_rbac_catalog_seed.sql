-- Workstream 07: warranty manager persona and explicit permissions.

insert into public.permissions (key, description) values
  ('warranty.manage', 'Manage warranty programs, SLA targets, coverage enrollment, and overrides'),
  ('warranty.backcharge', 'Create, issue, dispute, and resolve warranty backcharges')
on conflict (key) do update set description = excluded.description;

insert into public.roles (key, label, scope, description) values
  ('org_warranty_manager', 'Warranty Manager', 'org',
   'Owns coverage, service dispatch, SLA performance, trade backcharges, and warranty analytics.')
on conflict (key) do update set label = excluded.label,
  scope = excluded.scope, description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['warranty.manage','warranty.backcharge']) p(permission_key)
where r.key in ('org_owner','org_admin','org_office_admin')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'org.member','org.read','project.read','community.read','warranty.read','warranty.write',
  'warranty.manage','warranty.backcharge','bill.read','bill.write','directory.read',
  'docs.read','docs.download','docs.upload','report.read'
]) p(permission_key)
where r.key = 'org_warranty_manager'
  and exists (select 1 from public.permissions permissions where permissions.key = p.permission_key)
on conflict (role_id, permission_key) do nothing;
