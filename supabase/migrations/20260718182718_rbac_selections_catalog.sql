-- Workstream 03 RBAC catalog: selection/catalog permissions and the assignable
-- design-studio coordinator role. Catalog rows are idempotent by key.

begin;

insert into public.permissions (key, description) values
  ('selections.read', 'View project selections'),
  ('selections.write', 'Create, choose, and confirm project selections'),
  ('selections.catalog.manage', 'Manage option catalogs, packages, groups, and pricing'),
  ('selections.cutoff.override', 'Override schedule-derived selection cutoffs'),
  ('design_studio.manage', 'Manage design studio appointments and coordinator desk')
on conflict (key) do update set description = excluded.description;

insert into public.roles (key, label, scope, description) values
  (
    'org_design_studio_coordinator',
    'Design studio coordinator',
    'org',
    'Manages option catalogs, buyer selections, cutoffs, appointments, and selection change orders.'
  )
on conflict (key) do update set
  label = excluded.label,
  scope = excluded.scope,
  description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select roles.id, grants.permission_key
from public.roles
cross join (
  values
    ('selections.read'),
    ('selections.write'),
    ('selections.catalog.manage'),
    ('selections.cutoff.override'),
    ('design_studio.manage'),
    ('org.member'),
    ('org.read'),
    ('project.read'),
    ('community.read'),
    ('change_order.read'),
    ('change_order.write'),
    ('schedule.read'),
    ('financials.margin.read')
) as grants(permission_key)
where roles.key = 'org_design_studio_coordinator'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select roles.id, grants.permission_key
from public.roles
cross join (
  values
    ('selections.read'),
    ('selections.write'),
    ('selections.catalog.manage'),
    ('selections.cutoff.override'),
    ('design_studio.manage')
) as grants(permission_key)
where roles.key in ('org_admin','org_owner','org_office_admin')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select roles.id, grants.permission_key
from public.roles
cross join (
  values ('selections.read'), ('selections.write'), ('design_studio.manage')
) as grants(permission_key)
where roles.key in ('org_project_lead','pm')
on conflict do nothing;

commit;
