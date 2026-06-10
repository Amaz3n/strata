-- Backfill job_cost_entries for approved costs that never posted to the ledger.
--
-- Context: job_cost_entries is the canonical source of "actuals" for the Margin KPI,
-- budget pages, and reports. The only writer is propagateApprovalToLedger(), invoked
-- from the in-app approval flows. The QBO import path inserts vendor_bills and
-- project_expenses directly with status='approved' and never posts to the ledger, so
-- imported costs are invisible to actuals and the Margin KPI renders "—".
--
-- This backfill posts the missing entries, mirroring the posting rules in
-- lib/services/job-cost-actuals.ts exactly to avoid double-counting:
--   * vendor bill lines             -> source_type 'vendor_bill_line'
--   * expenses WITHOUT split lines   -> source_type 'project_expense'
--   * expense split lines            -> source_type 'project_expense_line'
-- It is idempotent via the job_cost_entries_source_unique index
-- (org_id, source_type, source_id) -> ON CONFLICT DO NOTHING. is_billable is set false;
-- the Margin KPI sums actual_cents regardless of the billable split.

-- 1. Vendor bill lines for approved/partial/paid bills.
insert into public.job_cost_entries
  (org_id, project_id, cost_code_id, source_type, source_id, incurred_on, cost_cents, status, is_billable, metadata)
select
  bl.org_id,
  coalesce(bl.project_id, vb.project_id) as project_id,
  bl.cost_code_id,
  'vendor_bill_line' as source_type,
  bl.id as source_id,
  coalesce(vb.bill_date, vb.created_at::date) as incurred_on,
  round(coalesce(bl.unit_cost_cents, 0) * coalesce(bl.quantity, 1))::int as cost_cents,
  'posted' as status,
  false as is_billable,
  jsonb_build_object('source_label', 'vendor_bill_line', 'bill_id', vb.id, 'backfilled', true)
from public.bill_lines bl
join public.vendor_bills vb on vb.id = bl.bill_id and vb.org_id = bl.org_id
where vb.status in ('approved', 'partial', 'paid')
  and coalesce(bl.project_id, vb.project_id) is not null
on conflict (org_id, source_type, source_id) do nothing;

-- 2. Project expenses that have NO split lines (post the whole expense).
insert into public.job_cost_entries
  (org_id, project_id, cost_code_id, source_type, source_id, incurred_on, cost_cents, status, is_billable, metadata)
select
  pe.org_id,
  pe.project_id,
  pe.cost_code_id,
  'project_expense' as source_type,
  pe.id as source_id,
  coalesce(pe.expense_date, pe.created_at::date) as incurred_on,
  (coalesce(pe.amount_cents, 0) + coalesce(pe.tax_cents, 0))::int as cost_cents,
  'posted' as status,
  false as is_billable,
  jsonb_build_object('source_label', 'project_expense', 'backfilled', true)
from public.project_expenses pe
where pe.status in ('approved', 'locked')
  and pe.project_id is not null
  and not exists (
    select 1 from public.project_expense_lines pel
    where pel.expense_id = pe.id and pel.org_id = pe.org_id
  )
on conflict (org_id, source_type, source_id) do nothing;

-- 3. Project expense split lines (post per line; parent expense must be approved/locked).
insert into public.job_cost_entries
  (org_id, project_id, cost_code_id, source_type, source_id, incurred_on, cost_cents, status, is_billable, metadata)
select
  pel.org_id,
  coalesce(pel.project_id, pe.project_id) as project_id,
  pel.cost_code_id,
  'project_expense_line' as source_type,
  pel.id as source_id,
  coalesce(pe.expense_date, pe.created_at::date) as incurred_on,
  coalesce(pel.amount_cents, 0)::int as cost_cents,
  'posted' as status,
  false as is_billable,
  jsonb_build_object('source_label', 'project_expense_line', 'expense_id', pe.id, 'backfilled', true)
from public.project_expense_lines pel
join public.project_expenses pe on pe.id = pel.expense_id and pe.org_id = pel.org_id
where pe.status in ('approved', 'locked')
  and coalesce(pel.project_id, pe.project_id) is not null
on conflict (org_id, source_type, source_id) do nothing;
