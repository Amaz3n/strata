-- job_cost_entries.source_id is text. Comparing it with a uuid raises
-- "operator does not exist" at run time, so every cost-of-goods bank
-- categorization and every warranty cost approval sourced from a bill or
-- expense line failed when reached. Bodies are the deployed definitions
-- (md5-verified against production) with only the casts changed.
begin;
CREATE OR REPLACE FUNCTION public.categorize_books_bank_transaction_atomic(p_org_id uuid, p_transaction_id uuid, p_account_id uuid, p_project_id uuid, p_cost_code_id uuid, p_memo text, p_actor_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 bank public.bank_accounts%rowtype; txn public.bank_transactions%rowtype; category public.gl_accounts%rowtype;
 category_entry_id uuid; cash_line_id uuid; policy integer; debit bigint; credit bigint;
inventory_code text; inventory_account uuid;
begin
 select b.* into bank from public.bank_accounts b join public.bank_transactions t on t.bank_account_id=b.id and t.org_id=b.org_id where t.id=p_transaction_id and t.org_id=p_org_id for update of b;
 if not found or bank.gl_account_id is null then raise exception 'Map the bank account before categorizing'; end if;
 select * into txn from public.bank_transactions where org_id=p_org_id and id=p_transaction_id for update;
 if txn.lifecycle_status<>'posted' or txn.excluded then raise exception 'Only posted, included bank transactions can be categorized'; end if;
 select * into category from public.gl_accounts where org_id=p_org_id and id=p_account_id and active;
 if not found or category.id=bank.gl_account_id then raise exception 'Choose a different active category account in this organization'; end if;
 if p_project_id is not null and not exists(select 1 from public.projects where org_id=p_org_id and id=p_project_id) then raise exception 'Project not found in organization'; end if;
 if p_cost_code_id is not null and not exists(select 1 from public.cost_codes where org_id=p_org_id and id=p_cost_code_id) then raise exception 'Cost code not found in organization'; end if;
 if p_project_id is null and p_cost_code_id is not null then raise exception 'A cost code requires a project'; end if;
 if category.account_type='cogs' and p_project_id is null then raise exception 'Direct job costs require a project'; end if;
 if category.account_type='expense' and p_project_id is not null then raise exception 'Use a direct cost account for project spending, or leave overhead unassigned'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then raise exception 'Books posting is not enabled'; end if;
 inventory_account:=category.id;
 if category.account_type='cogs' and p_project_id is not null then
   select case when s.books_inventory_sold_on is not null and txn.transaction_date>=s.books_inventory_sold_on then null when s.books_inventory_completed_on is not null and txn.transaction_date>=s.books_inventory_completed_on then '1170' else '1160' end into inventory_code from public.project_financial_settings s where s.org_id=p_org_id and s.project_id=p_project_id and s.books_inventory_enabled and txn.transaction_date>=s.books_inventory_effective_on for update;
   if inventory_code is not null then select id into inventory_account from public.gl_accounts where org_id=p_org_id and code=inventory_code and active; if inventory_account is null then raise exception 'Inventory account is missing'; end if; end if;
 end if;
 debit:=case when txn.direction='outflow' then txn.amount_cents else 0 end;
 credit:=case when txn.direction='inflow' then txn.amount_cents else 0 end;
 select e.id into category_entry_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key='bank_categorization:'||txn.id;
 if category_entry_id is not null then
   if not exists(select 1 from public.journal_entries e where e.id=category_entry_id and e.org_id=p_org_id and e.status='posted') then raise exception 'This categorization was reversed; review its correction before reposting'; end if;
   if not exists(select 1 from public.journal_lines l where l.org_id=p_org_id and l.entry_id=category_entry_id and l.account_id=inventory_account and l.project_id is not distinct from p_project_id and l.debit_cents=debit and l.credit_cents=credit) then raise exception 'Existing categorization differs; reverse it before changing the coding'; end if;
 else
   category_entry_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',txn.transaction_date,'entry_kind','adjusting','memo',p_memo,'posting_key','bank_categorization:'||txn.id,'projection_version',1,'policy_version',policy,'source_type','bank_transaction','source_id',txn.id,'created_by',p_actor_id),
     jsonb_build_array(jsonb_build_object('line_no',1,'account_id',inventory_account,'project_id',p_project_id,'description',p_memo,'debit_cents',debit,'credit_cents',credit,'dimensions',jsonb_build_object('cost_code_id',p_cost_code_id)),
       jsonb_build_object('line_no',2,'account_id',bank.gl_account_id,'description',p_memo,'debit_cents',credit,'credit_cents',debit,'dimensions','{}'::jsonb)));
 end if;
 if category.account_type='cogs' then
   if exists(select 1 from public.job_cost_entries j where j.org_id=p_org_id and j.source_type='bank_transaction' and j.source_id=txn.id::text and (j.project_id is distinct from p_project_id or j.cost_code_id is distinct from p_cost_code_id or j.cost_cents<>debit-credit or j.status<>'posted')) then raise exception 'Existing job cost differs from this categorization'; end if;
   insert into public.job_cost_entries(org_id,project_id,cost_code_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata)
   values(p_org_id,p_project_id,p_cost_code_id,'bank_transaction',txn.id,txn.transaction_date,debit-credit,'posted',false,jsonb_build_object('journal_entry_id',category_entry_id,'funding','bank_feed','billing_review_required',true))
   on conflict(org_id,source_type,source_id) do nothing;
 end if;
 select l.id into cash_line_id from public.journal_lines l where l.org_id=p_org_id and l.entry_id=category_entry_id and l.account_id=bank.gl_account_id;
 perform public.confirm_books_bank_match_atomic(p_org_id,txn.id,cash_line_id,txn.amount_cents,'exact',1,p_actor_id);
 return category_entry_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.approve_books_warranty_cost(p_org_id uuid, p_visit_id uuid, p_date date, p_sources jsonb, p_evidence_url text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare visit public.warranty_service_visits%rowtype; item jsonb; cost public.job_cost_entries%rowtype; used bigint; total bigint:=0; covered bigint; reserve uuid; expense uuid; available bigint; result_id uuid; policy integer; source_kind text; resolved_source_id uuid; dimensions jsonb;
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
   result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Consume warranty reserve for approved actual cost','posting_key','warranty_cost:'||visit.id||':'||encode(extensions.digest(p_sources::text||p_date::text||now()::text,'sha256'),'hex'),'projection_version',1,'policy_version',policy,'source_type','warranty_reserve_consumption','source_id',visit.id,'created_by',p_actor_id),
   jsonb_build_array(jsonb_build_object('line_no',1,'account_id',reserve,'project_id',visit.project_id,'debit_cents',covered,'credit_cents',0,'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',expense,'project_id',visit.project_id,'debit_cents',0,'credit_cents',covered,'dimensions',dimensions)));
 end if;
 update public.warranty_service_visits set books_cost_sources=p_sources,books_approved_cost_cents=total,books_reserve_consumed_cents=covered,books_cost_approved_by=p_actor_id,books_cost_approved_at=now(),books_cost_date=p_date,books_cost_evidence_url=p_evidence_url,books_cost_journal_entry_id=result_id,updated_at=now() where org_id=p_org_id and id=visit.id;
 return jsonb_build_object('id',result_id,'approved_cents',total,'reserve_cents',covered);
end;
$function$;

commit;
