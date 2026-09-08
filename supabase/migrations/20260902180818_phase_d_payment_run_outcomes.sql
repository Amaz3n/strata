-- Phase D: make payment-run creation speak the same per-bill outcome contract
-- as bulk submit and approval while preserving the original atomic RPC.
create or replace function public.create_payment_run_with_outcomes(
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
  p_items jsonb,
  p_mode text default 'all_or_nothing'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_valid jsonb := '[]'::jsonb;
  v_outcomes jsonb := '[]'::jsonb;
  v_run jsonb;
  v_bill_id uuid;
  v_vendor_total bigint;
  v_processor_total bigint;
  v_platform_total bigint;
  v_debit_total bigint;
begin
  if p_mode not in ('all_or_nothing','skip_failures') then raise exception 'Unknown payment-run creation mode'; end if;
  if p_mode = 'all_or_nothing' then
    v_run := public.create_payment_run_atomic(p_org_id,p_requested_by,p_funding_source_id,p_currency,p_approval_mode,
      p_required_approvals,p_vendor_amount_cents,p_processor_fee_cents,p_platform_fee_cents,p_total_debit_cents,
      p_control_snapshot,p_idempotency_key,p_items);
    select coalesce(jsonb_agg(jsonb_build_object('id',value->>'bill_id','ok',true,'reason',null)),'[]'::jsonb)
      into v_outcomes from jsonb_array_elements(p_items);
    return v_run || jsonb_build_object('outcomes',v_outcomes);
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_bill_id := (v_item->>'bill_id')::uuid;
      perform id from public.vendor_bills where org_id=p_org_id and id=v_bill_id for update;
      if not found then raise exception 'Payable was not found'; end if;
      if exists (select 1 from public.payment_run_items where bill_id=v_bill_id and status in ('draft','pending_approval','approved','processing','partially_paid')) then
        raise exception 'Payable is already in a payment run';
      end if;
      v_valid := v_valid || jsonb_build_array(v_item);
      v_outcomes := v_outcomes || jsonb_build_array(jsonb_build_object('id',v_bill_id,'ok',true,'reason',null));
    exception when others then
      v_outcomes := v_outcomes || jsonb_build_array(jsonb_build_object('id',coalesce(v_bill_id::text,v_item->>'bill_id'),'ok',false,'reason',sqlerrm));
    end;
  end loop;
  if jsonb_array_length(v_valid)=0 then return jsonb_build_object('id',null,'outcomes',v_outcomes); end if;
  select coalesce(sum((value->>'vendor_amount_cents')::bigint),0),
    coalesce(sum((value->>'processor_fee_cents')::bigint),0),coalesce(sum((value->>'platform_fee_cents')::bigint),0),
    coalesce(sum((value->>'total_debit_cents')::bigint),0)
  into v_vendor_total,v_processor_total,v_platform_total,v_debit_total from jsonb_array_elements(v_valid);
  v_run := public.create_payment_run_atomic(p_org_id,p_requested_by,p_funding_source_id,p_currency,p_approval_mode,
    p_required_approvals,v_vendor_total,v_processor_total,v_platform_total,v_debit_total,p_control_snapshot,p_idempotency_key,v_valid);
  return v_run || jsonb_build_object('outcomes',v_outcomes);
end;
$$;
revoke all on function public.create_payment_run_with_outcomes(uuid,uuid,uuid,text,text,smallint,bigint,bigint,bigint,bigint,jsonb,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_payment_run_with_outcomes(uuid,uuid,uuid,text,text,smallint,bigint,bigint,bigint,bigint,jsonb,text,jsonb,text) to service_role;
