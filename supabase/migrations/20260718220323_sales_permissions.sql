-- Workstream 06 phases 1-5: sales and closing permission catalog plus the
-- assignable sales-agent persona.

insert into public.permissions (key, description) values
  ('sales.read', 'View sales pipeline, reservations, price sheets, incentives, and closings'),
  ('sales.manage', 'Manage reservations, incentives, purchase agreements, and asking prices'),
  ('closing.manage', 'Schedule, clear, and settle production-home closings')
on conflict (key) do update set description = excluded.description;

insert into public.roles (key, label, scope, description) values
  ('org_sales_agent', 'Sales Agent', 'org',
   'Community sales: inventory, pricing, reservations, and purchase agreements. No job-cost or payables access.')
on conflict (key) do update set label = excluded.label,
  scope = excluded.scope, description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['sales.read']) p(permission_key)
where r.key in (
  'org_owner','org_admin','org_office_admin','org_project_lead','org_viewer','pm'
)
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['sales.manage']) p(permission_key)
where r.key in ('org_owner','org_admin','org_office_admin')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['closing.manage']) p(permission_key)
where r.key in ('org_owner','org_admin','org_office_admin','org_bookkeeper')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'org.member','org.read','project.read','community.read','sales.read','sales.manage',
  'directory.read','docs.read','report.read','plan.read','selections.read'
]) p(permission_key)
where r.key = 'org_sales_agent'
on conflict (role_id, permission_key) do nothing;
