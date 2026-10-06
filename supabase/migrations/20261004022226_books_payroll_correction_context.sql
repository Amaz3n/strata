-- Immutable posted receipts cannot change or be deleted. SELECT FOR SHARE
-- requires UPDATE privileges, which the private receipt ACL intentionally denies.
-- Read/prove those receipts without adding a mutation grant. Mutable source,
-- dimension and period evidence remains locked under transaction fences.
create or replace function public.validate_books_payroll_correction_source(p_org uuid,p_id uuid,p_posting uuid,p_evidence jsonb) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare posting public.books_payroll_postings; parent public.books_payroll_imports; r jsonb:=p_evidence->'run'; proof jsonb:=p_evidence->'source_proof'; w jsonb; a jsonb; item jsonb; key text; expected numeric; actual numeric; seen_workers uuid[]:='{}';seen_allocations uuid[]:='{}';seen_native uuid[]:='{}'; identifier uuid; version_row public.doc_versions; latest_date date;
begin
 if jsonb_typeof(p_evidence->'request') is distinct from 'object' or (p_evidence->'request')-array['id','postingId','accountingDate','reason']<>'{}'::jsonb or jsonb_typeof(r) is distinct from 'object' or r-array['id','org_id','provider','provider_run_id','period_start','period_end','accrual_date','pay_date','source_checksum','employees','controls']<>'{}'::jsonb or jsonb_typeof(r->'controls') is distinct from 'object' or (r->'controls')-array['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents','funding_cents']<>'{}'::jsonb then raise exception 'Correction register/request shape differs';end if;
 select * into posting from public.books_payroll_postings where org_id=p_org and id=p_posting;
 if posting.id is null then raise exception 'Correction requires original posted payroll in organization';end if;
 perform public.assert_books_payroll_posting_receipt(to_jsonb(posting));
 select * into parent from public.books_payroll_imports where org_id=p_org and id=posting.payroll_import_id for share;
 if r->>'id' is distinct from p_id::text or r->>'org_id' is distinct from p_org::text or p_evidence#>>'{request,id}' is distinct from p_id::text or p_evidence#>>'{request,postingId}' is distinct from p_posting::text or p_id=parent.id or coalesce(length(trim(p_evidence#>>'{request,reason}')),0) not between 10 and 4000 then raise exception 'Correction source identity or explanation differs';end if;
 foreach key in array array['provider','provider_run_id','period_start','period_end','accrual_date'] loop
  if r->key is distinct from parent.run->key then raise exception 'Replacement payroll provider/run/work period differs';end if;
 end loop;
 select max((value->>'entryDate')::date) into latest_date from jsonb_array_elements(posting.result->'journals');
 if (p_evidence#>>'{request,accountingDate}')::date is null or (p_evidence#>>'{request,accountingDate}')::date<greatest(latest_date,(r->>'accrual_date')::date) then raise exception 'Correction cannot precede original dated recognition';end if;
 if (r->>'pay_date')::date is null or jsonb_typeof(r->'employees') is distinct from 'array' or jsonb_array_length(r->'employees')=0 then raise exception 'Correction requires full provider register';end if;
 if coalesce(proof->>'storage_path','') not like p_org::text||'/%' or position(chr(92) in proof->>'storage_path')>0 or exists(select 1 from unnest(string_to_array(proof->>'storage_path','/')) part where part in('','.','..')) then raise exception 'Correction document path is outside organization';end if;
 if proof->>'org_id' is distinct from p_org::text or proof->'version' is distinct from '1'::jsonb or r->>'source_checksum' is distinct from proof->>'checksum' then raise exception 'Correction document scope or checksum differs';end if;
 perform pg_advisory_xact_lock(hashtextextended('tax-attachment:'||p_org::text||':'||(proof->>'file_id'),0));
 select * into version_row from public.doc_versions where org_id=p_org and id=(proof->>'document_version_id')::uuid and file_id=(proof->>'file_id')::uuid for share;
 perform 1 from public.files where org_id=p_org and id=(proof->>'file_id')::uuid for share;
 if not found or version_row.id is null or version_row.storage_path is distinct from proof->>'storage_path' or version_row.file_name is distinct from proof->>'file_name' or version_row.mime_type is distinct from proof->>'mime_type' or version_row.size_bytes is distinct from (proof->>'size_bytes')::bigint or version_row.checksum is distinct from proof->>'checksum' or version_row.size_bytes not between 1 and 16777216 then raise exception 'Correction original document version differs';end if;
 if jsonb_typeof(p_evidence->'account_snapshot') is distinct from 'array' or exists(select 1 from jsonb_array_elements(p_evidence->'account_snapshot') ac where ac.value->>'org_id' is distinct from p_org::text or not exists(select 1 from public.gl_accounts g where g.org_id=p_org and g.id=(ac.value->>'id')::uuid and g.code=ac.value->>'code' and g.account_type=ac.value->>'account_type' and g.subtype=ac.value->>'subtype' and g.active and ac.value->'active'='true'::jsonb)) then raise exception 'Correction original account snapshot differs';end if;
 if jsonb_typeof(p_evidence->'column_mapping') is distinct from 'object' or (p_evidence->>'source_mapping_digest')!~'^[a-f0-9]{64}$' then raise exception 'Correction column/worker mapping evidence is required';end if;
 foreach key in array array['2200','2230'] loop
  if (select count(*) from jsonb_array_elements(p_evidence->'account_snapshot') ac where ac.value->>'code'=key and ac.value->>'account_type'='liability')<>1 then raise exception 'Correction liability account snapshot differs';end if;
 end loop;
 if (select count(*) from jsonb_array_elements(p_evidence->'account_snapshot'))<>(select count(distinct value->>'code') from jsonb_array_elements(p_evidence->'account_snapshot')) then raise exception 'Correction account snapshot codes must be unique';end if;
 foreach key in array array['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents'] loop
  expected:=public.books_payroll_exact_amount(r->'controls'->key);
  select sum(public.books_payroll_exact_amount(value->key)) into actual from jsonb_array_elements(r->'employees');
  if actual is distinct from expected then raise exception 'Correction provider controls differ';end if;
 end loop;
 expected:=public.books_payroll_exact_amount(r#>'{controls,gross_cents}')+public.books_payroll_exact_amount(r#>'{controls,employer_taxes_cents}')+public.books_payroll_exact_amount(r#>'{controls,employer_benefits_cents}');
 if expected>9007199254740991 or expected is distinct from public.books_payroll_exact_amount(r#>'{controls,funding_cents}') then raise exception 'Correction funding control differs';end if;
 if (select count(*) from jsonb_array_elements(r->'employees'))<>(select count(distinct value->>'employee_reference') from jsonb_array_elements(r->'employees')) then raise exception 'Correction employee references must be unique';end if;
 for w in select value from jsonb_array_elements(r->'employees') loop
  if w-array['worker_id','employee_reference','gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents','allocations']<>'{}'::jsonb then raise exception 'Correction worker shape differs';end if;
  identifier:=(w->>'worker_id')::uuid;
  if identifier is null or identifier=any(seen_workers) or not exists(select 1 from public.memberships where org_id=p_org and user_id=identifier) or coalesce(length(trim(w->>'employee_reference')),0) not between 1 and 200 then raise exception 'Correction requires unique organization worker mappings';end if;
  seen_workers:=array_append(seen_workers,identifier);
  if public.books_payroll_exact_amount(w->'gross_cents')=0 or public.books_payroll_exact_amount(w->'gross_cents') is distinct from public.books_payroll_exact_amount(w->'net_cents')+public.books_payroll_exact_amount(w->'employee_taxes_cents')+public.books_payroll_exact_amount(w->'employee_deductions_cents') or jsonb_typeof(w->'allocations') is distinct from 'array' or jsonb_array_length(w->'allocations')=0 then raise exception 'Correction employee amounts or allocations differ';end if;
  foreach key in array array['gross_cents','employer_taxes_cents','employer_benefits_cents'] loop
   select sum(public.books_payroll_exact_amount(value->key)) into actual from jsonb_array_elements(w->'allocations');
   if actual is distinct from public.books_payroll_exact_amount(w->key) then raise exception 'Correction construction allocations differ';end if;
  end loop;
  for a in select value from jsonb_array_elements(w->'allocations') loop
   if a-array['id','project_id','cost_code_id','cost_account_code','gross_cents','employer_taxes_cents','employer_benefits_cents','labor_evidence_ids']<>'{}'::jsonb then raise exception 'Correction allocation shape differs';end if;
   identifier:=(a->>'id')::uuid;
   if identifier is null or identifier=any(seen_allocations) then raise exception 'Correction allocation IDs must be unique';end if;seen_allocations:=array_append(seen_allocations,identifier);
   if a->>'project_id' is not null then perform 1 from public.projects where org_id=p_org and id=(a->>'project_id')::uuid for share;if not found then raise exception 'Correction project is outside organization';end if;end if;
   if a->>'cost_code_id' is not null then perform 1 from public.cost_codes where org_id=p_org and id=(a->>'cost_code_id')::uuid for share;if not found then raise exception 'Correction cost code is outside organization';end if;end if;
   perform 1 from public.gl_accounts where org_id=p_org and code=a->>'cost_account_code' and active and(account_type in('cogs','expense') or(account_type='asset' and subtype='work_in_progress')) for share;
   if not found or (select count(*) from jsonb_array_elements(p_evidence->'account_snapshot') ac where ac.value->>'code'=a->>'cost_account_code' and(ac.value->>'account_type' in('cogs','expense') or(ac.value->>'account_type'='asset' and ac.value->>'subtype'='work_in_progress')))<>1 then raise exception 'Correction cost account is invalid';end if;
   if jsonb_typeof(a->'labor_evidence_ids') is distinct from 'array' then raise exception 'Correction native mapping is required';end if;
   for item in select value from jsonb_array_elements(a->'labor_evidence_ids') loop
    identifier:=(item#>>'{}')::uuid;
    if identifier is null or identifier=any(seen_native) or not exists(select 1 from jsonb_array_elements(parent.labor_evidence) source where source.value->>'id'=identifier::text and source.value->>'worker_id'=w->>'worker_id') then raise exception 'Correction cannot consume duplicate, foreign or another worker native labor';end if;
    seen_native:=array_append(seen_native,identifier);
   end loop;
  end loop;
 end loop;
end $$;

create or replace function public.reviewed_books_payroll_correction_delta(p_org uuid,p_source uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source public.books_payroll_correction_sources;posting public.books_payroll_postings;parent public.books_payroll_imports;
begin
 select * into source from public.books_payroll_correction_sources where org_id=p_org and id=p_source for share;
 if source.id is null or source.status<>'reviewed' or source.evidence_hash is distinct from public.books_payroll_correction_source_hash(to_jsonb(source)) then raise exception 'Provider correction requires immutable reviewed source';end if;
 perform public.validate_books_payroll_correction_source(p_org,p_source,source.posting_id,to_jsonb(source));
 select * into posting from public.books_payroll_postings where org_id=p_org and id=source.posting_id;
 select * into parent from public.books_payroll_imports where org_id=p_org and id=posting.payroll_import_id for share;
 return public.books_payroll_provider_delta(parent.run,parent.reconciliation->'postingAccounts',source.run,source.account_snapshot,source.request);
end $$;

-- Construction/liability closure for a future corrective posting proposal.
-- Standalone RPC completion releases these locks. The money transaction must
-- call this again, compare the independently reviewed complete context, resolve
-- latest posted lineage and keep every resulting write in the same transaction.
create function public.lock_books_payroll_correction_context(p_org_id uuid,p_source_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source public.books_payroll_correction_sources;posting public.books_payroll_postings;parent public.books_payroll_imports;proposal public.books_payroll_posting_proposals;
 math jsonb;context jsonb;project_costs jsonb:='[]';workers jsonb:='[]';blockers text[]:='{}';cost_blockers text[];project_ids uuid[];code_ids uuid[];budget_ids uuid[];billable_ids uuid[];journal_ids uuid[];additional_ids uuid[];
 line jsonb;allocation jsonb;construction jsonb;worker_id text;before_worker jsonb;after_worker jsonb;worker_delta jsonb;worker_remaining jsonb;remaining jsonb;
 cost numeric;total_cost numeric:=0;key text;field text;amount numeric;budget_line public.budget_lines;budget public.budgets;billable public.billable_costs;period_count integer;account public.gl_accounts;frozen jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 if not pg_try_advisory_xact_lock(hashtextextended('books-payroll-source:'||p_org_id::text,0)) then raise exception 'Payroll sources are changing; retry correction transaction' using errcode='40001';end if;
 if not pg_try_advisory_xact_lock_shared(hashtextextended('books-period-calendar:'||p_org_id::text,0)) then raise exception 'Accounting calendar is changing; retry correction transaction' using errcode='40001';end if;
 select * into source from public.books_payroll_correction_sources where org_id=p_org_id and id=p_source_id for share;
 if source.id is null or source.status<>'reviewed' then raise exception 'Correction context requires independently reviewed source';end if;
 math:=public.reviewed_books_payroll_correction_delta(p_org_id,p_source_id);
 select * into posting from public.books_payroll_postings where org_id=p_org_id and id=source.posting_id;
 select * into parent from public.books_payroll_imports where org_id=p_org_id and id=posting.payroll_import_id for share;
 select * into proposal from public.books_payroll_posting_proposals where org_id=p_org_id and id=posting.proposal_id for share;
 select array_agg(distinct id order by id) into project_ids from(
  select (value->>'projectId')::uuid id from jsonb_array_elements(proposal.plan->'allocations')
  union select (a.value->>'project_id')::uuid from jsonb_array_elements(source.run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a
 ) scope where id is not null;
 select array_agg(distinct id order by id) into code_ids from(
  select (value->>'costCodeId')::uuid id from jsonb_array_elements(proposal.plan->'allocations')
  union select (a.value->>'cost_code_id')::uuid from jsonb_array_elements(source.run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a
 ) scope where id is not null;
 select array_agg(distinct (value#>>'{construction,budgetLineId}')::uuid) into budget_ids from jsonb_array_elements(proposal.plan->'allocations') where value#>>'{construction,budgetLineId}' is not null;
 select array_agg(distinct value::uuid order by value::uuid) into billable_ids from(
  select jsonb_array_elements_text(value#>'{construction,billing,originalBillableCostIds}') value from jsonb_array_elements(proposal.plan->'allocations')
 ) scope;
 perform 1 from public.projects where org_id=p_org_id and id=any(project_ids) order by id for share;
 perform 1 from public.cost_codes where org_id=p_org_id and id=any(code_ids) order by id for share;
 perform 1 from public.budgets where org_id=p_org_id and project_id=any(project_ids) order by id for share;
 perform 1 from public.budget_lines where org_id=p_org_id and id=any(budget_ids) order by id for share;
 perform 1 from public.billable_costs where org_id=p_org_id and id=any(billable_ids) order by id for share;
 perform 1 from public.gl_accounts where org_id=p_org_id order by id for share;
 perform 1 from public.accounting_periods where org_id=p_org_id and (source.request->>'accountingDate')::date between period_start and period_end order by id for share;
 select count(*) into period_count from public.accounting_periods where org_id=p_org_id and (source.request->>'accountingDate')::date between period_start and period_end;
 if period_count<>1 or not exists(select 1 from public.accounting_periods where org_id=p_org_id and (source.request->>'accountingDate')::date between period_start and period_end and status in('open','reopened')) then blockers:=array_append(blockers,'correction_date_requires_one_open_period');end if;
 -- Use historical line classification as well as current chart codes. A chart
 -- rename must not hide a settlement. Never infer run attribution from dates.
 select array_agg(distinct j.id order by j.id) into journal_ids from public.journal_entries j join public.journal_lines l on l.org_id=j.org_id and l.entry_id=j.id left join public.gl_accounts a on a.org_id=l.org_id and a.id=l.account_id
 where j.org_id=p_org_id and j.status in('posted','reversed') and j.source_type is distinct from 'labor_cost' and(a.code in('2200','2230') or l.dimensions#>>'{books_account_classification,code}' in('2200','2230'));
 perform 1 from public.journal_entries where org_id=p_org_id and id=any(journal_ids) order by id for share;
 perform 1 from public.journal_lines where org_id=p_org_id and entry_id=any(journal_ids) order by id for share;
 -- All sides of every selected settlement are retained and balance independently.
 if exists(select 1 from public.journal_lines where org_id=p_org_id and entry_id=any(journal_ids) group by entry_id having sum(debit_cents::numeric)<>sum(credit_cents::numeric)) then raise exception 'Correction liability history is unbalanced';end if;
 if exists(select 1 from public.journal_lines l left join public.gl_accounts a on a.org_id=l.org_id and a.id=l.account_id where l.org_id=p_org_id and l.entry_id=any(journal_ids) and(
  l.debit_cents not between 0 and 9007199254740991 or l.credit_cents not between 0 and 9007199254740991 or(l.debit_cents=0 and l.credit_cents=0) or(l.debit_cents>0 and l.credit_cents>0) or a.id is null or
  (l.dimensions->'books_account_classification' is not null and(
   jsonb_typeof(l.dimensions->'books_account_classification') is distinct from 'object' or
   l.dimensions#>>'{books_account_classification,account_id}' is distinct from l.account_id::text or
   jsonb_typeof(l.dimensions#>'{books_account_classification,code}') is distinct from 'string' or
   jsonb_typeof(l.dimensions#>'{books_account_classification,account_type}') is distinct from 'string')) or
  (coalesce(l.dimensions#>>'{books_account_classification,code}',a.code) in('2200','2230') and coalesce(l.dimensions#>>'{books_account_classification,account_type}',a.account_type) is distinct from 'liability') or
  (l.dimensions->'books_account_classification' is null and a.id is null))) then raise exception 'Correction liability history amount or classification differs';end if;
 if exists(select 1 from public.journal_lines l join public.gl_accounts a on a.org_id=l.org_id and a.id=l.account_id where l.org_id=p_org_id and l.entry_id=any(journal_ids) and coalesce(l.dimensions#>>'{books_account_classification,code}',a.code) in('2200','2230') group by rollup(l.entry_id),coalesce(l.dimensions#>>'{books_account_classification,code}',a.code) having abs(sum(l.credit_cents::numeric-l.debit_cents::numeric))>9007199254740991) then raise exception 'Correction liability history exceeds exact cents';end if;
 select array_agg(id order by id) into additional_ids from unnest(journal_ids) id where not exists(select 1 from jsonb_array_elements(posting.result->'journals') j where (j.value->>'journalId')::uuid=id) and not exists(select 1 from jsonb_array_elements(parent.reconciliation#>'{workflowEvidence,sourceTables,journal_entries}') j where (j.value->>'id')::uuid=id);
 if coalesce(array_length(additional_ids,1),0)>0 then blockers:=array_append(blockers,'review_additional_liability_attribution');end if;
 for line in select value from jsonb_array_elements(coalesce(math#>'{journalDraft,lines}','[]'::jsonb)) where value->>'projectId' is not null and value->>'accountCode' not in('2200','2230') loop
  allocation:=null;construction:=null;cost_blockers:='{}';
  select value into allocation from jsonb_array_elements(proposal.plan->'allocations') where value->>'allocationId'=line#>>'{dimensions,payroll_allocation_id}' and value->>'workerId'=line#>>'{dimensions,payroll_worker_id}' and value->>'projectId'=line->>'projectId' and value->>'costCodeId' is not distinct from line#>>'{dimensions,cost_code_id}' and value->>'accountCode'=line->>'accountCode';
  construction:=allocation->'construction';
  if construction is null then cost_blockers:=array_append(cost_blockers,'review_new_or_reallocated_budget_and_gmp');end if;
  if construction#>>'{billing,action}' is distinct from 'preserve_time_and_materials_rates' then cost_blockers:=array_append(cost_blockers,'review_customer_billing_basis');end if;
  if construction->>'budgetLineId' is not null then
   select * into budget_line from public.budget_lines where org_id=p_org_id and id=(construction->>'budgetLineId')::uuid;
   select * into budget from public.budgets where org_id=p_org_id and id=budget_line.budget_id;
   if budget_line.id is null or budget.id is null or budget.project_id::text is distinct from line->>'projectId' or budget_line.cost_code_id::text is distinct from line#>>'{dimensions,cost_code_id}' then cost_blockers:=array_append(cost_blockers,'review_changed_budget_scope');end if;
  end if;
  for key in select jsonb_array_elements_text(coalesce(construction#>'{billing,originalBillableCostIds}','[]'::jsonb)) loop
   select * into billable from public.billable_costs where org_id=p_org_id and id=key::uuid;
   if billable.id is null or billable.project_id::text is distinct from line->>'projectId' or billable.cost_code_id::text is distinct from line#>>'{dimensions,cost_code_id}' or billable.metadata->>'billing_method' is distinct from 'time_and_materials_rate' then cost_blockers:=array_append(cost_blockers,'review_changed_customer_billing_basis');end if;
  end loop;
  cost:=(line->>'debitCents')::numeric-(line->>'creditCents')::numeric;total_cost:=total_cost+cost;
  if cost not between -2147483648 and 2147483647 then cost_blockers:=array_append(cost_blockers,'job_cost_integer_capacity');end if;
  project_costs:=project_costs||jsonb_build_array(jsonb_build_object('workerId',line#>>'{dimensions,payroll_worker_id}','allocationId',line#>>'{dimensions,payroll_allocation_id}','projectId',line->>'projectId','costCodeId',line#>>'{dimensions,cost_code_id}','accountCode',line->>'accountCode','accountId',line#>>'{dimensions,books_correction_account_id}','component',line#>>'{dimensions,payroll_component}','costCents',cost,'incurredOn',source.request->>'accountingDate','budgetLineId',construction->>'budgetLineId','gmpClassification',construction->>'gmpClassification','sourceJobCostIds',coalesce(construction->'sourceJobCostIds','[]'::jsonb),'preservedBillableCostIds',coalesce(construction#>'{billing,originalBillableCostIds}','[]'::jsonb),'blockers',to_jsonb(cost_blockers)));
 end loop;
 if total_cost is distinct from (math->>'projectCostDeltaCents')::numeric then raise exception 'Correction project cost/ledger bridge differs';end if;
 for worker_id in select worker from(select distinct value->>'worker_id' worker from jsonb_array_elements((parent.run->'employees')||(source.run->'employees'))) scope order by worker collate "C" loop
  select value into before_worker from jsonb_array_elements(parent.run->'employees') where value->>'worker_id'=worker_id;
  select value into after_worker from jsonb_array_elements(source.run->'employees') where value->>'worker_id'=worker_id;
  worker_delta:='{}';worker_remaining:='{}';
  for key,field in select * from(values('netPayCents','net_cents'),('employeeTaxesCents','employee_taxes_cents'),('employeeDeductionsCents','employee_deductions_cents'),('employerTaxesCents','employer_taxes_cents'),('employerBenefitsCents','employer_benefits_cents')) mapping(label,field) loop
   amount:=coalesce((after_worker->>field)::numeric,0)-coalesce((before_worker->>field)::numeric,0);
   worker_delta:=worker_delta||jsonb_build_object(key,amount);
   select amount+coalesce(sum((value->'outstanding'->>key)::numeric),0) into amount from jsonb_array_elements(proposal.plan->'allocations') where value->>'workerId'=worker_id;
   if abs(amount)>9007199254740991 then raise exception 'Correction worker liability exceeds exact cents';end if;
   worker_remaining:=worker_remaining||jsonb_build_object(key,amount);
   if amount<0 then blockers:=array_append(blockers,'review_employee_or_provider_overpayment_recovery');end if;
  end loop;
  workers:=workers||jsonb_build_array(jsonb_build_object('workerId',worker_id,'liabilityDelta',worker_delta,'remainingBeforeAdditionalAttribution',worker_remaining));
 end loop;
 remaining:='{}';
 for key in select jsonb_object_keys(math->'liabilityDelta') loop
  amount:=(proposal.plan->'outstanding'->>key)::numeric+(math->'liabilityDelta'->>key)::numeric;
  if amount is null or abs(amount)>9007199254740991 then raise exception 'Correction aggregate liability exceeds exact cents';end if;
  remaining:=remaining||jsonb_build_object(key,amount);
 end loop;
 if (math#>>'{liabilityDelta,employeeTaxesCents}')::numeric<>0 or(math#>>'{liabilityDelta,employerTaxesCents}')::numeric<>0 then blockers:=array_append(blockers,'review_provider_tax_correction_evidence');end if;
 if math->'journalDraft'='null'::jsonb then blockers:=array_append(blockers,'no_accounting_change');end if;
 for line in select value from jsonb_array_elements(coalesce(math#>'{journalDraft,lines}','[]'::jsonb)) loop
  select * into account from public.gl_accounts where org_id=p_org_id and id=(line#>>'{dimensions,books_correction_account_id}')::uuid;
  select value into frozen from jsonb_array_elements(parent.reconciliation->'postingAccounts') where value->>'id'=account.id::text;
  if account.id is null or not account.active or(frozen is not null and(account.code is distinct from frozen->>'code' or account.account_type is distinct from frozen->>'account_type' or account.subtype is distinct from frozen->>'subtype')) then blockers:=array_append(blockers,'review_original_account_classification');end if;
 end loop;
 context:=jsonb_build_object(
  'projects',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.projects r where org_id=p_org_id and id=any(project_ids)),
  'cost_codes',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.cost_codes r where org_id=p_org_id and id=any(code_ids)),
  'budget_lines',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.budget_lines r where org_id=p_org_id and id=any(budget_ids)),
  'budgets',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.budgets r where org_id=p_org_id and project_id=any(project_ids)),
  'billable_costs',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.billable_costs r where org_id=p_org_id and id=any(billable_ids)),
  'gl_accounts',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.gl_accounts r where org_id=p_org_id),
  'accounting_periods',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.accounting_periods r where org_id=p_org_id and(source.request->>'accountingDate')::date between period_start and period_end),
  'liability_journals',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.journal_entries r where org_id=p_org_id and id=any(journal_ids)),
  'liability_lines',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.journal_lines r where org_id=p_org_id and entry_id=any(journal_ids)));
 select array_agg(value order by value collate "C") into blockers from(select distinct value from unnest(blockers) value) reasons;
 return jsonb_build_object('version',1,'orgId',p_org_id,'sourceId',source.id,'sourceHash',source.evidence_hash,'originalPostingId',posting.id,'originalPlanDigest',posting.plan_digest,'request',source.request,'math',math,'projectCosts',project_costs,'workers',workers,'remainingBeforeAdditionalAttribution',remaining,'additionalLiabilityJournalIds',coalesce(to_jsonb(additional_ids),'[]'::jsonb),'context',context,'contextHash',encode(sha256(convert_to(context::text,'UTF8')),'hex'),'blockers',coalesce(to_jsonb(blockers),'[]'::jsonb),'requiresConstructionReview',exists(select 1 from jsonb_array_elements(project_costs) where jsonb_array_length(value->'blockers')>0),'preservedBillableCostIds',coalesce(to_jsonb(billable_ids),'[]'::jsonb),'postingImplemented',false,'requiresCommitRevalidation',true,'locksHeldUntilTransactionEnd',true);
end $$;
revoke all on function public.lock_books_payroll_correction_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.lock_books_payroll_correction_context(uuid,uuid) to service_role;
