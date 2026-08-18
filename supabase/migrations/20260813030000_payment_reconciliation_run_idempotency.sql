-- One payment reconciliation run per organization per period, and one exception
-- item per provider reference within a run.
--
-- PENDING — NOT APPLIED. Written by an agent; needs human review and approval
-- before it is run against the linked project.
--
-- Why this is safe (verified read-only against the linked project on 2026-08-13):
--   * payment_reconciliation_runs rows                              -> 0
--   * (org_id, period_start, period_end) groups appearing more than once -> 0
--   * payment_reconciliation_items rows                             -> 0
--   * items with a null provider_reference                          -> 0
--   * (reconciliation_run_id, provider_reference) duplicates        -> 0
-- Nothing needs deduplicating first.
--
-- The accounting spine already carries exactly this guard
-- (20260807190000_reconciliation_run_daily_idempotency) and its comment explains
-- the general reason: the application reuses an existing run for the period, but
-- that is a read-then-write and two concurrent invocations interleave. Payments
-- never got the matching index, so a re-invoked cron — or a preparer clicking
-- "Reconcile last 24 hours" while the cron is mid-sweep — inserted a second run
-- for the same closed period and then produced a second full set of exception
-- items. Two runs for one period also make the queue lie: the same discrepancy
-- appears twice and resolving one leaves the other open.
--
-- `nulls not distinct` on both indexes is deliberate. `org_id` is nullable on the
-- runs table and `provider_reference` on the items table, and a null on either
-- side of a default unique index defeats the guard silently — which is the same
-- class of failure the index exists to close.

begin;

create unique index if not exists payment_reconciliation_runs_org_period_unique
  on public.payment_reconciliation_runs (org_id, period_start, period_end)
  nulls not distinct;

create unique index if not exists payment_reconciliation_items_run_reference_unique
  on public.payment_reconciliation_items (reconciliation_run_id, provider_reference)
  nulls not distinct;

comment on index public.payment_reconciliation_runs_org_period_unique is
  'One reconciliation run per organization per closed period. The application also reuses an existing run, but that is a read-then-write; this index is what makes a racing cron and a manual reconcile safe.';

comment on index public.payment_reconciliation_items_run_reference_unique is
  'One exception item per provider reference within a run, so re-deriving a period is idempotent instead of duplicating every finding.';

commit;
