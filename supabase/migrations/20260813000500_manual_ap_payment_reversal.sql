-- Manual AP payments had no way back. `record_ap_payment_reversal_atomic`
-- reverses a payment the RAIL made, and is reachable only from a provider
-- webhook; a payment somebody typed in — the wrong amount, the wrong payable,
-- a check that was never actually sent — had no reversal path at all. The
-- status service even tells the user "Reverse the payment first" while offering
-- nothing that can. This is the missing side of the manual payment lifecycle.
--
-- Deliberately the mirror image of `record_manual_ap_payment_atomic`: same lock
-- ordering (payment, then bill), same rollup ownership, same audit row, same
-- idempotency contract.

begin;

create or replace function public.reverse_manual_ap_payment_atomic(
  p_org_id uuid,
  p_payment_id uuid,
  p_actor_id uuid,
  p_amount_cents bigint,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_bill public.vendor_bills%rowtype;
  v_reversal public.payment_reversals%rowtype;
  v_existing public.payment_reversals%rowtype;
  v_reversal_key text;
  v_already_reversed bigint;
  v_amount bigint;
  v_next_paid bigint;
  v_next_status text;
begin
  if nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'Reversal idempotency key is required';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A reason is required to reverse a recorded payment';
  end if;

  v_reversal_key := 'manual-reversal:' || btrim(p_idempotency_key);

  select * into v_existing
  from public.payment_reversals
  where org_id = p_org_id and provider_reversal_id = v_reversal_key
  limit 1;
  if v_existing.id is not null then
    return to_jsonb(v_existing) || jsonb_build_object('duplicate', true);
  end if;

  select * into v_payment
  from public.payments
  where id = p_payment_id and org_id = p_org_id
  for update;
  if v_payment.id is null then raise exception 'Payment not found'; end if;
  if v_payment.bill_id is null then
    raise exception 'Only a payable payment can be reversed here';
  end if;

  -- Rail money reverses through the provider, never by hand: an Arc-side
  -- reversal of a real ACH debit would make Arc disagree with the bank.
  if coalesce(v_payment.provider, 'manual') <> 'manual'
     or coalesce(v_payment.metadata->>'disbursement_id', '') <> '' then
    raise exception 'This payment was made on the payment rail. Reverse it through the rail, not by hand.';
  end if;
  if v_payment.status not in ('succeeded', 'completed') then
    raise exception 'Only a settled payment can be reversed';
  end if;

  select coalesce(sum(amount_cents), 0) into v_already_reversed
  from public.payment_reversals
  where org_id = p_org_id and payment_id = v_payment.id and status in ('pending', 'succeeded');

  v_amount := coalesce(p_amount_cents, v_payment.amount_cents - v_already_reversed);
  if v_amount <= 0 then raise exception 'Reversal amount must be positive'; end if;
  if v_already_reversed + v_amount > v_payment.amount_cents then
    raise exception 'Reversal exceeds the recorded payment';
  end if;

  select * into v_bill
  from public.vendor_bills
  where id = v_payment.bill_id and org_id = p_org_id
  for update;
  if v_bill.id is null then raise exception 'Vendor bill not found'; end if;

  -- A payable claimed by a live run is immutable for exactly the reason that
  -- applies here: its balance is already frozen into approval evidence.
  if exists (
    select 1 from public.payment_run_items item
    where item.org_id = p_org_id and item.bill_id = v_bill.id
      and item.status in ('draft','pending_approval','approved','processing','partially_paid')
  ) then
    raise exception 'This payable belongs to an active payment run. Cancel the run before reversing a payment.';
  end if;

  insert into public.payment_reversals (
    org_id, project_id, bill_id, payment_id, amount_cents, reversal_type,
    status, provider_reversal_id, reason, metadata
  ) values (
    p_org_id, v_payment.project_id, v_payment.bill_id, v_payment.id, v_amount,
    'correction', 'succeeded', v_reversal_key, btrim(p_reason),
    jsonb_build_object('reversed_by', p_actor_id, 'channel', 'manual')
  ) returning * into v_reversal;

  if v_already_reversed + v_amount = v_payment.amount_cents then
    update public.payments set status = 'refunded' where id = v_payment.id and org_id = p_org_id;
  end if;

  v_next_paid := greatest(coalesce(v_bill.paid_cents, 0) - v_amount, 0);
  v_next_status := case when v_next_paid > 0 then 'partial' else 'approved' end;

  update public.vendor_bills
  set paid_cents = v_next_paid,
      status = v_next_status,
      paid_at = null,
      payment_reference = case when v_next_paid = 0 then null else payment_reference end
  where id = v_bill.id and org_id = p_org_id;

  insert into public.audit_log (
    org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source
  ) values (
    p_org_id, p_actor_id, 'update', 'vendor_bill', v_bill.id,
    jsonb_build_object('status', v_bill.status, 'paid_cents', v_bill.paid_cents),
    jsonb_build_object(
      'status', v_next_status,
      'paid_cents', v_next_paid,
      'payment_id', v_payment.id,
      'reversal_id', v_reversal.id,
      'reason', btrim(p_reason)
    ),
    'manual_ap_payment_reversal'
  );

  return to_jsonb(v_reversal) || jsonb_build_object(
    'bill_id', v_bill.id,
    'bill_status', v_next_status,
    'paid_cents', v_next_paid,
    'duplicate', false
  );
end;
$$;

revoke all on function public.reverse_manual_ap_payment_atomic(uuid,uuid,uuid,bigint,text,text)
  from public, anon, authenticated;
grant execute on function public.reverse_manual_ap_payment_atomic(uuid,uuid,uuid,bigint,text,text)
  to service_role;

commit;
