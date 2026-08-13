begin;

-- Authentication is owned by external_identities. These vendor-profile copies
-- were never read after creation and would become dangerous if a future flow
-- mistook them for current credentials.
alter table public.vendor_portal_identities
  drop column if exists password_hash,
  drop column if exists last_authenticated_at;

-- Arc Pay launches with one verified primary-vendor ACH destination. Joint and
-- external-check payments use the explicit manual-payment workflow; leaving
-- unreachable enum values here advertises controls the product does not have.
do $$
begin
  if exists (
    select 1 from public.payment_run_item_payees
    where method <> 'ach' or payee_kind <> 'primary_vendor' or recipient_account_id is null
  ) then
    raise exception 'Unsupported speculative payment-run payees exist; repair them before applying this migration';
  end if;
  if exists (
    select 1 from public.payment_run_item_payees
    group by run_item_id having count(*) <> 1
  ) then
    raise exception 'Payment-run items must have exactly one payee; repair them before applying this migration';
  end if;
end;
$$;

alter table public.payment_run_item_payees
  drop constraint if exists payment_run_item_payees_method_check,
  drop constraint if exists payment_run_item_payees_payee_kind_check,
  drop constraint if exists payment_run_item_payees_check;
alter table public.payment_run_item_payees
  add constraint payment_run_item_payees_method_check check (method = 'ach'),
  add constraint payment_run_item_payees_payee_kind_check check (payee_kind = 'primary_vendor'),
  add constraint payment_run_item_payees_ach_recipient_check check (recipient_account_id is not null),
  add constraint payment_run_item_payees_one_per_item unique (run_item_id);

-- This snapshot was always the empty array, was accepted from no client, read
-- by no code, and carried no approval evidence. Holds and waivers remain frozen
-- in their dedicated snapshots.
alter table public.payment_run_items drop column if exists allocation_snapshot;

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
security invoker
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
      'id', v_run.id, 'status', v_run.status,
      'total_debit_cents', v_run.total_debit_cents,
      'required_approvals', v_run.required_approvals, 'duplicate', true
    );
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item->'payees') <> 'array' or jsonb_array_length(v_item->'payees') <> 1 then
      raise exception 'Each payment run item requires exactly one payee';
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
      total_debit_cents, hold_snapshot, waiver_snapshot
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
      coalesce(v_item->'hold_snapshot', '{}'::jsonb),
      coalesce(v_item->'waiver_snapshot', '{}'::jsonb)
    ) returning id into v_run_item_id;

    for v_payee in select value from jsonb_array_elements(v_item->'payees')
    loop
      if v_payee->>'method' <> 'ach'
         or v_payee->>'payee_kind' <> 'primary_vendor'
         or nullif(v_payee->>'recipient_account_id', '') is null then
        raise exception 'Electronic payment runs require one verified primary-vendor ACH destination';
      end if;
      insert into public.payment_run_item_payees (
        org_id, run_item_id, payee_kind, method, recipient_account_id,
        payee_name, amount_cents
      ) values (
        p_org_id, v_run_item_id, 'primary_vendor', 'ach',
        (v_payee->>'recipient_account_id')::uuid,
        v_payee->>'payee_name', (v_payee->>'amount_cents')::bigint
      );
    end loop;
  end loop;

  return jsonb_build_object(
    'id', v_run.id, 'status', v_run.status,
    'total_debit_cents', v_run.total_debit_cents,
    'required_approvals', v_run.required_approvals, 'duplicate', false
  );
end;
$$;

revoke all on function public.create_payment_run_atomic(uuid,uuid,uuid,text,text,smallint,bigint,bigint,bigint,bigint,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.create_payment_run_atomic(uuid,uuid,uuid,text,text,smallint,bigint,bigint,bigint,bigint,jsonb,text,jsonb) to service_role;

-- These writers are exposed only to the service role. Invoker rights keep the
-- database owner privileges out of their execution path; the service role has
-- the table access it needs without a SECURITY DEFINER bypass.
alter function public.record_manual_ap_payment_atomic(uuid,uuid,uuid,bigint,text,text,text,text,timestamptz,jsonb,text) security invoker;
alter function public.apply_vendor_credit_atomic(uuid,uuid,uuid,uuid,bigint,text,jsonb) security invoker;

commit;
