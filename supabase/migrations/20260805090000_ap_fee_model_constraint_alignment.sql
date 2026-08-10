-- Align the payment-run constraints with per-run fee collection.
--
-- 20260804180000 moved fees off the vendor debit and into one charge per run:
-- each vendor payment now debits exactly the vendor amount, and the run's fees
-- are collected separately. The service and the fee engine were updated
-- (`quoteApDisbursementFee` returns `debitAmountCents = vendorAmountCents`), but
-- the table checks and `create_payment_run_atomic` were left asserting the old
-- identity `total_debit = vendor + processor + platform`.
--
-- The result: with any non-zero fee policy in force — which the same migration
-- installed, at 80bps + 80bps — every run creation raised "Payment run item
-- totals do not match the run totals". No test exercised the RPC, so the break
-- was invisible in CI. This is the follow-up that migration needed.

-- The old identity goes first. It has to: the rows being corrected below still
-- satisfy the constraint being replaced and violate it the moment they are
-- fixed, so updating before dropping fails on the very data it is repairing.
alter table public.payment_runs drop constraint if exists payment_runs_check1;
alter table public.payment_run_items drop constraint if exists payment_run_items_check1;

-- Legacy rows predate per-run fees and still carry the summed figure. Correcting
-- them is not a rewrite of what moved: `executePaymentRun` debits per payee, so
-- the PaymentIntents these runs created were always for the vendor amount, and
-- no `payment_run_fee_charges` row was ever raised against them. The stored
-- total was a projection of a fee that was never collected.
update public.payment_runs
set total_debit_cents = vendor_amount_cents
where total_debit_cents <> vendor_amount_cents;

update public.payment_run_items
set total_debit_cents = vendor_amount_cents
where total_debit_cents <> vendor_amount_cents;

-- The debit is the vendor amount and nothing else. Fees live on
-- `payment_run_fee_charges`, which has its own amount and its own idempotency.
alter table public.payment_runs
  add constraint payment_runs_total_debit_is_vendor_amount
  check (total_debit_cents = vendor_amount_cents);

alter table public.payment_run_items
  add constraint payment_run_items_total_debit_is_vendor_amount
  check (total_debit_cents = vendor_amount_cents);

comment on column public.payment_runs.total_debit_cents is
  'What leaves the builder''s bank for vendors. Fees are collected separately on payment_run_fee_charges and are never added here.';
comment on column public.payment_run_items.total_debit_cents is
  'Per-item vendor debit. Equal to vendor_amount_cents; fee columns are quoted for display and reporting only.';

