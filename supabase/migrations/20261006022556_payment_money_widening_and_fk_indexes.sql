-- WS-A7 — finish the integer-cents widening, and index the payment FKs the
-- money crons join on.
--
-- Part one: `20260805093000_vendor_bill_total_cents_widening.sql` widened the
-- payables side but stopped one table short of the rows the rail actually
-- writes. Everything upstream of a payment is `bigint` — disbursements,
-- payment_run_items, payment_runs, payment_ledger_entries, rail limits,
-- execution reservations — and `record_ap_payment_atomic`,
-- `record_manual_ap_payment_atomic` and `record_ap_payment_reversal_atomic` all
-- take `bigint` parameters and insert them into `integer` columns. A payment
-- above $21,474,836.47 does not clamp, it raises, and it raises inside the
-- atomic RPC after the provider has already taken the money.
--
-- Commercial GCs run pay applications well past $21M, so this is a live ceiling
-- rather than a theoretical one. Verified narrow in production 2026-09-01:
-- payments (7 columns), payment_reversals, payment_allocations.
--
-- Part two: the performance advisor flags unindexed foreign keys on the tables
-- the five-minute release sweep and the daily reconciliation join. Volume is
-- near zero today, which is exactly why this lands now rather than during a
-- pilot. Only the indexes that do not already exist are created — the
-- disbursements bill / funding source / recipient / provider transfer / provider
-- payout / transfer release / org+status indexes are already in place.

alter table public.payments
  alter column amount_cents type bigint,
  alter column gross_cents type bigint,
  alter column net_cents type bigint,
  alter column fee_cents type bigint,
  alter column platform_fee_cents type bigint,
  alter column processor_fee_cents type bigint,
  alter column application_fee_cents type bigint;

alter table public.payment_reversals
  alter column amount_cents type bigint;

alter table public.payment_allocations
  alter column amount_cents type bigint;

-- Disbursements: the release sweep and reconciliation both walk run -> items ->
-- payees, and every one of those joins is a sequential scan today.
create index if not exists disbursements_run_idx on public.disbursements (run_id);
create index if not exists disbursements_run_item_idx on public.disbursements (run_item_id);
create index if not exists disbursements_run_item_payee_idx on public.disbursements (run_item_payee_id);
-- The existing `(org_id, project_id)` access-path indexes are useful to the
-- application but do not cover the FK: Postgres needs the referenced column at
-- the left edge when it checks a parent DELETE/UPDATE.
create index if not exists disbursements_project_fk_idx on public.disbursements (project_id);

-- Ledger: reversal lookups resolve by the transaction they reverse, and the
-- webhook path resolves a transaction by its provider event.
create index if not exists payment_ledger_transactions_disbursement_idx
  on public.payment_ledger_transactions (disbursement_id);
create index if not exists payment_ledger_transactions_provider_event_idx
  on public.payment_ledger_transactions (provider_event_id);
create index if not exists payment_ledger_transactions_reverses_idx
  on public.payment_ledger_transactions (reverses_transaction_id);

-- Reconciliation items are read back per disbursement when an exception is
-- worked, and per ledger transaction when a break is explained.
create index if not exists payment_reconciliation_items_disbursement_idx
  on public.payment_reconciliation_items (disbursement_id);
create index if not exists payment_reconciliation_items_ledger_transaction_idx
  on public.payment_reconciliation_items (ledger_transaction_id);

-- Allocations and reversals are read from the bill and invoice detail sheets.
create index if not exists payment_allocations_bill_idx on public.payment_allocations (bill_id);
create index if not exists payment_allocations_invoice_idx on public.payment_allocations (invoice_id);
create index if not exists payment_allocations_project_fk_idx on public.payment_allocations (project_id);
-- `payment_reversals_bill_idx` and `payment_reversals_invoice_idx` already
-- exist with `org_id` first. Use distinct names so `if not exists` does not turn
-- these required single-column FK indexes into no-ops.
create index if not exists payment_reversals_bill_fk_idx on public.payment_reversals (bill_id);
create index if not exists payment_reversals_invoice_fk_idx on public.payment_reversals (invoice_id);
create index if not exists payment_reversals_payment_fk_idx on public.payment_reversals (payment_id);
