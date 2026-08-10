-- Derive a payment run's status from its items after an AP reversal, instead of
-- asserting `partially_failed` unconditionally.
--
-- `record_ap_payment_reversal_atomic` stamped `partially_failed` on the run for
-- every reversal, including the case where every payee in the run came back.
-- A run whose payments all returned is `failed`, and a run where the returned
-- item sits beside items that were paid is `partially_failed`. Reporting the
-- fully-returned case as "partially" understated it in the payables desk, in the
-- Ops queue, and in every notification derived from run status — and the same
-- rollup was already being computed correctly everywhere else (`resolveRunStatus`
-- in lib/payments/payment-domain.ts, mirrored below).
--
-- Only the run-status write at the end of the function changes; the rest is
-- reproduced verbatim so `create or replace` keeps one definition of the whole
-- routine rather than a patch nobody can read.

create or replace function public.record_ap_payment_reversal_atomic(
  p_org_id uuid,
  p_disbursement_id uuid,
  p_amount_cents bigint,
  p_reversal_type text,
  p_provider_reversal_id text,
  p_reason text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_disbursement public.disbursements%rowtype;
  v_payment public.payments%rowtype;
  v_reversal public.payment_reversals%rowtype;
  v_existing public.payment_reversals%rowtype;
  v_reversed bigint;
  v_bill public.vendor_bills%rowtype;
  v_next_paid bigint;
  v_bill_status text;
  v_item_total integer;
  v_item_paid integer;
  v_item_partially_paid integer;
  v_item_unpaid_terminal integer;
  v_run_status text;
begin
  if p_amount_cents <= 0 then raise exception 'Reversal amount must be positive'; end if;
  if p_reversal_type not in ('ach_return','correction') then raise exception 'Unsupported AP reversal type'; end if;
  if p_provider_reversal_id is not null then
    select * into v_existing from public.payment_reversals
    where org_id = p_org_id and provider_reversal_id = p_provider_reversal_id limit 1;
    if v_existing.id is not null then return to_jsonb(v_existing) || jsonb_build_object('duplicate', true); end if;
  end if;

  select * into v_disbursement from public.disbursements
  where id = p_disbursement_id and org_id = p_org_id for update;
  if v_disbursement.id is null then raise exception 'Disbursement not found'; end if;
  select * into v_payment from public.payments
  where org_id = p_org_id and bill_id = v_disbursement.bill_id
    and metadata->>'disbursement_id' = v_disbursement.id::text for update;
  if v_payment.id is null then raise exception 'AP payment not found'; end if;
  select coalesce(sum(amount_cents), 0) into v_reversed from public.payment_reversals
  where org_id = p_org_id and payment_id = v_payment.id and status in ('pending','succeeded');
  if v_reversed + p_amount_cents > v_payment.amount_cents then raise exception 'Reversal exceeds original AP payment'; end if;

  insert into public.payment_reversals (
    org_id, project_id, bill_id, payment_id, amount_cents, reversal_type,
    status, provider_reversal_id, reason, metadata
  ) values (
    p_org_id, v_payment.project_id, v_payment.bill_id, v_payment.id, p_amount_cents,
    p_reversal_type, 'succeeded', p_provider_reversal_id, p_reason, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_reversal;

  if v_reversed + p_amount_cents = v_payment.amount_cents then
    update public.payments set status = 'refunded' where id = v_payment.id and org_id = p_org_id;
  end if;
  select * into v_bill from public.vendor_bills
  where id = v_payment.bill_id and org_id = p_org_id for update;
  v_next_paid := greatest(coalesce(v_bill.paid_cents, 0) - p_amount_cents, 0);
  v_bill_status := case when v_next_paid > 0 then 'partial' else 'approved' end;
  update public.vendor_bills set paid_cents = v_next_paid, status = v_bill_status,
    paid_at = case when v_bill_status = 'paid' then paid_at else null end
  where id = v_bill.id and org_id = p_org_id;
  update public.disbursements set status = 'returned', returned_at = now()
  where id = v_disbursement.id and org_id = p_org_id;
  update public.payment_run_item_payees set status = 'returned'
  where id = v_disbursement.run_item_payee_id and org_id = p_org_id;
  update public.payment_run_items set status = 'returned'
  where id = v_disbursement.run_item_id and org_id = p_org_id;

  -- Roll the run up from its items, exactly as `resolveRunStatus` does.
  select
    count(*)::integer,
    count(*) filter (where status = 'paid')::integer,
    count(*) filter (where status = 'partially_paid')::integer,
    count(*) filter (where status in ('failed','returned','canceled'))::integer
  into v_item_total, v_item_paid, v_item_partially_paid, v_item_unpaid_terminal
  from public.payment_run_items
  where run_id = v_disbursement.run_id and org_id = p_org_id;

  v_run_status := case
    when v_item_total = 0 then 'processing'
    when v_item_paid = v_item_total then 'paid'
    when (v_item_paid + v_item_partially_paid) > 0 and v_item_unpaid_terminal > 0 then 'partially_failed'
    when v_item_unpaid_terminal = v_item_total then 'failed'
    when (v_item_paid + v_item_partially_paid) > 0 then 'partially_paid'
    else 'processing'
  end;

  update public.payment_runs set status = v_run_status
  where id = v_disbursement.run_id and org_id = p_org_id and status <> v_run_status;

  return to_jsonb(v_reversal) || jsonb_build_object('bill_status', v_bill_status, 'run_status', v_run_status, 'duplicate', false);
end;
$$;

revoke all on function public.record_ap_payment_reversal_atomic(uuid,uuid,bigint,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.record_ap_payment_reversal_atomic(uuid,uuid,bigint,text,text,text,jsonb) to service_role;
