-- app_users co-worker read access
--
-- The only SELECT policy on app_users (app_users_owner_access) let a user read
-- ONLY their own row (id = auth.uid()). Every place that embeds a co-worker's
-- profile under a user-scoped client — daily logs/comments/mentions, tasks,
-- signatures, file versions, drawing markups, team, etc. (18 call sites) —
-- therefore resolved other users to null and rendered "Unknown author".
--
-- Fix: let an active org member read the profile (name/email/avatar) of anyone
-- who shares one of their orgs. SECURITY DEFINER avoids memberships RLS
-- recursion; matches the is_org_member helper (status = 'active', bare auth.uid
-- inside the definer body).

create or replace function public.shares_org_with_current_user(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from memberships ms
    join memberships mo on mo.org_id = ms.org_id
    where ms.user_id = auth.uid()
      and ms.status = 'active'
      and mo.user_id = target_user_id
  );
$$;

create policy "app_users_coworker_read" on public.app_users
  for select
  using (
    (select auth.role()) = 'service_role'
    or id = (select auth.uid())
    or public.shares_org_with_current_user(id)
  );
