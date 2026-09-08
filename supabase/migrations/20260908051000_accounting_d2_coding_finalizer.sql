-- Pure normalization used by the reviewed pending finalizer; not invoked here.
create function public.accounting_d2_fill_missing_coding(p_coding jsonb,p_legacy jsonb,p_has_company boolean)
returns jsonb language plpgsql immutable set search_path=public as $$
declare c jsonb:=coalesce(nullif(p_coding,'null'::jsonb),'{}'::jsonb); v_key text; v_ref jsonb; v_dims jsonb; v_alias jsonb;
begin
  if jsonb_typeof(c)<>'object' then raise exception 'D2 coding must be an object'; end if;
  foreach v_key in array array['expense_account','payment_account','ap_account'] loop
    if nullif(c->v_key,'null'::jsonb) is null and nullif(p_legacy->>('qbo_'||v_key||'_id'),'') is not null then
      c:=jsonb_set(c,array[v_key],jsonb_strip_nulls(jsonb_build_object('id',p_legacy->>('qbo_'||v_key||'_id'),'name',p_legacy->>('qbo_'||v_key||'_name'))));
    end if;
  end loop;
  if nullif(c->'transaction_type','null'::jsonb) is null and nullif(p_legacy->'qbo_transaction_type','null'::jsonb) is not null then c:=jsonb_set(c,'{transaction_type}',p_legacy->'qbo_transaction_type'); end if;
  v_ref:=nullif(c->'counterparty','null'::jsonb); v_alias:=nullif(c->'vendor','null'::jsonb);
  if v_ref is not null and v_alias is not null and v_ref->>'id' is distinct from v_alias->>'id' then raise exception 'D2 counterparty alias conflicts with canonical coding'; end if;
  if v_ref is null then
    v_ref:=v_alias;
    -- A company link remains the identity owner; never duplicate its provider ID
    -- into direct transaction coding merely to make a cache look equal.
    if v_ref is null and not p_has_company and nullif(p_legacy->>'qbo_vendor_id','') is not null then v_ref:=jsonb_strip_nulls(jsonb_build_object('id',p_legacy->>'qbo_vendor_id','name',p_legacy->>'qbo_vendor_name')); end if;
    if v_ref is not null then c:=jsonb_set(c,'{counterparty}',v_ref); end if;
  end if;
  v_dims:=coalesce(nullif(c->'dimensions','null'::jsonb),'{}'::jsonb);
  if jsonb_typeof(v_dims)<>'object' then raise exception 'D2 dimensions must be an object'; end if;
  v_ref:=nullif(v_dims->'class','null'::jsonb); v_alias:=nullif(c->'class','null'::jsonb);
  if v_ref is not null and v_alias is not null and v_ref->>'id' is distinct from v_alias->>'id' then raise exception 'D2 class alias conflicts with canonical coding'; end if;
  if v_ref is null then
    v_ref:=v_alias;
    if v_ref is null and nullif(p_legacy->>'qbo_class_id','') is not null then v_ref:=jsonb_strip_nulls(jsonb_build_object('id',p_legacy->>'qbo_class_id','name',p_legacy->>'qbo_class_name')); end if;
    if v_ref is not null then v_dims:=jsonb_set(v_dims,'{class}',v_ref); end if;
  end if;
  if v_dims<>'{}'::jsonb then c:=jsonb_set(c,'{dimensions}',v_dims); end if;
  return c-'vendor'-'class';
end $$;
revoke all on function public.accounting_d2_fill_missing_coding(jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.accounting_d2_fill_missing_coding(jsonb,jsonb,boolean) to service_role;
