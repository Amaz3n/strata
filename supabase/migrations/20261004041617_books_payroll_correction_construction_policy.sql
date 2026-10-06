-- Extend new approvals with current commercial and closeout evidence. Historical
-- version-one approvals retain their original meaning; existing monetary retries
-- prove frozen receipts before consulting this current-context function.
create function public.books_payroll_correction_base_context(p_org_id uuid,p_source_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source public.books_payroll_correction_sources;posting public.books_payroll_postings;parent public.books_payroll_imports;proposal public.books_payroll_posting_proposals;
 math jsonb;context jsonb;baseline_data jsonb;previous_placement jsonb;root_worker jsonb;project_costs jsonb:='[]';workers jsonb:='[]';blockers text[]:='{}';cost_blockers text[];project_ids uuid[];code_ids uuid[];budget_ids uuid[];billable_ids uuid[];journal_ids uuid[];additional_ids uuid[];
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
 baseline_data:=public.books_payroll_correction_baseline(p_org_id,posting.id,null,true);
 select * into parent from public.books_payroll_imports where org_id=p_org_id and id=posting.payroll_import_id for share;
 select * into proposal from public.books_payroll_posting_proposals where org_id=p_org_id and id=posting.proposal_id for share;
 select array_agg(distinct id order by id) into project_ids from(
  select (value->>'projectId')::uuid id from jsonb_array_elements(proposal.plan->'allocations')
  union select (a.value->>'project_id')::uuid from jsonb_array_elements(baseline_data#>'{run,employees}') w cross join lateral jsonb_array_elements(w.value->'allocations') a
  union select (a.value->>'project_id')::uuid from jsonb_array_elements(source.run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a
 ) scope where id is not null;
 select array_agg(distinct id order by id) into code_ids from(
  select (value->>'costCodeId')::uuid id from jsonb_array_elements(proposal.plan->'allocations')
  union select (a.value->>'cost_code_id')::uuid from jsonb_array_elements(baseline_data#>'{run,employees}') w cross join lateral jsonb_array_elements(w.value->'allocations') a
  union select (a.value->>'cost_code_id')::uuid from jsonb_array_elements(source.run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a
 ) scope where id is not null;
 select array_agg(distinct id order by id) into budget_ids from(select (value#>>'{construction,budgetLineId}')::uuid id from jsonb_array_elements(proposal.plan->'allocations') union select (value->>'budgetLineId')::uuid from jsonb_array_elements(baseline_data->'placements')) scope where id is not null;
 select array_agg(distinct value::uuid order by value::uuid) into billable_ids from(
  select jsonb_array_elements_text(value#>'{construction,billing,originalBillableCostIds}') value from jsonb_array_elements(proposal.plan->'allocations')
  union select jsonb_array_elements_text(value->'preservedBillableCostIds') from jsonb_array_elements(baseline_data->'placements')
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
 select array_agg(id order by id) into additional_ids from unnest(journal_ids) id where not exists(select 1 from jsonb_array_elements(posting.result->'journals') j where (j.value->>'journalId')::uuid=id) and not exists(select 1 from jsonb_array_elements(baseline_data->'journalIds') j where (j.value#>>'{}')::uuid=id) and not exists(select 1 from jsonb_array_elements(parent.reconciliation#>'{workflowEvidence,sourceTables,journal_entries}') j where (j.value->>'id')::uuid=id);
 if coalesce(array_length(additional_ids,1),0)>0 then blockers:=array_append(blockers,'review_additional_liability_attribution');end if;
 for line in select value from jsonb_array_elements(coalesce(math#>'{journalDraft,lines}','[]'::jsonb)) where value->>'projectId' is not null and value->>'accountCode' not in('2200','2230') loop
  allocation:=null;construction:=null;cost_blockers:='{}';
  select value into allocation from jsonb_array_elements(proposal.plan->'allocations') where value->>'allocationId'=line#>>'{dimensions,payroll_allocation_id}' and value->>'workerId'=line#>>'{dimensions,payroll_worker_id}' and value->>'projectId'=line->>'projectId' and value->>'costCodeId' is not distinct from line#>>'{dimensions,cost_code_id}' and value->>'accountCode'=line->>'accountCode';
  construction:=allocation->'construction';
  select value into previous_placement from jsonb_array_elements(baseline_data->'placements') where value->>'allocationId'=line#>>'{dimensions,payroll_allocation_id}' and value->>'workerId'=line#>>'{dimensions,payroll_worker_id}' and value->>'projectId'=line->>'projectId' and value->>'costCodeId' is not distinct from line#>>'{dimensions,cost_code_id}' and value->>'accountId'=line#>>'{dimensions,books_correction_account_id}' limit 1;
  if previous_placement is not null then construction:=jsonb_build_object('budgetLineId',previous_placement->'budgetLineId','gmpClassification',previous_placement->'gmpClassification','sourceJobCostIds',previous_placement->'sourceJobCostIds','billing',jsonb_build_object('action','preserve_time_and_materials_rates','originalBillableCostIds',previous_placement->'preservedBillableCostIds'));end if;
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
 for worker_id in select worker from(select distinct value->>'worker_id' worker from jsonb_array_elements((parent.run->'employees')||(baseline_data#>'{run,employees}')||(source.run->'employees'))) scope order by worker collate "C" loop
  select value into root_worker from jsonb_array_elements(parent.run->'employees') where value->>'worker_id'=worker_id;
  select value into before_worker from jsonb_array_elements(baseline_data#>'{run,employees}') where value->>'worker_id'=worker_id;
  select value into after_worker from jsonb_array_elements(source.run->'employees') where value->>'worker_id'=worker_id;
  worker_delta:='{}';worker_remaining:='{}';
  for key,field in select * from(values('netPayCents','net_cents'),('employeeTaxesCents','employee_taxes_cents'),('employeeDeductionsCents','employee_deductions_cents'),('employerTaxesCents','employer_taxes_cents'),('employerBenefitsCents','employer_benefits_cents')) mapping(label,field) loop
   amount:=coalesce((after_worker->>field)::numeric,0)-coalesce((before_worker->>field)::numeric,0);
   worker_delta:=worker_delta||jsonb_build_object(key,amount);
   select coalesce((after_worker->>field)::numeric,0)-coalesce((root_worker->>field)::numeric,0)+coalesce(sum((value->'outstanding'->>key)::numeric),0) into amount from jsonb_array_elements(proposal.plan->'allocations') where value->>'workerId'=worker_id;
   if abs(amount)>9007199254740991 then raise exception 'Correction worker liability exceeds exact cents';end if;
   worker_remaining:=worker_remaining||jsonb_build_object(key,amount);
   if amount<0 then blockers:=array_append(blockers,'review_employee_or_provider_overpayment_recovery');end if;
  end loop;
  workers:=workers||jsonb_build_array(jsonb_build_object('workerId',worker_id,'liabilityDelta',worker_delta,'remainingBeforeAdditionalAttribution',worker_remaining));
 end loop;
 remaining:='{}';
 for key,field in select * from(values('netPayCents','net_cents'),('employeeTaxesCents','employee_taxes_cents'),('employeeDeductionsCents','employee_deductions_cents'),('employerTaxesCents','employer_taxes_cents'),('employerBenefitsCents','employer_benefits_cents')) mapping(label,field) loop
  amount:=(proposal.plan->'outstanding'->>key)::numeric+(source.run->'controls'->>field)::numeric-(parent.run->'controls'->>field)::numeric;
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
 context:=public.books_payroll_context_canonical(context);
 select array_agg(value order by value collate "C") into blockers from(select distinct value from unnest(blockers) value) reasons;
 return jsonb_build_object('version',1,'baseline',baseline_data->'baseline','orgId',p_org_id,'sourceId',source.id,'sourceHash',source.evidence_hash,'originalPostingId',posting.id,'originalPlanDigest',posting.plan_digest,'request',source.request,'math',math,'projectCosts',project_costs,'workers',workers,'remainingBeforeAdditionalAttribution',remaining,'additionalLiabilityJournalIds',coalesce(to_jsonb(additional_ids),'[]'::jsonb),'context',context,'contextHash',encode(sha256(convert_to(context::text,'UTF8')),'hex'),'blockers',coalesce(to_jsonb(blockers),'[]'::jsonb),'requiresConstructionReview',exists(select 1 from jsonb_array_elements(project_costs) where jsonb_array_length(value->'blockers')>0),'preservedBillableCostIds',coalesce(to_jsonb(billable_ids),'[]'::jsonb),'postingImplemented',false,'requiresCommitRevalidation',true,'locksHeldUntilTransactionEnd',true);
end $$;

revoke all on function public.books_payroll_correction_base_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.books_payroll_correction_base_context(uuid,uuid) to service_role;

-- Phantom settings/contracts/closings must participate in the same source fence
-- as row updates. This invoker trigger reads no private payroll information.
create trigger books_payroll_source_fence before insert or update or delete on public.projects for each row execute function public.books_lock_payroll_source_write();
create trigger books_payroll_source_fence before insert or update or delete on public.project_financial_settings for each row execute function public.books_lock_payroll_source_write();
create trigger books_payroll_source_fence before insert or update or delete on public.contracts for each row execute function public.books_lock_payroll_source_write();
create trigger books_payroll_source_fence before insert or update or delete on public.closings for each row execute function public.books_lock_payroll_source_write();

create or replace function public.lock_books_payroll_correction_context(p_org_id uuid,p_source_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare result jsonb;context jsonb;project_ids uuid[];leg jsonb;project jsonb;settings jsonb;contract jsonb;cost_blockers jsonb;project_costs jsonb:='[]';settings_count integer;contract_count integer;
begin
 result:=public.books_payroll_correction_base_context(p_org_id,p_source_id);
 context:=result->'context';
 select array_agg((value->>'id')::uuid order by value->>'id') into project_ids from jsonb_array_elements(context->'projects');
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=any(project_ids) order by id for share;
 perform 1 from public.contracts where org_id=p_org_id and project_id=any(project_ids) order by id for share;
 perform 1 from public.closings where org_id=p_org_id and project_id=any(project_ids) order by id for share;
 context:=context||jsonb_build_object(
  'project_financial_settings',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.project_financial_settings r where org_id=p_org_id and project_id=any(project_ids)),
  'contracts',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.contracts r where org_id=p_org_id and project_id=any(project_ids)),
  'closings',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.closings r where org_id=p_org_id and project_id=any(project_ids)));
 context:=public.books_payroll_context_canonical(context);
 for leg in select value from jsonb_array_elements(result->'projectCosts') loop
  cost_blockers:=leg->'blockers';
  select value into project from jsonb_array_elements(context->'projects') where value->>'id'=leg->>'projectId';
  if project->>'status' in('completed','cancelled') then cost_blockers:=cost_blockers||jsonb_build_array('review_late_project_cost_policy');
  elsif project->>'status' is null or project->>'status' not in('planning','bidding','active','on_hold') then cost_blockers:=cost_blockers||jsonb_build_array('review_unknown_project_status');end if;
  if exists(select 1 from jsonb_array_elements(context->'closings') where value->>'project_id'=leg->>'projectId' and value->>'status'='closed') then cost_blockers:=cost_blockers||jsonb_build_array('review_closed_home_cost_and_customer_settlement');end if;
  select count(*) into settings_count from jsonb_array_elements(context->'project_financial_settings') where value->>'project_id'=leg->>'projectId';
  select value into settings from jsonb_array_elements(context->'project_financial_settings') where value->>'project_id'=leg->>'projectId' limit 1;
  select count(*) into contract_count from jsonb_array_elements(context->'contracts') where value->>'project_id'=leg->>'projectId' and value->>'status'='active';
  select value into contract from jsonb_array_elements(context->'contracts') where value->>'project_id'=leg->>'projectId' and value->>'status'='active' limit 1;
  if settings_count<>1 or settings->>'setup_completed_at' is null then cost_blockers:=cost_blockers||jsonb_build_array('review_incomplete_project_financial_setup');end if;
  if contract_count<>1 then cost_blockers:=cost_blockers||jsonb_build_array('review_missing_or_ambiguous_active_contract');end if;
  if settings_count=1 and settings->>'billing_model' is distinct from 'time_and_materials' then cost_blockers:=cost_blockers||jsonb_build_array('review_current_customer_billing_policy');end if;
  if contract_count=1 and contract->>'contract_type' is distinct from 'time_materials' then cost_blockers:=cost_blockers||jsonb_build_array('review_current_customer_billing_policy');end if;
  -- Keep the independently reconstructed leg ordering and duplicate semantics.
  project_costs:=project_costs||jsonb_build_array(leg||jsonb_build_object('blockers',cost_blockers));
 end loop;
 return result||jsonb_build_object('version',2,'projectCosts',project_costs,'context',context,'contextHash',encode(sha256(convert_to(context::text,'UTF8')),'hex'),'requiresConstructionReview',exists(select 1 from jsonb_array_elements(project_costs) where jsonb_array_length(value->'blockers')>0));
end $$;
revoke all on function public.lock_books_payroll_correction_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.lock_books_payroll_correction_context(uuid,uuid) to service_role;
