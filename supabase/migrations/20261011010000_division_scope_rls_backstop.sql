-- Division scope, enforced by the database as well as the application.
--
-- `memberships.division_scope = 'assigned'` limits a member to the projects in
-- their `membership_divisions`, and `memberships.project_scope = 'assigned'`
-- limits them to projects they belong to (`project_members`). Until now only
-- `authorize()` (lib/services/authorization.ts) enforced either; RLS on the core
-- project tables answered "is this an org member", so a restricted member's
-- own JWT read every division through PostgREST.
--
-- This adds ONE restrictive policy per table. Restrictive policies are ANDed
-- with the table's existing permissive ones, so org membership, project
-- membership and admin rules stay exactly as they were. The backstop only ever
-- removes rows. It applies to `authenticated`; the service role bypasses RLS,
-- and platform operators and the token portals run on the service role.
--
-- Semantics mirror authorize():
--   * an org admin (`org.admin` or `*` from the role or a grant override)
--     reaches every project, whatever the membership's scopes say;
--   * division_scope 'assigned' needs the project's division in the
--     membership's divisions -- a project with no division is out of scope;
--   * project_scope 'assigned' needs an active project_members row.
-- The DB reads the admin bit from role permissions OR grant overrides, so it is
-- never narrower than the application: it is a backstop, not a second policy.
--
-- Cost. Every check is shaped to run once per statement, not once per row:
--   * `member_unscoped_org_ids()` is an initplan: the orgs where the caller
--     reaches everything. Every member today is unscoped, so each row costs
--     one array test and nothing else.
--   * `member_reachable_project_ids()` is an uncorrelated IN, which Postgres
--     runs as a hashed subplan built on first use. Only a restricted caller
--     gets that far, and then each row is a hash probe.
--   * projects carry their own division, so their policy asks
--     `member_can_reach_project()` with the row's division: a new or moved
--     project is judged as written, before it is in any set.

set local lock_timeout = '3s';

-- The initplan and the reachable set look memberships up by user, not by org.
create index if not exists memberships_user_active_idx
  on public.memberships (user_id, org_id)
  where status = 'active';

create or replace function public.membership_is_org_admin(check_membership_id uuid, check_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.role_permissions rp
    where rp.role_id = check_role_id and rp.permission_key in ('org.admin', '*')
  ) or exists (
    select 1 from public.membership_permission_overrides o
    where o.membership_id = check_membership_id
      and o.permission_key in ('org.admin', '*')
      and o.effect = 'grant'
  );
$$;

comment on function public.membership_is_org_admin(uuid, uuid) is
  'Whether a membership holds org.admin (or *) from its role or a grant override. Admins are exempt from division and project scope.';

create or replace function public.member_unscoped_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.org_id), '{}'::uuid[])
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (
      (m.division_scope = 'all' and m.project_scope = 'all')
      or public.membership_is_org_admin(m.id, m.role_id)
    );
$$;

comment on function public.member_unscoped_org_ids() is
  'Orgs in which the caller reaches every project (no division or project restriction, or an org admin). Call as (select ...)::uuid[] so it runs once per statement.';

create or replace function public.member_can_reach_project(
  check_org_id uuid,
  check_project_id uuid,
  check_division_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = check_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and (
        public.membership_is_org_admin(m.id, m.role_id)
        or (
          (
            m.division_scope = 'all'
            or exists (
              select 1 from public.membership_divisions md
              where md.membership_id = m.id and md.division_id = check_division_id
            )
          )
          and (
            m.project_scope = 'all'
            or exists (
              select 1 from public.project_members pm
              where pm.project_id = check_project_id
                and pm.user_id = m.user_id
                and pm.org_id = check_org_id
                and pm.status = 'active'
            )
          )
        )
      )
  );
$$;

comment on function public.member_can_reach_project(uuid, uuid, uuid) is
  'Whether the caller''s membership reaches a project in the given division, as authorize() decides division and project scope. The division is passed in so a row being written is judged as written.';

create or replace function public.member_reachable_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.memberships m
  join public.projects p on p.org_id = m.org_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and not public.membership_is_org_admin(m.id, m.role_id)
    and (
      m.division_scope = 'all'
      or p.division_id in (select md.division_id from public.membership_divisions md where md.membership_id = m.id)
    )
    and (
      m.project_scope = 'all'
      or exists (
        select 1 from public.project_members pm
        where pm.project_id = p.id
          and pm.user_id = m.user_id
          and pm.org_id = m.org_id
          and pm.status = 'active'
      )
    );
$$;

comment on function public.member_reachable_project_ids() is
  'Projects a scope-restricted caller reaches, in the orgs where they are restricted. Policies use it as an uncorrelated IN so it is built once per statement.';

revoke all on function public.membership_is_org_admin(uuid, uuid) from public, anon;
revoke all on function public.member_unscoped_org_ids() from public, anon;
revoke all on function public.member_can_reach_project(uuid, uuid, uuid) from public, anon;
revoke all on function public.member_reachable_project_ids() from public, anon;
grant execute on function public.membership_is_org_admin(uuid, uuid) to authenticated, service_role;
grant execute on function public.member_unscoped_org_ids() to authenticated, service_role;
grant execute on function public.member_can_reach_project(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.member_reachable_project_ids() to authenticated, service_role;

-- A restricted member can neither create a project outside their divisions nor
-- move one out of (or into) them.
drop policy if exists projects_division_scope on public.projects;
create policy projects_division_scope on public.projects
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or public.member_can_reach_project(org_id, id, division_id)
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or public.member_can_reach_project(org_id, id, division_id)
  );

-- Project-scoped tables: a row with no project is org-level and unaffected.
do $$
declare
  scoped_table text;
begin
  foreach scoped_table in array array[
    'contracts',
    'budgets',
    'files',
    'photos',
    'invoices',
    'vendor_bills',
    'commitments',
    'change_orders',
    'project_selections',
    'schedule_items'
  ] loop
    execute format('drop policy if exists %I on public.%I', scoped_table || '_division_scope', scoped_table);
    execute format(
      $policy$
        create policy %I on public.%I
          as restrictive
          for all
          to authenticated
          using (
            project_id is null
            or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
            or project_id in (select public.member_reachable_project_ids())
          )
          with check (
            project_id is null
            or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
            or project_id in (select public.member_reachable_project_ids())
          )
      $policy$,
      scoped_table || '_division_scope',
      scoped_table
    );
  end loop;
end
$$;

-- A budget line has no project of its own; it is reachable when its budget is.
drop policy if exists budget_lines_division_scope on public.budget_lines;
create policy budget_lines_division_scope on public.budget_lines
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or budget_id in (
      select b.id from public.budgets b where b.project_id in (select public.member_reachable_project_ids())
    )
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or budget_id in (
      select b.id from public.budgets b where b.project_id in (select public.member_reachable_project_ids())
    )
  );

comment on column public.memberships.division_scope is
  'Division visibility: all = every division, assigned = only membership_divisions rows. Enforced by authorize() and, on projects and the core project tables, by restrictive *_division_scope RLS policies.';
