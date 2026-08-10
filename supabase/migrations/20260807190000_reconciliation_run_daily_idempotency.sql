-- C2.3 — one reconciliation run per org per day.
--
-- Applied to the linked Supabase project on 2026-08-07 with explicit human
-- authorization, after re-verifying the preconditions below immediately before
-- running. Index confirmed in pg_indexes afterwards.
--
-- Why this was safe (verified against the linked project on 2026-08-07):
--   * accounting_reconciliation_runs rows                        -> 6
--   * (org_id, run_date) pairs appearing more than once           -> 0
-- The index can therefore be created without deduplicating first.
--
-- The spine diffs today's findings against the previous run to decide what is NEW
-- and worth notifying about. Without a uniqueness guarantee a re-invoked cron
-- inserts a second run for the same day and then diffs against its own twin, so
-- every genuine discrepancy looks like it was already known and no notification
-- is sent. The application also reuses an existing run for the day, but that is a
-- read-then-write and two concurrent cron invocations can still interleave; this
-- index is what actually makes it safe.
--
-- Keyed on (org_id, run_date) rather than (org_id, connection_id, run_date)
-- because the spine is now org-scoped: an org with no external accounting
-- connection still gets a run, and `connection_id` is left null.

begin;

create unique index if not exists accounting_reconciliation_runs_org_day_unique
  on public.accounting_reconciliation_runs (org_id, run_date);

commit;
