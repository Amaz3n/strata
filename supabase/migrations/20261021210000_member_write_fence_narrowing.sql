-- Member write fences, review round (EP14 fix round).
--
-- 1. commitment_lines had no fence. A superintendent seated on a home, without
--    commitment.write, could change or add lines on a draft purchase order, and approval
--    re-totals the order from its lines. Line writes now take commitment.write on the
--    parent order's home, exactly as the order itself does (20261021200000).
-- 2. communities admitted lot.write. Every authenticated-client writer of a community
--    (communities.ts, permit authority) holds community.write; the lot importer writes with
--    the service client. A starts coordinator (lot.write only) could rename or close one.
-- 3. lots admitted plan.release and closing.manage, and a policy cannot limit which
--    columns change, so those holders could change any column (premium, cost basis, lot
--    number). The two writers that needed them now write with the service client after
--    their own permission check: recordPlanOfferingOverride (plan.release, metadata only)
--    and the close-lot step of closing completion (closing.manage, status only, still
--    guarded by tg_lots_member_write_guard). The lot fence is lot.write | community.write.
-- 4. Reads: commitments and their lines were readable only to the home's team and org
--    admins, so a purchasing manager (org-level commitment.read) saw no order on a home
--    they were not seated on, contrary to the EP08 rule that purchasing works every home
--    in its divisions. Org-level commitment.read now reads; the RESTRICTIVE
--    division_scope policies still bound it to the member's divisions. Writes are
--    unchanged: services write orders with the service client after their checks.
-- Lock risk: CREATE/DROP POLICY takes a brief ACCESS EXCLUSIVE lock per table; no rewrite, no scan.

-- 1. commitment_lines write fence ---------------------------------------------
create policy commitment_lines_member_write_insert on public.commitment_lines as restrictive for insert to authenticated
  with check (exists (
    select 1 from public.commitments c
    where c.id = commitment_lines.commitment_id and c.org_id = commitment_lines.org_id
      and arc_private.member_holds_project_permission(c.org_id, c.project_id, 'commitment.write')
  ));
create policy commitment_lines_member_write_update on public.commitment_lines as restrictive for update to authenticated
  using (exists (
    select 1 from public.commitments c
    where c.id = commitment_lines.commitment_id and c.org_id = commitment_lines.org_id
      and arc_private.member_holds_project_permission(c.org_id, c.project_id, 'commitment.write')
  ))
  with check (exists (
    select 1 from public.commitments c
    where c.id = commitment_lines.commitment_id and c.org_id = commitment_lines.org_id
      and arc_private.member_holds_project_permission(c.org_id, c.project_id, 'commitment.write')
  ));
create policy commitment_lines_member_write_delete on public.commitment_lines as restrictive for delete to authenticated
  using (exists (
    select 1 from public.commitments c
    where c.id = commitment_lines.commitment_id and c.org_id = commitment_lines.org_id
      and arc_private.member_holds_project_permission(c.org_id, c.project_id, 'commitment.write')
  ));

-- 2. communities: community.write only -----------------------------------------
drop policy communities_member_write_insert on public.communities;
drop policy communities_member_write_update on public.communities;
create policy communities_member_write_insert on public.communities as restrictive for insert to authenticated
  with check (public.has_org_permission(org_id, 'community.write'));
create policy communities_member_write_update on public.communities as restrictive for update to authenticated
  using (public.has_org_permission(org_id, 'community.write'))
  with check (public.has_org_permission(org_id, 'community.write'));

-- 3. lots: lot.write | community.write -----------------------------------------
drop policy lots_member_write_update on public.lots;
create policy lots_member_write_update on public.lots as restrictive for update to authenticated
  using (public.has_org_permission(org_id, 'lot.write') or public.has_org_permission(org_id, 'community.write'))
  with check (public.has_org_permission(org_id, 'lot.write') or public.has_org_permission(org_id, 'community.write'));

-- 4. org-level commitment readers -----------------------------------------------
create policy commitments_org_reader_select on public.commitments for select to authenticated
  using (public.has_org_permission(org_id, 'commitment.read'));
create policy commitment_lines_org_reader_select on public.commitment_lines for select to authenticated
  using (public.has_org_permission(org_id, 'commitment.read'));
