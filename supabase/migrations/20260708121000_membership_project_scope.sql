-- Project-scope toggle for org memberships.
-- 'all'      -> member's org role applies across every project (current behavior).
-- 'assigned' -> member only reaches projects they are an explicit project_member of,
--               even if their org role grants project.read/project.manage.
-- Additive with a safe default, so existing members are unaffected.

-- Fail fast rather than queue behind a long-running txn on this hot table.
set local lock_timeout = '3s';

alter table public.memberships
  add column if not exists project_scope text not null default 'all';

alter table public.memberships
  drop constraint if exists memberships_project_scope_check;

alter table public.memberships
  add constraint memberships_project_scope_check
  check (project_scope in ('all', 'assigned'));

comment on column public.memberships.project_scope is
  'Project visibility scope: all = every project, assigned = only explicit project_members rows. Ignored for org.admin/platform access.';
