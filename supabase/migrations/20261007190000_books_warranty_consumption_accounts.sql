-- B11.3: consuming the warranty reserve takes an approved warranty cost off the
-- cost-of-sales account it actually posted to (it used to credit 5050 Warranty
-- costs whatever the source account, leaving job cost overstated and warranty
-- expense negative).

CREATE OR REPLACE FUNCTION public.approve_books_warranty_cost(p_org_id uuid, p_visit_id uuid, p_date date, p_sources jsonb, p_evidence_url text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare credits jsonb := '[]'::jsonb; source_account uuid; remaining bigint; take bigint; credit_line jsonb; line_no integer := 1; visit public.warranty_service_visits%rowtype; item jsonb; cost public.job_cost_entries%rowtype; used bigint; total bigint:=0; covered bigint; reserve uuid; expense uuid; available bigint; result_id uuid; policy integer; source_kind text; resolved_source_id uuid; dimensions jsonb;
begin
 if jsonb_typeof(p_sources)<>'array' or jsonb_array_length(p_sources)=0 or p_evidence_url not like 'https://%' then raise exception 'Posted source costs and supporting evidence are required'; end if;
 if (select count(*) from jsonb_array_elements(p_sources))<>(select count(distinct x->>'job_cost_entry_id') from jsonb_array_elements(p_sources) x) then raise exception 'Cost sources must be unique'; end if;
 perform 1 from public.job_cost_entries j where j.org_id=p_org_id and j.id in(select (x->>'job_cost_entry_id')::uuid from jsonb_array_elements(p_sources) x) order by j.id for update;
 select * into visit from public.warranty_service_visits where org_id=p_org_id and id=p_visit_id for update;
 if not found or visit.status<>'completed' then raise exception 'Only completed warranty visits can receive cost approval'; end if;
 if visit.books_cost_approved_at is not null then
   if visit.books_cost_sources=p_sources and visit.books_cost_date=p_date and visit.books_cost_evidence_url=p_evidence_url then return jsonb_build_object('id',visit.books_cost_journal_entry_id,'approved_cents',visit.books_approved_cost_cents,'reserve_cents',visit.books_reserve_consumed_cents); end if;
   raise exception 'Reverse the prior cost approval before changing its sources';
 end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=visit.project_id for update;
 for item in select x from jsonb_array_elements(p_sources) x loop
   select * into cost from public.job_cost_entries where org_id=p_org_id and id=(item->>'job_cost_entry_id')::uuid;
   if not found or cost.project_id<>visit.project_id or cost.status<>'posted' or cost.cost_cents<=0 or cost.incurred_on>p_date or (item->>'amount_cents')::bigint<=0 then raise exception 'Select positive posted costs from this visit project on or before the approval date'; end if;
   source_kind:=case cost.source_type when 'vendor_bill_line' then 'vendor_bill' when 'project_expense_line' then 'expense' when 'project_expense' then 'expense' when 'time_entry' then 'labor_cost' when 'bank_transaction' then 'bank_transaction' else null end;
   resolved_source_id:=case cost.source_type when 'vendor_bill_line' then (select bill_id from public.bill_lines where org_id=p_org_id and id=cost.source_id::uuid) when 'project_expense_line' then (select expense_id from public.project_expense_lines where org_id=p_org_id and id=cost.source_id::uuid) when 'time_entry' then cost.id else cost.source_id::uuid end;
   if source_kind is null or not exists(select 1 from public.journal_entries e where e.org_id=p_org_id and e.source_type=source_kind and e.source_id=resolved_source_id and e.status='posted') then raise exception 'Post the actual cost source to Books before allocating it to warranty'; end if;
   select coalesce(sum((allocation->>'amount_cents')::bigint),0) into used from public.warranty_service_visits v cross join lateral jsonb_array_elements(v.books_cost_sources) allocation where v.org_id=p_org_id and v.books_cost_approved_at is not null and allocation->>'job_cost_entry_id'=cost.id::text;
   if used+(item->>'amount_cents')::bigint>cost.cost_cents then raise exception 'Warranty allocations exceed the actual source cost'; end if;
   -- The account this cost actually posted to: consuming the reserve takes the
   -- cost off that same account, so job cost and warranty expense stay true.
   select l.account_id into source_account from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
     where l.org_id=p_org_id and e.source_type=source_kind and e.source_id=resolved_source_id and e.status='posted' and l.project_id=visit.project_id and a.account_type='cogs' and l.debit_cents>0
     order by (l.debit_cents=cost.cost_cents) desc, l.line_no limit 1;
   credits:=credits||jsonb_build_array(jsonb_build_object('account_id',source_account,'cents',(item->>'amount_cents')::bigint));
   total:=total+(item->>'amount_cents')::bigint;
 end loop;
 select id into reserve from public.gl_accounts where org_id=p_org_id and code='2260' and active;
 select id into expense from public.gl_accounts where org_id=p_org_id and code='5050' and active;
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into available from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.project_id=visit.project_id and l.account_id=reserve and e.status in('posted','reversed') and e.entry_date<=p_date;
 covered:=least(total,greatest(available,0));
 if covered>0 then
   if expense is null then raise exception 'Warranty expense account is missing'; end if;
   select active_policy_version into policy from public.books_settings where org_id=p_org_id;
   dimensions:=jsonb_build_object('warranty_reserve_adjustment',true,'warranty_visit_id',visit.id,'evidence_url',p_evidence_url,'actual_sources',p_sources);
   -- Credit the covered amount to the accounts the sources posted to, in source
   -- order; a source with no cost-of-sales line (none expected) uses warranty costs.
   remaining:=covered;
   credit_line:=jsonb_build_array(jsonb_build_object('line_no',1,'account_id',reserve,'project_id',visit.project_id,'debit_cents',covered,'credit_cents',0,'dimensions',dimensions));
   for item in select x from jsonb_array_elements(credits) x loop
     exit when remaining<=0;
     take:=least(remaining,(item->>'cents')::bigint);
     line_no:=line_no+1;
     credit_line:=credit_line||jsonb_build_array(jsonb_build_object('line_no',line_no,'account_id',coalesce((item->>'account_id')::uuid,expense),'project_id',visit.project_id,'debit_cents',0,'credit_cents',take,'dimensions',dimensions));
     remaining:=remaining-take;
   end loop;
   result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Consume warranty reserve for approved actual cost','posting_key','warranty_cost:'||visit.id||':'||encode(extensions.digest(p_sources::text||p_date::text||now()::text,'sha256'),'hex'),'projection_version',1,'policy_version',policy,'source_type','warranty_reserve_consumption','source_id',visit.id,'created_by',p_actor_id),
   credit_line);
 end if;
 update public.warranty_service_visits set books_cost_sources=p_sources,books_approved_cost_cents=total,books_reserve_consumed_cents=covered,books_cost_approved_by=p_actor_id,books_cost_approved_at=now(),books_cost_date=p_date,books_cost_evidence_url=p_evidence_url,books_cost_journal_entry_id=result_id,updated_at=now() where org_id=p_org_id and id=visit.id;
 return jsonb_build_object('id',result_id,'approved_cents',total,'reserve_cents',covered);
end;
$function$;
