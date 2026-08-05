-- Payout hold, return-loss allocation, and vendor-level exposure controls.
--
-- Arc used Stripe destination charges, where the transfer to the vendor fires
-- automatically the moment the builder's ACH debit clears. That gave Arc no
-- control over the one decision that matters for return risk: when the money
-- becomes unrecoverable. An ACH debit can still be returned after it "succeeds",
-- and once the vendor has been paid out there is nothing to claw back.
--
-- Separate charges and transfers put that decision in Arc's hands. The debit
-- clears to the platform balance, sits for a configurable hold, and only then
-- becomes a transfer. A return inside the hold costs nothing: no transfer was
-- ever created.

-- When the vendor transfer may be created. Null until the debit clears, which is
-- also what distinguishes "cleared and held" from "cleared and released" without
-- adding a state to a machine that already models the shape correctly — the hold
-- is a schedule, exactly like a run's `scheduled_for`.
alter table public.disbursements
  add column if not exists transfer_release_after timestamptz;

comment on column public.disbursements.transfer_release_after is
  'When the vendor transfer may be created. Set when the builder debit clears; the release sweep picks up funds_available rows at or past this time.';

-- The sweep asks one question: which cleared disbursements are due to transfer.
create index if not exists disbursements_transfer_release_idx
  on public.disbursements (transfer_release_after)
  where status = 'funds_available' and transfer_release_after is not null;

alter table public.payment_rail_policies
  -- Business hours the cleared funds are held before the vendor transfer. Zero
  -- reproduces the old behaviour and is deliberately expressible: an org that
  -- accepts the risk for speed should be able to choose it explicitly rather
  -- than have Arc's default silently decide for them.
  add column if not exists payout_hold_hours integer not null default 48
    check (payout_hold_hours >= 0 and payout_hold_hours <= 720),
  -- Ceiling on debits submitted but not yet cleared. Caps the blast radius of a
  -- compromised session or a runaway integration, which per-payment and daily
  -- limits do not: both reset, in-flight exposure accumulates.
  add column if not exists max_inflight_cents bigint
    check (max_inflight_cents is null or max_inflight_cents > 0),
  -- A newly claimed vendor relationship is the classic vector: change the payee,
  -- pay immediately. Holding the first payment gives the out-of-band
  -- notification time to reach a human who knows the vendor did not change.
  add column if not exists new_vendor_hold_hours integer not null default 72
    check (new_vendor_hold_hours >= 0 and new_vendor_hold_hours <= 720),
  -- Cumulative unrecovered ACH-return loss at which this org's rail trips off.
  -- Null means no automatic ceiling, which is a decision someone should make
  -- deliberately rather than inherit.
  add column if not exists return_loss_ceiling_cents bigint
    check (return_loss_ceiling_cents is null or return_loss_ceiling_cents > 0);

-- Per-vendor ceiling, distinct from the org-wide one. The org limit is sized for
-- a normal run; it does not stop a single compromised vendor destination from
-- taking the whole limit in one payment.
alter table public.vendor_payment_relationships
  add column if not exists per_payment_limit_cents bigint
    check (per_payment_limit_cents is null or per_payment_limit_cents > 0);

-- A named home for unrecovered return loss. `suspense` was carrying it with a
-- comment that admitted the loss was never allocated, which is the same as not
-- knowing what it cost.
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
    'arc_fees_payable',
    'return_receivable',
    -- Money paid to a vendor that the builder's bank pulled back and Arc could
    -- not recover. Arc's loss, recorded as Arc's loss.
    'ach_return_loss',
    'suspense'
  ]));

/**
 * Claim cleared disbursements whose hold has expired.
 *
 * SKIP LOCKED so two overlapping sweeps cannot both create a transfer for the
 * same disbursement — which on this rail would pay a vendor twice.
 */
create or replace function public.claim_matured_vendor_transfers(p_limit integer default 100)
returns table(
  "disbursement_id" uuid,
  "org_id" uuid,
  "amount_cents" bigint,
  "currency" text,
  "provider_charge_id" text,
  "recipient_account_id" uuid,
  "run_id" uuid
)
language plpgsql
set search_path = public
as $$
declare
  v_row record;
begin
  for v_row in
    select d.id, d.org_id, d.amount_cents, d.currency, d.provider_charge_id, d.recipient_account_id, d.run_id
    from public.disbursements d
    where d.status = 'funds_available'
      and d.transfer_release_after is not null
      and d.transfer_release_after <= now()
    order by d.transfer_release_after
    limit p_limit
    for update skip locked
  loop
    disbursement_id := v_row.id;
    org_id := v_row.org_id;
    amount_cents := v_row.amount_cents;
    currency := v_row.currency;
    provider_charge_id := v_row.provider_charge_id;
    recipient_account_id := v_row.recipient_account_id;
    run_id := v_row.run_id;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_matured_vendor_transfers(integer) from public, anon, authenticated;
grant execute on function public.claim_matured_vendor_transfers(integer) to service_role;
