-- Record a completed manual payment and its native funding identity atomically.
create or replace function public.record_manual_ap_payment_with_books_atomic(
 p_org_id uuid,p_bill_id uuid,p_actor_id uuid,p_amount_cents bigint,p_currency text,p_method text,p_reference text,p_check_number text,p_received_at timestamptz,p_release_evidence jsonb,p_idempotency_key text,p_books_account_id uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; payment public.payments%rowtype; choices uuid[];
begin
 if p_books_account_id is null and exists(select 1 from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled') then
   select array_agg(id) into choices from public.gl_accounts where org_id=p_org_id and active and ((p_method in('card','credit_card','company_card') and subtype='credit_card') or (p_method not in('card','credit_card','company_card') and subtype='cash'));
   if coalesce(cardinality(choices),0)<>1 then raise exception 'Choose the actual bank or card account before recording this payment'; end if;
   p_books_account_id:=choices[1];
 end if;
 perform 1 from public.vendor_bills where org_id=p_org_id and id=p_bill_id for update;
 if p_books_account_id is not null and not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=p_books_account_id and active and ((p_method in('card','credit_card','company_card') and subtype='credit_card') or (p_method not in('card','credit_card','company_card') and subtype='cash'))) then raise exception 'Select the active native bank or card account that funded this payment'; end if;
 result:=public.record_manual_ap_payment_atomic(p_org_id,p_bill_id,p_actor_id,p_amount_cents,p_currency,p_method,p_reference,p_check_number,p_received_at,p_release_evidence,p_idempotency_key);
 select * into payment from public.payments where org_id=p_org_id and id=(result->>'payment_id')::uuid for update;
 if (result->>'duplicate')::boolean and (payment.metadata->>'books_payment_account_id') is distinct from p_books_account_id::text then raise exception 'Payment reference was already recorded with different funding'; end if;
 if p_books_account_id is not null then update public.payments set metadata=metadata||jsonb_build_object('books_payment_account_id',p_books_account_id) where org_id=p_org_id and id=payment.id; end if;
 return result;
end;
$$;
revoke all on function public.record_manual_ap_payment_with_books_atomic(uuid,uuid,uuid,bigint,text,text,text,text,timestamptz,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.record_manual_ap_payment_with_books_atomic(uuid,uuid,uuid,bigint,text,text,text,text,timestamptz,jsonb,text,uuid) to service_role;
