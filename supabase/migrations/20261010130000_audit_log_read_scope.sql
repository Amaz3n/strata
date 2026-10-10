-- The audit log holds before/after snapshots of every audited record in the org:
-- payroll, vendor bills, budgets, contracts. Reading it is the `audit.read`
-- permission (org owner/admin/office admin by catalog), not org membership.
--
-- Record pages that show a document's own history (budget, invoice, bill,
-- banking) authorize the record first and then read its trail through the
-- service role (`listEntityAuditTrail`), so they do not depend on this policy.
-- A member may still read the rows they wrote themselves.
drop policy if exists audit_log_read on public.audit_log;

create policy audit_log_read on public.audit_log
  for select
  using (
    (select auth.role()) = 'service_role'
    or public.has_org_permission(org_id, 'audit.read')
    or (actor_user_id = (select auth.uid()) and public.is_org_member(org_id))
  );
