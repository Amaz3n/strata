-- Workstream 02: permission keys for owner-side SOV progress billing.
-- Extends the RBAC catalog seed (20260708120500_rbac_catalog_seed.sql is the
-- source of truth; keep its desired-state list in sync if it is ever re-run).

insert into public.permissions (key, description) values
  ('sov.write', 'Edit the prime-contract schedule of values'),
  ('payapp.write', 'Create, submit, and void owner pay applications')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, perm from public.roles, unnest(array['sov.write', 'payapp.write']) as perm
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_bookkeeper', 'pm')
on conflict (role_id, permission_key) do nothing;
