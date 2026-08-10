-- C2.2.4 — collapse the job-cost subledger lifecycle to the states it actually has.
--
-- Applied to the linked Supabase project on 2026-08-07 with explicit human
-- authorization, after re-verifying the preconditions below immediately before
-- running. Both constraints confirmed in pg_constraint afterwards.
--
-- Why this was safe (verified against the linked project on 2026-08-07, 1,345 rows):
--   * rows whose status is not 'posted' or 'voided'  -> 0
--   * rows whose source_type is 'manual_adjustment'  -> 0
-- Both constraints are therefore satisfied by every existing row. If that stops
-- being true before this is applied, the ALTER fails loudly rather than
-- silently dropping data — which is the intended behaviour.
--
-- 1. status: 'pending' and 'approved' have never been written by any code path.
--    `upsertJobCostEntry` defaults to 'posted' and the only transition is
--    voiding. Meanwhile `gmp-control.ts` filtered on ["approved","posted"] while
--    all thirteen other readers filtered "posted", so the GMP surface and the
--    budget page were one write away from disagreeing about what counts as cost.
--    The reader is aligned in the same change; this closes the door behind it.
--
-- 2. source_type: 'manual_adjustment' has never been written here either. It is
--    a `billable_costs` concept — a billing-side correction on a cost-plus
--    contract — and the spend behind such an adjustment already posted its own
--    entry through a bill, expense, or time entry. Creating a job-cost row for
--    it would double-count the cost against the budget. `billable_costs`
--    keeps its own 'manual_adjustment' and 'allowance_overage' source types;
--    this migration does not touch that table.

begin;

alter table public.job_cost_entries
  drop constraint if exists job_cost_entries_status_check;

alter table public.job_cost_entries
  add constraint job_cost_entries_status_check
    check (status in ('posted', 'voided'));

alter table public.job_cost_entries
  drop constraint if exists job_cost_entries_source_type_check;

alter table public.job_cost_entries
  add constraint job_cost_entries_source_type_check check (source_type in (
    'vendor_bill_line',
    'project_expense',
    'project_expense_line',
    'time_entry'
  ));

commit;
