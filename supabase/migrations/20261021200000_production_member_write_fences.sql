-- Production member write fences (EP14-06, found by ROLE-01).
--
-- Straight through the data API, any active member could rename a community, add a
-- lot or change a lot's status (both tables admitted every write on is_org_member), and
-- a superintendent seated on a home could write a purchase order or change an order's
-- header total (commitments admitted every project member). The services refuse all of these;
-- the tables did not. These RESTRICTIVE write policies sit beside the existing
-- permissive and division policies, so they only ever take rights away, and reads are
-- untouched. service_role bypasses RLS, so server writers (starts, purchasing workers,
-- bid awards) are unaffected.
--
-- Key sets as first written (comment corrected in review; the policies below are as applied):
--   communities  community.write | lot.write
--   lots         lot.write | community.write | plan.release | closing.manage
--   commitments  commitment.write on the org role, or on the member's project role on that home
-- This fence did NOT cover commitment_lines, so a seated member without commitment.write could
-- still change an order's lines and so its approved total; lot.write on communities and
-- plan.release/closing.manage on lots were wider than any authenticated-client writer needs.
-- 20261021210000_member_write_fence_narrowing.sql fences commitment_lines and narrows both.
-- Lock risk: CREATE POLICY takes a brief ACCESS EXCLUSIVE lock per table; no rewrite, no scan.

create or replace function arc_private.member_holds_project_permission(p_org_id uuid, p_project_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_org_permission(p_org_id, p_permission)
    or exists (
      select 1
      from public.project_members pm
      join public.role_permissions rp on rp.role_id = pm.role_id and rp.permission_key = p_permission
      where pm.org_id = p_org_id
        and pm.project_id = p_project_id
        and pm.user_id = (select auth.uid())
        and pm.status = 'active'
        and public.is_org_member(p_org_id)
        and not exists (
          select 1 from public.memberships m
          join public.membership_permission_overrides o on o.membership_id = m.id and o.permission_key = p_permission and o.effect = 'deny'
          where m.org_id = p_org_id and m.user_id = (select auth.uid()) and m.status = 'active'
        )
    )
$$;

revoke all on function arc_private.member_holds_project_permission(uuid, uuid, text) from public;
grant execute on function arc_private.member_holds_project_permission(uuid, uuid, text) to authenticated, service_role;

-- communities ----------------------------------------------------------------
create policy communities_member_write_insert on public.communities as restrictive for insert to authenticated
  with check (public.has_org_permission(org_id, 'community.write') or public.has_org_permission(org_id, 'lot.write'));
create policy communities_member_write_update on public.communities as restrictive for update to authenticated
  using (public.has_org_permission(org_id, 'community.write') or public.has_org_permission(org_id, 'lot.write'))
  with check (public.has_org_permission(org_id, 'community.write') or public.has_org_permission(org_id, 'lot.write'));
create policy communities_member_write_delete on public.communities as restrictive for delete to authenticated
  using (public.has_org_permission(org_id, 'community.write'));

-- lots -------------------------------------------------------------------------
create policy lots_member_write_insert on public.lots as restrictive for insert to authenticated
  with check (public.has_org_permission(org_id, 'lot.write') or public.has_org_permission(org_id, 'community.write'));
create policy lots_member_write_update on public.lots as restrictive for update to authenticated
  using (
    public.has_org_permission(org_id, 'lot.write') or public.has_org_permission(org_id, 'community.write')
    or public.has_org_permission(org_id, 'plan.release') or public.has_org_permission(org_id, 'closing.manage')
  )
  with check (
    public.has_org_permission(org_id, 'lot.write') or public.has_org_permission(org_id, 'community.write')
    or public.has_org_permission(org_id, 'plan.release') or public.has_org_permission(org_id, 'closing.manage')
  );
create policy lots_member_write_delete on public.lots as restrictive for delete to authenticated
  using (public.has_org_permission(org_id, 'lot.write'));

-- commitments ------------------------------------------------------------------
create policy commitments_member_write_insert on public.commitments as restrictive for insert to authenticated
  with check (arc_private.member_holds_project_permission(org_id, project_id, 'commitment.write'));
create policy commitments_member_write_update on public.commitments as restrictive for update to authenticated
  using (arc_private.member_holds_project_permission(org_id, project_id, 'commitment.write'))
  with check (arc_private.member_holds_project_permission(org_id, project_id, 'commitment.write'));
create policy commitments_member_write_delete on public.commitments as restrictive for delete to authenticated
  using (arc_private.member_holds_project_permission(org_id, project_id, 'commitment.write'));
