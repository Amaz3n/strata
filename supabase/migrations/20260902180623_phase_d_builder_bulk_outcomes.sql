-- Phase D: per-payable bulk outcomes for submit and approval.
-- These functions are service-role only.  Each skip-failures iteration runs in
-- its own PL/pgSQL exception block, so a rejected payable cannot roll back the
-- successful rows around it and the caller receives the exact reason.

create or replace function public.submit_vendor_bills_for_approval(
  p_org_id uuid,
  p_actor_id uuid,
  p_bill_ids uuid[]
)
returns table(id uuid, ok boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_bill public.vendor_bills%rowtype;
  v_label text;
begin
  if coalesce(array_length(p_bill_ids, 1), 0) < 1
     or array_length(p_bill_ids, 1) > 500 then
    raise exception 'Bulk submit requires between 1 and 500 bills';
  end if;
  if (select count(distinct value) from unnest(p_bill_ids) value) <> array_length(p_bill_ids, 1) then
    raise exception 'Bulk submit contains duplicate bills';
  end if;

  foreach v_id in array p_bill_ids loop
    begin
      select * into v_bill
      from public.vendor_bills
      where org_id = p_org_id and vendor_bills.id = v_id
      for update;
      if not found then raise exception 'Payable was not found'; end if;
      v_label := coalesce(nullif(v_bill.bill_number, ''), v_bill.id::text);
      if coalesce(v_bill.metadata->>'source', '') = 'vendor_credit' then
        raise exception 'Vendor credits do not enter approval';
      end if;
      if coalesce(v_bill.metadata->>'creation_state', 'ready') <> 'draft' then
        raise exception 'Payable % is already submitted', v_label;
      end if;
      if v_bill.project_id is null then raise exception 'Payable % is missing a project', v_label; end if;
      if v_bill.company_id is null then raise exception 'Payable % is missing a vendor', v_label; end if;
      if nullif(btrim(coalesce(v_bill.bill_number, '')), '') is null then raise exception 'Payable is missing an invoice number'; end if;
      if coalesce(v_bill.total_cents, 0) <= 0 then raise exception 'Payable % is missing an amount', v_label; end if;
      if not exists (select 1 from public.bill_lines line where line.org_id = p_org_id and line.bill_id = v_id) then
        raise exception 'Payable % is missing coding lines', v_label;
      end if;
      if exists (
        select 1
        from public.bill_lines line
        left join public.project_financial_settings settings
          on settings.org_id = p_org_id and settings.project_id = coalesce(line.project_id, v_bill.project_id)
        left join public.org_settings org_settings on org_settings.org_id = p_org_id
        where line.org_id = p_org_id and line.bill_id = v_id
          and coalesce(settings.cost_codes_enabled, nullif(org_settings.settings->>'cost_codes_enabled', '')::boolean, true)
          and line.cost_code_id is null
      ) then raise exception 'Payable % is missing required cost-code coding', v_label; end if;
      if (select coalesce(sum(round(coalesce(line.quantity, 1) * coalesce(line.unit_cost_cents, 0))), 0)
          from public.bill_lines line where line.org_id = p_org_id and line.bill_id = v_id) <> v_bill.total_cents then
        raise exception 'Payable % coding does not equal its total', v_label;
      end if;

      update public.vendor_bills
      set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'creation_state', 'ready',
        'submitted_for_approval_at', now(),
        'submitted_for_approval_by', p_actor_id
      )
      where org_id = p_org_id and vendor_bills.id = v_id;

      insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
      values (p_org_id,p_actor_id,'update','vendor_bill',v_id,
        jsonb_build_object('creation_state','draft'),jsonb_build_object('creation_state','ready'),'bulk_payables_submit');
      id := v_id; ok := true; reason := null; return next;
    exception when others then
      id := v_id; ok := false; reason := sqlerrm; return next;
    end;
  end loop;
end;
$$;

create or replace function public.approve_vendor_bills_with_outcomes(
  p_org_id uuid,
  p_actor_id uuid,
  p_items jsonb,
  p_mode text default 'all_or_nothing'
)
returns table(id uuid, ok boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_result jsonb;
begin
  if p_mode not in ('all_or_nothing','skip_failures') then raise exception 'Unknown bulk approval mode'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Bulk approval requires between 1 and 500 bills';
  end if;
  if p_mode = 'all_or_nothing' then
    v_result := public.approve_vendor_bills_atomic(p_org_id,p_actor_id,p_items);
    for v_item in select value from jsonb_array_elements(p_items) loop
      id := (v_item->>'id')::uuid; ok := true; reason := null; return next;
    end loop;
    return;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_result := public.approve_vendor_bills_atomic(p_org_id,p_actor_id,jsonb_build_array(v_item));
      id := (v_item->>'id')::uuid; ok := true; reason := null; return next;
    exception when others then
      id := (v_item->>'id')::uuid; ok := false; reason := sqlerrm; return next;
    end;
  end loop;
end;
$$;

revoke all on function public.submit_vendor_bills_for_approval(uuid,uuid,uuid[]) from public, anon, authenticated;
revoke all on function public.approve_vendor_bills_with_outcomes(uuid,uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.submit_vendor_bills_for_approval(uuid,uuid,uuid[]) to service_role;
grant execute on function public.approve_vendor_bills_with_outcomes(uuid,uuid,jsonb,text) to service_role;
