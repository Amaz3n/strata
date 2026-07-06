insert into public.permissions (key, description)
values
  ('time.read', 'View project time entries'),
  ('time.write', 'Create and edit project time entries')
on conflict (key) do update
set description = excluded.description;

with desired_permissions as (
  select *
  from (
    values
      ('org'::public.role_scope, 'org_admin', array['time.read', 'time.write']::text[]),
      ('org'::public.role_scope, 'org_user', array['time.read', 'time.write']::text[]),
      ('project'::public.role_scope, 'pm', array['time.read', 'time.write']::text[]),
      ('project'::public.role_scope, 'field', array['time.read', 'time.write']::text[])
  ) as t(scope, role_key, permissions)
),
role_rows as (
  select r.id as role_id, d.permissions
  from desired_permissions d
  join public.roles r on r.scope = d.scope and r.key = d.role_key
),
expanded as (
  select role_id, unnest(permissions) as permission_key
  from role_rows
),
valid_expanded as (
  select e.role_id, e.permission_key
  from expanded e
  join public.permissions p on p.key = e.permission_key
)
insert into public.role_permissions (role_id, permission_key)
select role_id, permission_key
from valid_expanded
on conflict do nothing;
