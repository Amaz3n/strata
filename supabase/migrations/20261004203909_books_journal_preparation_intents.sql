-- A fresh UUID identifies each legitimate preparation; retained receipts survive
-- subsequent chart/policy/review changes without resolving the original anew.
begin;
create function public.prepare_books_journal_proposal_atomic(p_org uuid,p_actor uuid,p_intent uuid,p_date date,p_memo text,p_reversing date,p_lines jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_journal_proposals; item jsonb; idx bigint; account uuid; prepared jsonb:='[]'; retained jsonb; policy integer; debit numeric; credit numeric; total_debit numeric:=0;total_credit numeric:=0; created boolean:=false; key text:='adjustment-intent:'||p_intent::text;
begin
 if p_intent is null or p_date is null or length(btrim(coalesce(p_memo,'')))<4 or(p_reversing is not null and p_reversing<p_date) or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 2 and 1000 then raise exception 'Invalid journal preparation intent';end if;
 perform 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active' for share;
 if not found then raise exception 'Active maker membership is required';end if;
 for item,idx in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
  if jsonb_typeof(item) is distinct from 'object' or(item-array['line_no','account_code','project_id','company_id','description','debit_cents','credit_cents','dimensions'])<>'{}'::jsonb or(item->>'line_no')::integer is distinct from idx or length(coalesce(item->>'account_code',''))=0 or jsonb_typeof(item->'debit_cents') is distinct from 'number' or jsonb_typeof(item->'credit_cents') is distinct from 'number' or jsonb_typeof(item->'dimensions') is distinct from 'object' then raise exception 'Invalid submitted journal line';end if;
  debit:=(item->>'debit_cents')::numeric;credit:=(item->>'credit_cents')::numeric;
  if debit<>trunc(debit) or credit<>trunc(credit) or debit not between 0 and 9007199254740991 or credit not between 0 and 9007199254740991 or not((debit>0 and credit=0)or(credit>0 and debit=0)) then raise exception 'Journal lines require safe integer cents and one positive side';end if;
  total_debit:=total_debit+debit;total_credit:=total_credit+credit;
 end loop;
 if total_debit<>total_credit or total_debit>9007199254740991 then raise exception 'Submitted journal is unbalanced or exceeds safe integer cents';end if;
 perform pg_advisory_xact_lock(hashtextextended('books-journal-preparation:'||p_org::text||':'||p_intent::text,0));
 select * into p from public.books_journal_proposals where org_id=p_org and posting_key=key for update;
 if p.id is not null then
  select jsonb_agg(value-'account_id' order by ordinality) into retained from jsonb_array_elements(p.lines) with ordinality;
  if p.proposed_by is distinct from p_actor or p.entry_date is distinct from p_date or p.memo is distinct from btrim(p_memo) or p.reversing_on is distinct from p_reversing or retained is distinct from p_lines then raise exception 'Preparation retry differs from retained submitted intent';end if;
  perform public.books_validate_proposal_receipt(p);
 else
  select active_policy_version into policy from public.books_settings where org_id=p_org for share;
  if policy is null or policy<1 then raise exception 'Books policy must be initialized before preparation';end if;
  for item in select value from jsonb_array_elements(p_lines) loop
   select id into account from public.gl_accounts where org_id=p_org and code=item->>'account_code' and active for share;
   if account is null then raise exception 'Submitted account must be active and scoped';end if;
   if item->>'project_id' is not null then
    perform 1 from public.projects where org_id=p_org and id=(item->>'project_id')::uuid for share;
    if not found then raise exception 'Submitted project belongs to another organization';end if;
   end if;
   if item->>'company_id' is not null then
    perform 1 from public.companies where org_id=p_org and id=(item->>'company_id')::uuid for share;
    if not found then raise exception 'Submitted company belongs to another organization';end if;
   end if;
   prepared:=prepared||jsonb_build_array(item||jsonb_build_object('account_id',account));
  end loop;
  insert into public.books_journal_proposals(org_id,entry_date,memo,reversing_on,posting_key,policy_version,proposed_by,lines) values(p_org,p_date,btrim(p_memo),p_reversing,key,policy,p_actor,prepared) returning * into p;
  created:=true;
 end if;
 return jsonb_build_object('orgId',p.org_id,'actorId',p.proposed_by,'intentId',p_intent,'id',p.id,'status',p.status,'policyVersion',p.policy_version,'created',created);
end;
$$;
revoke all on function public.prepare_books_journal_proposal_atomic(uuid,uuid,uuid,date,text,date,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_books_journal_proposal_atomic(uuid,uuid,uuid,date,text,date,jsonb) to service_role;
commit;
