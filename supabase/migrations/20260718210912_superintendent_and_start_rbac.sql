-- Workstream 05 phases 1-4: superintendent assignment and starts personas.

alter table public.projects
  add column if not exists superintendent_id uuid references public.app_users(id);
create index if not exists projects_superintendent_idx
  on public.projects (org_id, superintendent_id)
  where superintendent_id is not null;

comment on column public.projects.superintendent_id is
  'Accountable field superintendent. Assignment also adds a field project_members row for assigned-scope authorization.';

insert into public.permissions (key, description) values
  ('start.read', 'View start packages, gates, and the release board'),
  ('start.write', 'Edit start packages and attest gates'),
  ('start.release', 'Give final start approval, waive gates, and release starts'),
  ('start.slots', 'Edit community even-flow release slots')
on conflict (key) do update set description = excluded.description;

insert into public.roles (key, label, scope, description) values
  ('org_starts_coordinator', 'Starts Coordinator', 'org',
   'Owns gate completeness, the even-flow release board, and start releases across communities.'),
  ('org_superintendent', 'Superintendent', 'org',
   'Field lead running assigned production houses, schedules, logs, photos, punch, inspections, and VPO requests.')
on conflict (key) do update set label = excluded.label,
  scope = excluded.scope, description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['start.read']) p(permission_key)
where r.key in (
  'org_owner','org_admin','org_office_admin','org_project_lead','org_user',
  'org_viewer','org_land_manager','org_purchasing_manager','pm','field'
)
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['start.write']) p(permission_key)
where r.key in ('org_owner','org_admin','org_office_admin','org_project_lead','pm')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['start.release','start.slots']) p(permission_key)
where r.key in ('org_owner','org_admin')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'org.member','org.read','project.read','community.read','plan.read','plan.instantiate',
  'start.read','start.write','start.release','start.slots','budget.read','report.read',
  'schedule.read','po.generate','project.manage','lot.write'
]) p(permission_key)
where r.key = 'org_starts_coordinator'
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'org.member','org.read','project.read','community.read','start.read',
  'schedule.read','schedule.edit','daily_log.read','daily_log.write',
  'docs.read','docs.download','docs.upload','drawing.read','punch.read','punch.write',
  'inspection.write','vpo.request'
]) p(permission_key)
where r.key = 'org_superintendent'
on conflict (role_id, permission_key) do nothing;
