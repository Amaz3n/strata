-- Builder-facing RBAC model:
-- - assignable org roles are Admin and User
-- - User access can be customized with per-membership permission grants/denies

begin;

create table if not exists public.membership_permission_overrides (
  membership_id uuid not null references public.memberships(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  effect text not null check (effect in ('grant', 'deny')),
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  primary key (membership_id, permission_key)
);

alter table public.membership_permission_overrides enable row level security;

drop policy if exists membership_permission_overrides_service_role on public.membership_permission_overrides;
create policy membership_permission_overrides_service_role
  on public.membership_permission_overrides
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop trigger if exists membership_permission_overrides_set_updated_at on public.membership_permission_overrides;
create trigger membership_permission_overrides_set_updated_at
  before update on public.membership_permission_overrides
  for each row execute function public.tg_set_updated_at();

insert into public.permissions (key, description)
values
  ('pipeline.read', 'View pipeline and CRM records'),
  ('pipeline.write', 'Create and update pipeline and CRM records'),
  ('directory.read', 'View directory companies and contacts'),
  ('directory.write', 'Create and update directory companies and contacts'),
  ('message.read', 'View internal project and workspace messages'),
  ('message.write', 'Send internal project and workspace messages'),
  ('drawing.read', 'View drawing sets and sheets'),
  ('drawing.upload', 'Upload drawing sets and sheets'),
  ('drawing.markup', 'Create drawing markups and linked field items'),
  ('decision.read', 'View decisions'),
  ('decision.write', 'Create and update decisions'),
  ('punch.read', 'View punch items'),
  ('punch.write', 'Create and update punch items'),
  ('punch.close', 'Close punch items'),
  ('signature.read', 'View signature documents and envelopes'),
  ('signature.send', 'Prepare and send signature requests'),
  ('bid.read', 'View bid packages'),
  ('bid.write', 'Create and manage bid packages'),
  ('proposal.read', 'View proposals'),
  ('proposal.write', 'Create and manage proposals'),
  ('closeout.read', 'View closeout items'),
  ('closeout.write', 'Create and update closeout items'),
  ('warranty.read', 'View warranty items'),
  ('warranty.write', 'Create and update warranty items')
on conflict (key) do update
set description = excluded.description;

insert into public.roles (key, label, scope, description)
values
  ('org_admin', 'Admin', 'org', 'Full company access, including settings, billing, team, all projects, approvals, and financial workflows.'),
  ('org_user', 'User', 'org', 'Internal team member. Access is scoped by project assignments and optional permission overrides.')
on conflict (key) do update
set label = excluded.label,
    scope = excluded.scope,
    description = excluded.description;

with desired_permissions as (
  select *
  from (
    values
      ('org_admin', array[
        'org.admin','org.member','org.read','members.manage','billing.manage','audit.read','features.manage',
        'project.manage','project.read','project.create','project.archive','project.settings.read','project.settings.update',
        'docs.read','docs.upload','docs.download','docs.share','docs.delete',
        'drawing.read','drawing.upload','drawing.markup',
        'schedule.read','schedule.edit','schedule.publish','schedule.baseline.manage',
        'daily_log.read','daily_log.write','daily_log.approve',
        'rfi.read','rfi.write','rfi.respond','rfi.close',
        'submittal.read','submittal.write','submittal.review','submittal.approve',
        'decision.read','decision.write',
        'punch.read','punch.write','punch.close',
        'change_order.read','change_order.write','change_order.approve',
        'commitment.read','commitment.write','commitment.approve',
        'budget.read','budget.write','budget.lock',
        'invoice.read','invoice.write','invoice.approve','invoice.send',
        'bill.read','bill.write','bill.approve',
        'payment.read','payment.release',
        'draw.read','draw.approve',
        'retainage.manage',
        'report.read',
        'pipeline.read','pipeline.write',
        'directory.read','directory.write',
        'message.read','message.write',
        'signature.read','signature.send',
        'bid.read','bid.write',
        'proposal.read','proposal.write',
        'closeout.read','closeout.write',
        'warranty.read','warranty.write',
        'portal.access.manage'
      ]::text[]),
      ('org_user', array[
        'org.member','org.read',
        'docs.read','docs.upload','docs.download',
        'drawing.read','drawing.upload','drawing.markup',
        'schedule.read','schedule.edit',
        'daily_log.read','daily_log.write',
        'rfi.read','rfi.write','rfi.respond',
        'submittal.read','submittal.write',
        'decision.read','decision.write',
        'punch.read','punch.write',
        'directory.read',
        'message.read','message.write',
        'closeout.read','warranty.read'
      ]::text[])
  ) as t(role_key, permissions)
),
role_rows as (
  select r.id as role_id, d.permissions
  from desired_permissions d
  join public.roles r on r.key = d.role_key and r.scope = 'org'
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

delete from public.role_permissions rp
using public.roles r
where rp.role_id = r.id
  and r.scope = 'org'
  and r.key = 'org_user'
  and rp.permission_key in (
    'project.manage','project.read','project.create','project.archive','project.settings.read','project.settings.update',
    'budget.read','budget.write','budget.lock',
    'commitment.read','commitment.write','commitment.approve',
    'invoice.read','invoice.write','invoice.approve','invoice.send',
    'bill.read','bill.write','bill.approve',
    'payment.read','payment.release',
    'draw.read','draw.approve',
    'retainage.manage',
    'report.read',
    'portal.access.manage',
    'pipeline.read','pipeline.write',
    'bid.read','bid.write',
    'proposal.read','proposal.write',
    'signature.read','signature.send'
  );

with role_mapping as (
  select *
  from (
    values
      ('org_owner', 'org_admin'),
      ('org_office_admin', 'org_admin'),
      ('org_project_lead', 'org_user'),
      ('org_viewer', 'org_user'),
      ('org_member', 'org_user'),
      ('org_readonly', 'org_user'),
      ('owner', 'org_admin'),
      ('admin', 'org_admin'),
      ('staff', 'org_user'),
      ('readonly', 'org_user')
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
      and r.key = 'org_admin'
  );
$$;

comment on table public.membership_permission_overrides
  is 'Per-member grant/deny permission overrides layered on top of the member org role.';

commit;
