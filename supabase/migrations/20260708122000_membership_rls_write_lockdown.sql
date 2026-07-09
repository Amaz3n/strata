-- P0: lock down writes to memberships / project_members.
--
-- Before: memberships_access / project_members_access were FOR ALL with
--   USING/WITH CHECK (auth.role()='service_role' OR is_org_member(org_id))
-- Because is_org_member() is true for ANY active member, any authenticated user
-- could INSERT/UPDATE/DELETE membership rows directly via PostgREST — self-promote
-- to a higher role, or delete every other member (owner lockout). The app never
-- exposes this, but RLS is the backstop and it was open.
--
-- After: members may still SELECT the roster (needed by the app), but writes
-- require service_role (how the app performs privileged writes) OR the caller's
-- role actually granting members.manage. Permission-based, so it survives role
-- renames and does not depend on the app routing every write through service_role.

-- Permission-aware guard: does the current user hold members.manage in this org?
create or replace function public.can_manage_members(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id = m.role_id
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = 'members.manage'
  );
$$;

alter function public.can_manage_members(uuid) owner to postgres;

-- memberships ---------------------------------------------------------------
drop policy if exists memberships_access on public.memberships;

create policy memberships_select on public.memberships
  for select
  using (auth.role() = 'service_role' or is_org_member(org_id));

create policy memberships_insert on public.memberships
  for insert
  with check (auth.role() = 'service_role' or can_manage_members(org_id));

create policy memberships_update on public.memberships
  for update
  using (auth.role() = 'service_role' or can_manage_members(org_id))
  with check (auth.role() = 'service_role' or can_manage_members(org_id));

create policy memberships_delete on public.memberships
  for delete
  using (auth.role() = 'service_role' or can_manage_members(org_id));

-- project_members -----------------------------------------------------------
drop policy if exists project_members_access on public.project_members;

create policy project_members_select on public.project_members
  for select
  using (auth.role() = 'service_role' or is_org_member(org_id));

create policy project_members_insert on public.project_members
  for insert
  with check (auth.role() = 'service_role' or can_manage_members(org_id));

create policy project_members_update on public.project_members
  for update
  using (auth.role() = 'service_role' or can_manage_members(org_id))
  with check (auth.role() = 'service_role' or can_manage_members(org_id));

create policy project_members_delete on public.project_members
  for delete
  using (auth.role() = 'service_role' or can_manage_members(org_id));
