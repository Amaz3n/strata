-- Workstream 08 / Phase C2: accounting mapping and export permissions.
insert into public.permissions (key, description) values
  ('accounting.entity_map.manage', 'Manage accounting connection routing and dimensions'),
  ('financials.export', 'Export accounting journals, AP, and job-cost data')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['accounting.entity_map.manage','financials.export']) p(permission_key)
where r.key in ('org_owner','org_admin','org_bookkeeper')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'financials.export'
from public.roles r
where r.key = 'org_office_admin'
on conflict (role_id, permission_key) do nothing;
