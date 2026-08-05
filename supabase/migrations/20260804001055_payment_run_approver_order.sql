-- Ordered payment-run approvers.
--
-- The roster names who a submitted run routes to; this column makes that roster
-- a *sequence*. When a run needs two approvers, position 1 is who the org wants
-- prompted first, position 2 the fallback. Nothing about permission changes —
-- every listed, still-permitted approver may still decide — but the order is now
-- the org's stated intent instead of whatever order rows happened to be created in.

alter table public.payment_run_approvers
  add column sort_order integer not null default 0;

-- Existing rosters keep the order they are already displayed in (creation order).
update public.payment_run_approvers as target
set sort_order = ranked.position
from (
  select id, (row_number() over (partition by org_id order by created_at, id) - 1) as position
  from public.payment_run_approvers
) as ranked
where ranked.id = target.id;

create index payment_run_approvers_org_order_idx
  on public.payment_run_approvers (org_id, sort_order);
