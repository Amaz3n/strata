-- Workstream 02 plan-library permissions. The full catalog seed remains the
-- source of truth; this additive migration makes the workstream independently applyable.

insert into public.permissions (key, description) values
  ('plan.read', 'View house plans, versions, takeoffs, bundles, and availability'),
  ('plan.write', 'Create and edit draft house plans, elevations, takeoffs, and bundles'),
  ('plan.release', 'Release immutable house plan versions'),
  ('plan.instantiate', 'Instantiate a released house plan version onto a lot project')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['plan.read']) p(permission_key)
where r.key in (
  'org_owner','org_admin','org_office_admin','org_project_lead','pm','org_estimator',
  'org_bookkeeper','org_user','org_viewer','org_purchasing_manager','org_starts_coordinator','org_sales_agent'
)
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['plan.write']) p(permission_key)
where r.key in ('org_owner','org_admin','org_office_admin','org_estimator','org_purchasing_manager')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'plan.release'
from public.roles r
where r.key in ('org_owner','org_admin','org_purchasing_manager')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'plan.instantiate'
from public.roles r
where r.key in ('org_owner','org_admin','org_starts_coordinator')
on conflict (role_id, permission_key) do nothing;
