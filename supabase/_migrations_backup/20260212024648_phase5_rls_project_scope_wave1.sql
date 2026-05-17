-- RBAC Phase 5 (Wave 1): tighten RLS for project-scoped tables.
-- Goal: keep org boundary checks and add project-membership checks for rows
-- that are bound to a specific project_id, while allowing org_owner/org_admin
-- to retain cross-project operational visibility.

begin;

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
      and r.key in ('owner', 'admin')
  );
$$;

comment on function public.is_org_admin_member(uuid)
  is 'Returns true when the current auth user has an active org owner/admin membership.';

do $$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'tasks',
    'schedule_items',
    'schedule_dependencies',
    'daily_logs',
    'daily_log_entries',
    'photos',
    'punch_items',
    'rfis',
    'submittals',
    'change_orders',
    'commitments',
    'vendor_bills',
    'invoices',
    'payments',
    'conversations'
  ] loop
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;

    policy_name := table_name || '_access';

    execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    execute format(
      $policy$
      create policy %I
      on public.%I
      for all
      using (
        (auth.role() = 'service_role')
        or (
          is_org_member(org_id)
          and (
            project_id is null
            or is_project_member(project_id)
            or is_org_admin_member(org_id)
          )
        )
      )
      with check (
        (auth.role() = 'service_role')
        or (
          is_org_member(org_id)
          and (
            project_id is null
            or is_project_member(project_id)
            or is_org_admin_member(org_id)
          )
        )
      )
      $policy$,
      policy_name,
      table_name
    );
  end loop;
end
$$;

commit;
