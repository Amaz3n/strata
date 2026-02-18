-- RBAC org role cutover:
-- - introduce org_* role keys
-- - map permissions
-- - migrate memberships from legacy org roles
-- - keep legacy roles for backward compatibility, but stop assigning them in-app

begin;

insert into public.roles (key, label, scope, description)
values
  ('org_owner', 'Org Owner', 'org', 'Organization owner with full tenant control'),
  ('org_admin', 'Org Admin', 'org', 'Organization administrator'),
  ('org_ops_admin', 'Org Operations Admin', 'org', 'Operations-focused admin role'),
  ('org_finance_admin', 'Org Finance Admin', 'org', 'Finance and billing administrator'),
  ('org_member', 'Org Member', 'org', 'Standard internal org member'),
  ('org_readonly', 'Org Read-only', 'org', 'Read-only internal org member')
on conflict (key) do update
set label = excluded.label,
    scope = excluded.scope,
    description = excluded.description;

with desired_permissions as (
  select *
  from (
    values
      ('org_owner', array[
        'org.admin','org.member','org.read','members.manage','billing.manage','audit.read','features.manage',
        'project.manage','project.read','project.create','project.archive','project.settings.read','project.settings.update',
        'docs.read','docs.upload','docs.download','docs.share','docs.delete',
        'schedule.read','schedule.edit','schedule.publish','schedule.baseline.manage',
        'daily_log.read','daily_log.write','daily_log.approve',
        'rfi.read','rfi.write','rfi.respond','rfi.close',
        'submittal.read','submittal.write','submittal.review','submittal.approve',
        'change_order.read','change_order.write','change_order.approve',
        'commitment.read','commitment.write','commitment.approve',
        'budget.read','budget.write','budget.lock',
        'invoice.read','invoice.write','invoice.approve','invoice.send',
        'bill.read','bill.write','bill.approve',
        'payment.read','payment.release',
        'draw.read','draw.approve',
        'retainage.manage',
        'report.read',
        'portal.access.manage'
      ]::text[]),
      ('org_admin', array[
        'org.admin','org.member','org.read','members.manage','billing.manage','audit.read','features.manage',
        'project.manage','project.read','project.create','project.archive','project.settings.read','project.settings.update',
        'docs.read','docs.upload','docs.download','docs.share','docs.delete',
        'schedule.read','schedule.edit','schedule.publish','schedule.baseline.manage',
        'daily_log.read','daily_log.write','daily_log.approve',
        'rfi.read','rfi.write','rfi.respond','rfi.close',
        'submittal.read','submittal.write','submittal.review','submittal.approve',
        'change_order.read','change_order.write','change_order.approve',
        'commitment.read','commitment.write','commitment.approve',
        'budget.read','budget.write','budget.lock',
        'invoice.read','invoice.write','invoice.approve','invoice.send',
        'bill.read','bill.write','bill.approve',
        'payment.read','payment.release',
        'draw.read','draw.approve',
        'retainage.manage',
        'report.read',
        'portal.access.manage'
      ]::text[]),
      ('org_ops_admin', array[
        'org.member','org.read','members.manage',
        'project.manage','project.read','project.create','project.archive','project.settings.read','project.settings.update',
        'docs.read','docs.upload','docs.download','docs.share','docs.delete',
        'schedule.read','schedule.edit','schedule.publish','schedule.baseline.manage',
        'daily_log.read','daily_log.write','daily_log.approve',
        'rfi.read','rfi.write','rfi.respond','rfi.close',
        'submittal.read','submittal.write','submittal.review','submittal.approve',
        'change_order.read','change_order.write','change_order.approve',
        'commitment.read','commitment.write','commitment.approve',
        'budget.read','budget.write',
        'invoice.read','invoice.write','invoice.send',
        'bill.read','bill.write','bill.approve',
        'payment.read','payment.release',
        'draw.read','draw.approve',
        'retainage.manage',
        'report.read',
        'portal.access.manage'
      ]::text[]),
      ('org_finance_admin', array[
        'org.member','org.read',
        'billing.manage','audit.read',
        'budget.read','budget.write',
        'invoice.read','invoice.write','invoice.approve','invoice.send',
        'bill.read','bill.write','bill.approve',
        'payment.read','payment.release',
        'commitment.read','commitment.write','commitment.approve',
        'draw.read','draw.approve',
        'retainage.manage',
        'report.read'
      ]::text[]),
      ('org_member', array[
        'org.member','org.read',
        'project.read',
        'docs.read','docs.upload','docs.download',
        'schedule.read','schedule.edit',
        'daily_log.read','daily_log.write',
        'rfi.read','rfi.write','rfi.respond',
        'submittal.read','submittal.write',
        'change_order.read',
        'commitment.read',
        'budget.read',
        'invoice.read',
        'bill.read',
        'payment.read',
        'draw.read',
        'report.read'
      ]::text[]),
      ('org_readonly', array[
        'org.read',
        'project.read',
        'docs.read','docs.download',
        'schedule.read',
        'daily_log.read',
        'rfi.read',
        'submittal.read',
        'change_order.read',
        'commitment.read',
        'budget.read',
        'invoice.read',
        'bill.read',
        'payment.read',
        'draw.read',
        'report.read'
      ]::text[])
  ) as t(role_key, permissions)
),
role_rows as (
  select r.id as role_id, d.permissions
  from desired_permissions d
  join public.roles r on r.key = d.role_key
),
expanded as (
  select role_rows.role_id, unnest(role_rows.permissions) as permission_key
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

with role_mapping as (
  select *
  from (
    values
      ('owner', 'org_owner'),
      ('admin', 'org_admin'),
      ('staff', 'org_member'),
      ('readonly', 'org_readonly')
  ) as m(old_key, new_key)
),
resolved as (
  select old_role.id as old_role_id, new_role.id as new_role_id
  from role_mapping m
  join public.roles old_role on old_role.key = m.old_key and old_role.scope = 'org'
  join public.roles new_role on new_role.key = m.new_key and new_role.scope = 'org'
)
update public.memberships membership
set role_id = resolved.new_role_id
from resolved
where membership.role_id = resolved.old_role_id;

create or replace function public.is_org_admin_member(check_org_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and r.scope = 'org'
      and r.key in ('org_owner', 'org_admin', 'owner', 'admin')
  );
$$;

comment on function public.is_org_admin_member(uuid)
  is 'Returns true when the current auth user has an active org owner/admin membership (legacy and org_* keys).';

update public.roles
set description = coalesce(description, '') || ' [DEPRECATED: use org_* roles]'
where scope = 'org'
  and key in ('owner', 'admin', 'staff', 'readonly')
  and (description is null or description not like '%[DEPRECATED: use org_* roles]%');

commit;
