-- AP fees become an accrual, not a component of the payment debit.
--
-- The ACH debit now equals exactly what the vendor receives, so the QuickBooks
-- BillPayment matches the bank feed line with no remainder. Arc pays the
-- processor out of its own balance and invoices the builder monthly for the
-- pass-through plus any platform fee.
--
-- That needs a liability account the old chart did not have. None of the
-- existing codes says "the builder owes Arc": `platform_fee_receivable` is the
-- same balance from Arc's side and crediting it to record a builder liability
-- would be inverted, and `suspense` is the unallocated bucket this work is
-- explicitly trying to stop using as an answer.

alter table public.payment_ledger_entries
  drop constraint if exists payment_ledger_entries_account_code_check;

alter table public.payment_ledger_entries
  add constraint payment_ledger_entries_account_code_check
  check (account_code = any (array[
    'org_cash',
    'vendor_payable',
    'ach_clearing',
    'payout_clearing',
    'processor_fee_expense',
    'platform_fee_expense',
    'platform_fee_receivable',
    -- Fees recognised against a payment and invoiced to the builder later.
    -- Cleared when the monthly Arc invoice is paid, never by a payment run.
    'arc_fees_payable',
    'return_receivable',
    'suspense'
  ]));

-- The processor pass-through is a distinct billable from Arc's own platform fee:
-- one is a cost Arc recovers at cost, the other is margin. They are invoiced on
-- the same statement but must be reportable apart, so they are separate kinds
-- rather than one summed row.
alter table public.platform_fee_events
  drop constraint if exists platform_fee_events_kind_check;

alter table public.platform_fee_events
  add constraint platform_fee_events_kind_check
  check (kind = any (array[
    'ar_ach',
    'ar_card',
    'ap_disbursement',
    'ap_processor_passthrough',
    'card_interchange',
    'early_pay_spread'
  ]));

comment on constraint payment_ledger_entries_account_code_check on public.payment_ledger_entries is
  'Chart of accounts for the AP payment subledger. arc_fees_payable carries fees recognised against a payment and billed on the monthly Arc invoice.';
