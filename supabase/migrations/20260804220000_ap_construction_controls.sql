-- Construction AP: recorded-check controls, retainage release, early-pay terms.
--
-- The control model was inverted. Moving $340k by ACH required two designated
-- approvers, a fresh two-factor challenge, a frozen evidence snapshot and a
-- content hash. Recording the same $340k as a check required one person and a
-- free-text reference — and in construction the check payments skew toward
-- HIGHER lien risk, because joint checks exist precisely where exposure is worst.

-- A check number is a real identifier, not a note. Recording the same one twice
-- is the most common AP data error there is, and free text cannot catch it.
alter table public.payments
  add column if not exists check_number text
    check (check_number is null or char_length(btrim(check_number)) between 1 and 40),
  -- The release evidence evaluated when this payment was recorded.
  -- `assertBillReleasable` already ran on this path; its answer was computed and
  -- thrown away, so nothing could show an auditor what was true at the time.
  add column if not exists release_evidence jsonb
    check (release_evidence is null or jsonb_typeof(release_evidence) = 'object');

-- Scoped to the org rather than to a bank account because a manually recorded
-- payment carries no funding-account reference — org scope still catches the
-- error that actually happens, which is the same number keyed twice.
create unique index if not exists payments_check_number_unique_idx
  on public.payments (org_id, lower(btrim(check_number)))
  where check_number is not null and status <> 'canceled';

-- Retainage release.
--
-- `retainage_cents` was subtracted from a bill's payable balance forever, so the
-- only way to pay a subcontractor their held retainage was to edit that number
-- down on the original bill — mutating accounting evidence to achieve a payment.
-- Release now creates its own payable that flows through the normal approval and
-- payment path, and the original bill keeps saying what it always said.
alter table public.vendor_bills
  add column if not exists retainage_released_cents bigint not null default 0
    check (retainage_released_cents >= 0);

comment on column public.vendor_bills.retainage_released_cents is
  'Retainage already released against this bill via a release payable. Guards against releasing the same held amount twice.';

-- Early-pay discount terms. `companies.default_payment_terms` existed but nothing
-- computed a discount date or a discount taken, so builders left the money on the
-- table and lost the most-used scheduling feature in comparable products.
alter table public.vendor_bills
  add column if not exists early_pay_discount_percent numeric(5,3)
    check (early_pay_discount_percent is null or (early_pay_discount_percent > 0 and early_pay_discount_percent <= 100)),
  add column if not exists early_pay_discount_days integer
    check (early_pay_discount_days is null or (early_pay_discount_days > 0 and early_pay_discount_days <= 365)),
  add column if not exists discount_taken_cents bigint not null default 0
    check (discount_taken_cents >= 0);

-- Both halves of a term, or neither. "2/10" with no percent is not a discount.
alter table public.vendor_bills
  drop constraint if exists vendor_bills_discount_terms_complete_check;
alter table public.vendor_bills
  add constraint vendor_bills_discount_terms_complete_check
  check (num_nonnulls(early_pay_discount_percent, early_pay_discount_days) <> 1);

comment on column public.vendor_bills.early_pay_discount_percent is
  'Discount rate for paying within early_pay_discount_days of the bill date, e.g. 2.000 for 2/10 net 30.';

-- The release sweep and the payables desk both ask "which bills still have a
-- live discount window", so the date arithmetic has an index behind it.
create index if not exists vendor_bills_early_pay_discount_idx
  on public.vendor_bills (org_id, bill_date)
  where early_pay_discount_percent is not null and status in ('approved', 'partial');

create index if not exists vendor_bills_retainage_held_idx
  on public.vendor_bills (org_id, company_id)
  where retainage_cents > 0;