create or replace function public.create_payment_run_atomic(
  p_org_id uuid,
  p_requested_by uuid,
  p_funding_source_id uuid,
  p_currency text,
  p_approval_mode text,
  p_required_approvals smallint,
  p_vendor_amount_cents bigint,
  p_processor_fee_cents bigint,
  p_platform_fee_cents bigint,
  p_total_debit_cents bigint,
  p_control_snapshot jsonb,
  p_idempotency_key text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
  v_item jsonb;
  v_payee jsonb;
  v_run_item_id uuid;
  v_item_count integer;
  v_item_vendor_total bigint;
  v_item_processor_total bigint;
  v_item_platform_total bigint;
  v_item_debit_total bigint;
  v_payee_total bigint;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Payment run items must be a non-empty array';
  end if;
  if p_approval_mode not in ('sole','dual')
     or (p_approval_mode = 'sole' and p_required_approvals <> 1)
     or (p_approval_mode = 'dual' and p_required_approvals <> 2) then
    raise exception 'Payment run approval policy is invalid';
  end if;

  select count(*)::integer,
    coalesce(sum((value->>'vendor_amount_cents')::bigint), 0),
    coalesce(sum((value->>'processor_fee_cents')::bigint), 0),
    coalesce(sum((value->>'platform_fee_cents')::bigint), 0),
    coalesce(sum((value->>'total_debit_cents')::bigint), 0)
  into v_item_count, v_item_vendor_total, v_item_processor_total,
    v_item_platform_total, v_item_debit_total
  from jsonb_array_elements(p_items);
  -- Fee totals must still roll up exactly, because they are quoted evidence the
  -- approver sees and the fee charge is later raised against. They are simply no
  -- longer part of the debit.
  if v_item_count > 200
     or v_item_vendor_total <> p_vendor_amount_cents
     or v_item_processor_total <> p_processor_fee_cents
     or v_item_platform_total <> p_platform_fee_cents
     or v_item_debit_total <> p_total_debit_cents
     or p_total_debit_cents <> p_vendor_amount_cents then
    raise exception 'Payment run item totals do not match the run totals';
  end if;

  insert into public.payment_runs (
    org_id, funding_source_id, status, currency, payment_count,
    vendor_amount_cents, processor_fee_cents, platform_fee_cents,
    total_debit_cents, approval_mode_snapshot, required_approvals,
    control_snapshot, idempotency_key, requested_by
  ) values (
    p_org_id, p_funding_source_id, 'draft', lower(p_currency), v_item_count,
    p_vendor_amount_cents, p_processor_fee_cents, p_platform_fee_cents,
    p_total_debit_cents, p_approval_mode, p_required_approvals,
    p_control_snapshot, p_idempotency_key, p_requested_by
  ) on conflict (org_id, idempotency_key) do nothing
  returning * into v_run;

  if v_run.id is null then
    select * into v_run from public.payment_runs
    where org_id = p_org_id and idempotency_key = p_idempotency_key;
    return jsonb_build_object(
      'id', v_run.id,
      'status', v_run.status,
      'total_debit_cents', v_run.total_debit_cents,
      'required_approvals', v_run.required_approvals,
      'duplicate', true
    );
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item->'payees') <> 'array' or jsonb_array_length(v_item->'payees') = 0 then
      raise exception 'Each payment run item requires at least one payee';
    end if;
    select coalesce(sum((value->>'amount_cents')::bigint), 0)
      into v_payee_total from jsonb_array_elements(v_item->'payees');
    if v_payee_total <> (v_item->>'vendor_amount_cents')::bigint then
      raise exception 'Payment run payee amounts do not match the vendor amount';
    end if;

    insert into public.payment_run_items (
      org_id, run_id, project_id, bill_id, relationship_id, status,
      bill_balance_snapshot_cents, gross_payment_cents, retainage_held_cents,
      vendor_amount_cents, processor_fee_cents, platform_fee_cents,
      total_debit_cents, allocation_snapshot, hold_snapshot, waiver_snapshot
    ) values (
      p_org_id, v_run.id, nullif(v_item->>'project_id', '')::uuid,
      (v_item->>'bill_id')::uuid, (v_item->>'relationship_id')::uuid, 'draft',
      (v_item->>'bill_balance_snapshot_cents')::bigint,
      (v_item->>'gross_payment_cents')::bigint,
      (v_item->>'retainage_held_cents')::bigint,
      (v_item->>'vendor_amount_cents')::bigint,
      (v_item->>'processor_fee_cents')::bigint,
      (v_item->>'platform_fee_cents')::bigint,
      (v_item->>'total_debit_cents')::bigint,
      coalesce(v_item->'allocation_snapshot', '[]'::jsonb),
      coalesce(v_item->'hold_snapshot', '{}'::jsonb),
      coalesce(v_item->'waiver_snapshot', '{}'::jsonb)
    ) returning id into v_run_item_id;

    for v_payee in select value from jsonb_array_elements(v_item->'payees')
    loop
      if v_payee->>'method' <> 'ach' then
        raise exception 'Electronic payment runs support ACH payees only';
      end if;
      insert into public.payment_run_item_payees (
        org_id, run_item_id, payee_kind, method, recipient_account_id,
        payee_name, amount_cents
      ) values (
        p_org_id, v_run_item_id, v_payee->>'payee_kind', v_payee->>'method',
        nullif(v_payee->>'recipient_account_id', '')::uuid,
        v_payee->>'payee_name', (v_payee->>'amount_cents')::bigint
      );
    end loop;
  end loop;

  return jsonb_build_object(
    'id', v_run.id,
    'status', v_run.status,
    'total_debit_cents', v_run.total_debit_cents,
    'required_approvals', v_run.required_approvals,
    'duplicate', false
  );
end;
$$;

revoke all on function public.create_payment_run_atomic(uuid,uuid,uuid,text,text,smallint,bigint,bigint,bigint,bigint,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.create_payment_run_atomic(uuid,uuid,uuid,text,text,smallint,bigint,bigint,bigint,bigint,jsonb,text,jsonb) to service_role;
