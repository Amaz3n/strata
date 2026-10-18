-- EP11 review fixes. The warranty tables were writable by any org member (or any project member) through the
-- data API, which let a member resolve a request, move its SLA dates, forge a visit's completer, switch off
-- the double-booking fence, or set a backcharge's status and amounts without the authority the services
-- check. Members now only READ these tables; every write goes through the warranty services (service role)
-- after their permission and home checks.
--
-- Reads follow the home: a project member, an org admin, or a holder of warranty.manage / warranty.write
-- sees a home's warranty records. The restrictive division_scope policies stay, so a division-limited
-- manager sees only their divisions' homes (the same shape purchasing managers have on homes they are not on).
drop policy if exists warranty_requests_access on public.warranty_requests;
create policy warranty_requests_read on public.warranty_requests for select
  using (public.is_org_member(org_id) and (project_id is null or public.is_project_member(project_id) or public.is_org_admin_member(org_id)
    or public.has_org_permission(org_id, 'warranty.manage') or public.has_org_permission(org_id, 'warranty.write')));

drop policy if exists warranty_service_visits_org_access on public.warranty_service_visits;
create policy warranty_service_visits_read on public.warranty_service_visits for select
  using (public.is_org_member(org_id) and (project_id is null or public.is_project_member(project_id) or public.is_org_admin_member(org_id)
    or public.has_org_permission(org_id, 'warranty.manage') or public.has_org_permission(org_id, 'warranty.write')));

drop policy if exists warranty_backcharges_org_access on public.warranty_backcharges;
create policy warranty_backcharges_read on public.warranty_backcharges for select
  using (public.is_org_member(org_id) and (project_id is null or public.is_project_member(project_id) or public.is_org_admin_member(org_id)
    or public.has_org_permission(org_id, 'warranty.manage') or public.has_org_permission(org_id, 'warranty.backcharge')));
