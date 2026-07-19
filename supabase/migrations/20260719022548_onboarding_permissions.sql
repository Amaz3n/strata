-- Workstream 09: staged-import administration permission.

insert into public.permissions (key, description) values
  ('import.manage', 'Stage, validate, correct, and commit organization data imports')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'import.manage'
from public.roles r
where r.key in (
  'org_owner','org_admin','org_office_admin',
  'org_land_manager','org_purchasing_manager'
)
on conflict (role_id, permission_key) do nothing;
