-- PO generation, review round 3.
--
-- A variance order is history. commitment_change_orders.commitment_id cascades
-- on delete, and a variance order can be raised (and approved) on a purchase
-- order in any status, so a draft generated order can carry one. Regeneration
-- used to count only issue versions, acknowledgments, receipts, shortages,
-- completions and bills, then delete such a draft and take its variance orders
-- with it. An order with any change order, in any status, is now progressed:
-- regeneration keeps it, reports it, and never orders its lines again.
--
-- Supersedes po_generation_order_progressed from
-- 20261015171000_po_generation_round2_fixes; run_po_generation_commit and
-- po_generation_reconcile_report call it and need no redefinition.

set local lock_timeout = '3s';

create or replace function public.po_generation_order_progressed(
  p_org_id uuid,
  p_commitment_id uuid,
  p_status text
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_status not in ('draft', 'canceled')
    or exists (select 1 from public.vendor_bills vb where vb.org_id = p_org_id and vb.commitment_id = p_commitment_id)
    or exists (select 1 from public.commitment_change_orders co where co.commitment_id = p_commitment_id)
    or exists (select 1 from public.po_issue_versions v where v.commitment_id = p_commitment_id)
    or exists (select 1 from public.po_acknowledgments a where a.commitment_id = p_commitment_id)
    or exists (select 1 from public.po_receipts r where r.commitment_id = p_commitment_id)
    or exists (select 1 from public.po_shortages sh where sh.commitment_id = p_commitment_id)
    or exists (select 1 from public.po_completions pc where pc.commitment_id = p_commitment_id);
$$;

revoke all on function public.po_generation_order_progressed(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.po_generation_order_progressed(uuid, uuid, text) to service_role;
