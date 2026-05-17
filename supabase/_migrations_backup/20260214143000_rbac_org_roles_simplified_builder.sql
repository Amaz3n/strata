-- Simplify tenant org roles for builder-focused UX:
-- Keep: org_owner, org_office_admin, org_project_lead, org_viewer
-- Remove: org_admin, org_ops_admin, org_finance_admin, org_member, org_readonly

begin;

insert into public.roles (key, label, scope, description)
values
  ('org_office_admin', 'Office Admin', 'org', 'Administrative control across projects, members, and business operations.'),
  ('org_project_lead', 'Project Lead', 'org', 'Execution-focused role for project delivery, field workflows, and day-to-day coordination.'),
  ('org_viewer', 'Viewer', 'org', 'Read-only visibility role for stakeholders and observers.')
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
      ('org_office_admin', array[
        'org.admin','org.member','org.read','members.manage','billing.manage','audit.read',
        'project.manage','project.read','project.create','project.archive','project.settings.read','project.settings.update',
        'docs.read','docs.upload','docs.download','docs.share','docs.delete',
        'schedule.read','schedule.edit','schedule.publish','schedule.baseline.manage',
        'daily_log.read','daily_log.write','daily_log.approve',
        'rfi.read','rfi.write','rfi.respond','rfi.close',
        'submittal.read','submittal.write','submittal.review','submittal.approve',
        'change_order.read','change_order.write','change_order.approve',
        'commitment.read','commitment.write','commitment.approve',
        'budget.read','budget.write',
        'invoice.read','invoice.write','invoice.approve','invoice.send',
        'bill.read','bill.write','bill.approve',
        'payment.read','payment.release',
        'draw.read','draw.approve',
        'retainage.manage',
        'report.read',
        'portal.access.manage'
      ]::text[]),
      ('org_project_lead', array[
        'org.member','org.read',
        'project.manage','project.read','project.settings.read',
        'docs.read','docs.upload','docs.download','docs.share',
        'schedule.read','schedule.edit','schedule.publish',
        'daily_log.read','daily_log.write',
        'rfi.read','rfi.write','rfi.respond',
        'submittal.read','submittal.write','submittal.review',
        'change_order.read','change_order.write',
        'commitment.read','commitment.write',
        'budget.read',
        'invoice.read','invoice.write',
        'bill.read','bill.write',
        'payment.read',
        'draw.read',
        'report.read',
        'portal.access.manage'
      ]::text[]),
      ('org_viewer', array[
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
      ('org_admin', 'org_office_admin'),
      ('org_finance_admin', 'org_office_admin'),
      ('org_ops_admin', 'org_project_lead'),
      ('org_member', 'org_project_lead'),
      ('org_readonly', 'org_viewer')
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

do $$
begin
  if exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where r.scope = 'org'
      and r.key in ('org_admin','org_ops_admin','org_finance_admin','org_member','org_readonly')
  ) then
    raise exception 'Cannot remove old org roles while memberships still reference them';
  end if;
end
$$;

delete from public.roles
where scope = 'org'
  and key in ('org_admin','org_ops_admin','org_finance_admin','org_member','org_readonly');

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
      and r.key in ('org_owner', 'org_office_admin')
  );
$$;

comment on function public.is_org_admin_member(uuid)
  is 'Returns true when the current auth user has an active org_owner or org_office_admin membership.';

commit;
