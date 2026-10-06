-- Monetary lineage is independent of documentary source revision numbers.
alter table public.books_payroll_correction_postings add column previous_posting_id uuid,add column sequence integer not null default 1 check(sequence>0);
alter table public.books_payroll_correction_postings drop constraint books_payroll_correction_postings_org_id_posting_id_key;
alter table public.books_payroll_correction_postings add constraint books_payroll_correction_posting_sequence unique(org_id,posting_id,sequence),add constraint books_payroll_correction_posting_predecessor unique(org_id,previous_posting_id),add constraint books_payroll_correction_posting_parent foreign key(org_id,previous_posting_id) references public.books_payroll_correction_postings(org_id,id),add constraint books_payroll_correction_posting_chain_shape check((sequence=1 and previous_posting_id is null) or(sequence>1 and previous_posting_id is not null));
create unique index books_payroll_correction_first_posting on public.books_payroll_correction_postings(org_id,posting_id) where previous_posting_id is null;
alter table public.books_payroll_correction_proposals add column posted_receipt_id uuid;
alter table public.books_payroll_correction_proposals add constraint books_payroll_correction_proposal_receipt foreign key(org_id,posted_receipt_id) references public.books_payroll_correction_postings(org_id,id) deferrable initially deferred;
drop index public.books_payroll_correction_proposal_active_idx;
create unique index books_payroll_correction_proposal_active_idx on public.books_payroll_correction_proposals(org_id,posting_id) where status<>'withdrawn' and posted_receipt_id is null;


create function public.books_payroll_correction_baseline(p_org uuid,p_root uuid,p_previous uuid,p_current boolean) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare root public.books_payroll_postings;parent public.books_payroll_imports;previous public.books_payroll_correction_postings;source public.books_payroll_correction_sources;baseline jsonb;run jsonb;accounts jsonb;journals jsonb:='[]';placements jsonb:='[]';date_floor date;
begin
 select * into root from public.books_payroll_postings where org_id=p_org and id=p_root;
 if root.id is null then raise exception 'Correction monetary lineage lacks original root';end if;
 perform public.assert_books_payroll_posting_receipt(to_jsonb(root));
 select * into parent from public.books_payroll_imports where org_id=p_org and id=root.payroll_import_id;
 select greatest((parent.run->>'accrual_date')::date,max((value->>'entryDate')::date)) into date_floor from jsonb_array_elements(root.result->'journals');
 run:=parent.run;accounts:=parent.reconciliation->'postingAccounts';
 if p_current then select * into previous from public.books_payroll_correction_postings where org_id=p_org and posting_id=p_root order by sequence desc limit 1;
 elsif p_previous is not null then select * into previous from public.books_payroll_correction_postings where org_id=p_org and posting_id=p_root and id=p_previous;
  if previous.id is null then raise exception 'Correction monetary predecessor is missing or belongs to another root';end if;
 end if;
 if previous.id is not null then
  perform public.assert_books_payroll_correction_posting(to_jsonb(previous));
  select * into source from public.books_payroll_correction_sources where org_id=p_org and id=previous.source_id;
  run:=jsonb_set(source.run,'{id}',to_jsonb(root.payroll_import_id));accounts:=source.account_snapshot;
  select greatest(date_floor,entry_date) into date_floor from public.journal_entries where org_id=p_org and id=(previous.result->>'journalId')::uuid;
  select coalesce(jsonb_agg(result->'journalId' order by sequence),'[]') into journals from public.books_payroll_correction_postings where org_id=p_org and posting_id=p_root and sequence<=previous.sequence;
  select coalesce(jsonb_agg(cost.value order by p.sequence desc,cost.ord),'[]') into placements from public.books_payroll_correction_postings p join public.books_payroll_correction_proposals q on q.org_id=p.org_id and q.id=p.proposal_id cross join lateral jsonb_array_elements(q.plan->'projectCosts') with ordinality cost(value,ord) where p.org_id=p_org and p.posting_id=p_root and p.sequence<=previous.sequence;
 end if;
 baseline:=jsonb_build_object('previousPostingId',previous.id,'previousSourceId',previous.source_id,'previousPlanDigest',previous.plan_digest,'sequence',coalesce(previous.sequence,0)+1);
 return jsonb_build_object('baseline',baseline,'run',run,'accounts',accounts,'journalIds',journals,'placements',placements,'dateFloor',date_floor);
end $$;
revoke all on function public.books_payroll_correction_baseline(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.books_payroll_correction_baseline(uuid,uuid,uuid,boolean) to service_role;


create or replace function public.reviewed_books_payroll_correction_delta(p_org uuid,p_source uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source public.books_payroll_correction_sources;posting public.books_payroll_postings;parent public.books_payroll_imports;baseline jsonb;
begin
 select * into source from public.books_payroll_correction_sources where org_id=p_org and id=p_source for share;
 if source.id is null or source.status<>'reviewed' or source.evidence_hash is distinct from public.books_payroll_correction_source_hash(to_jsonb(source)) then raise exception 'Provider correction requires immutable reviewed source';end if;
 perform public.validate_books_payroll_correction_source(p_org,p_source,source.posting_id,to_jsonb(source));
 select * into posting from public.books_payroll_postings where org_id=p_org and id=source.posting_id;
 select * into parent from public.books_payroll_imports where org_id=p_org and id=posting.payroll_import_id for share;
 baseline:=public.books_payroll_correction_baseline(p_org,posting.id,null,true);
 if (source.request->>'accountingDate')::date<(baseline->>'dateFloor')::date then raise exception 'Correction cannot precede latest actual monetary recognition';end if;
 return public.books_payroll_provider_delta(baseline->'run',baseline->'accounts',source.run,source.account_snapshot,source.request);
end $$;

create or replace function public.lock_books_payroll_correction_context(p_org_id uuid,p_source_id uuid)
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

create or replace function public.guard_books_payroll_correction_proposal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source public.books_payroll_correction_sources;posting public.books_payroll_postings;parent public.books_payroll_imports;original public.books_payroll_posting_proposals;payment public.books_payroll_payment_reviews;actor uuid;expected jsonb;
begin
 if tg_op='DELETE' then raise exception 'Correction proposal history cannot be deleted';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('payroll-import:'||new.org_id::text,0)) then raise exception 'Correction proposal history is changing; retry' using errcode='40001';end if;
 if tg_op='UPDATE' and new.posted_receipt_id is distinct from old.posted_receipt_id then
  if old.posted_receipt_id is not null or new.posted_receipt_id is null or old.status<>'reviewed' or to_jsonb(new)-'posted_receipt_id' is distinct from to_jsonb(old)-'posted_receipt_id' then raise exception 'Correction proposal posted ownership is immutable';end if;
  -- Receipt FK and deferred proof below must both succeed before commit. The
  -- money transaction claims this back-reference before inserting its receipt.
  return new;
 end if;
 if tg_op='INSERT' and new.posted_receipt_id is not null then raise exception 'Correction proposal cannot start with posted authority';end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] then raise exception 'Correction proposal evidence and preparation are immutable';end if;
  if not((old.status='draft' and new.status='reviewed') or(old.status in('draft','reviewed') and new.status='withdrawn' and new.reviewed_by is not distinct from old.reviewed_by and new.reviewed_at is not distinct from old.reviewed_at and new.review_notes is not distinct from old.review_notes)) then raise exception 'Invalid correction proposal transition';end if;
 else
  if new.status<>'draft' or new.reviewed_by is not null or new.reviewed_at is not null or new.review_notes is not null or new.withdrawn_by is not null or new.withdrawn_at is not null or new.withdrawal_reason is not null then raise exception 'Correction proposal must start as unreviewed draft';end if;
 end if;
 actor:=case new.status when 'reviewed' then new.reviewed_by when 'withdrawn' then new.withdrawn_by else new.prepared_by end;
 perform 1 from public.memberships where org_id=new.org_id and user_id=actor and status='active' for share;
 if not found then raise exception 'Correction proposal requires active organization actor';end if;
 if new.status='withdrawn' then return new;end if;
 expected:=public.lock_books_payroll_correction_context(new.org_id,new.source_id)-'locksHeldUntilTransactionEnd';
 if new.plan is distinct from expected or new.posting_id::text is distinct from expected->>'originalPostingId' then raise exception 'Correction proposal differs from independently computed current context';end if;
 select * into source from public.books_payroll_correction_sources where org_id=new.org_id and id=new.source_id for share;
 select * into posting from public.books_payroll_postings where org_id=new.org_id and id=new.posting_id;
 select * into parent from public.books_payroll_imports where org_id=new.org_id and id=posting.payroll_import_id for share;
 select * into original from public.books_payroll_posting_proposals where org_id=new.org_id and id=posting.proposal_id for share;
 select * into payment from public.books_payroll_payment_reviews where org_id=new.org_id and id=original.payment_review_id for share;
 if new.status='reviewed' then
  if new.reviewed_by=new.prepared_by or new.reviewed_by=source.prepared_by or new.reviewed_by=parent.prepared_by or new.reviewed_by=original.prepared_by or new.reviewed_by=payment.prepared_by then raise exception 'Correction monetary review must be separate from all preparers';end if;
  if new.plan->'blockers'<>'[]'::jsonb or new.plan->'requiresConstructionReview' is distinct from 'false'::jsonb then raise exception 'Correction proposal has unresolved business or accounting decisions';end if;
 end if;
 return new;
end $$;

create or replace function public.assert_books_payroll_correction_posting(p_receipt jsonb) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proposal public.books_payroll_correction_proposals;source public.books_payroll_correction_sources;root public.books_payroll_postings;parent public.books_payroll_imports;baseline_data jsonb;previous public.books_payroll_correction_postings;
 entry public.journal_entries;fact public.accounting_facts;job public.job_cost_entries;draft jsonb;line jsonb;account jsonb;cost jsonb;link jsonb;expected jsonb;actual jsonb;links jsonb:='[]';i integer:=0;j integer:=0;
 org uuid:=(p_receipt->>'org_id')::uuid;receipt_id uuid:=(p_receipt->>'id')::uuid;result jsonb:=p_receipt->'result';
begin
 select * into proposal from public.books_payroll_correction_proposals where org_id=org and id=(p_receipt->>'proposal_id')::uuid;
 select * into source from public.books_payroll_correction_sources where org_id=org and id=(p_receipt->>'source_id')::uuid;
 select * into root from public.books_payroll_postings where org_id=org and id=(p_receipt->>'posting_id')::uuid;
 if proposal.id is null or source.id is null or root.id is null or proposal.status<>'reviewed' or source.status<>'reviewed' or proposal.source_id<>source.id or proposal.posting_id<>root.id or source.posting_id<>root.id or proposal.plan_digest is distinct from p_receipt->>'plan_digest' or proposal.plan->'blockers'<>'[]'::jsonb or proposal.plan->'requiresConstructionReview' is distinct from 'false'::jsonb then raise exception 'Correction receipt lacks reviewed source and monetary approval';end if;
 perform public.assert_books_payroll_posting_receipt(to_jsonb(root));
 select * into parent from public.books_payroll_imports where org_id=org and id=root.payroll_import_id;
 if p_receipt->>'previous_posting_id' is not null then
  select * into previous from public.books_payroll_correction_postings where org_id=org and id=(p_receipt->>'previous_posting_id')::uuid;
  if previous.id is null or previous.id=receipt_id or previous.posting_id<>root.id or previous.source_id=source.id or previous.sequence is distinct from (p_receipt->>'sequence')::integer-1 then raise exception 'Correction monetary ancestry is missing, branched or cyclic';end if;
 end if;
 baseline_data:=public.books_payroll_correction_baseline(org,root.id,(p_receipt->>'previous_posting_id')::uuid,false);
 if coalesce((p_receipt->>'sequence')::integer,1) is distinct from (baseline_data#>>'{baseline,sequence}')::integer then raise exception 'Correction receipt monetary sequence differs';end if;
 if proposal.plan?'baseline' and proposal.plan->'baseline' is distinct from baseline_data->'baseline' then raise exception 'Correction receipt monetary predecessor differs';end if;
 if result->'version'='2'::jsonb then
  if proposal.posted_receipt_id is distinct from receipt_id then raise exception 'Correction receipt proposal back-reference differs';end if;
 elsif result->'version'='1'::jsonb then
  if coalesce((p_receipt->>'sequence')::integer,1)<>1 or p_receipt->>'previous_posting_id' is not null or proposal.plan?'baseline' then raise exception 'Legacy correction cannot hide monetary lineage';end if;
 else raise exception 'Unsupported correction receipt version';end if;
 if (source.request->>'accountingDate')::date<(baseline_data->>'dateFloor')::date then raise exception 'Correction receipt precedes monetary predecessor';end if;
 if source.evidence_hash is distinct from public.books_payroll_correction_source_hash(to_jsonb(source)) or proposal.plan->'math' is distinct from public.books_payroll_provider_delta(baseline_data->'run',baseline_data->'accounts',source.run,source.account_snapshot,source.request) then raise exception 'Correction receipt provider arithmetic differs';end if;
 draft:=proposal.plan#>'{math,journalDraft}';
 if draft is null or draft='null'::jsonb then raise exception 'Correction receipt has no accounting change';end if;
 select * into entry from public.journal_entries where org_id=org and id=(result->>'journalId')::uuid;
 select * into fact from public.accounting_facts where org_id=org and id=(result->>'factId')::uuid;
 if entry.id is null or fact.id is null or entry.fact_id is distinct from fact.id or entry.status<>'posted' or entry.source_type<>'payroll_correction' or entry.source_id<>source.id or entry.entry_date::text is distinct from draft->>'entryDate' or entry.entry_kind is distinct from draft->>'entryKind' or entry.memo is distinct from draft->>'memo' or entry.posting_key is distinct from draft->>'postingKey' or entry.policy_version is distinct from (draft->>'policyVersion')::integer or entry.projection_version is distinct from (draft->>'projectionVersion')::integer or entry.reversal_of_entry_id is not null or entry.created_by::text is distinct from p_receipt->>'posted_by' or entry.posted_by::text is distinct from p_receipt->>'posted_by' or entry.posted_at is distinct from (p_receipt->>'posted_at')::timestamptz then raise exception 'Correction actual journal differs from approved draft';end if;
 expected:=jsonb_build_object('payroll_correction_posting_id',receipt_id,'proposal_id',proposal.id,'plan_digest',proposal.plan_digest,'source_hash',source.evidence_hash,'original_posting_id',root.id,'draft',draft);
 if fact.source_type<>'payroll_correction' or fact.source_id<>source.id or fact.source_version<>1 or fact.fact_kind<>'payroll_correction' or fact.accounting_date is distinct from entry.entry_date or fact.payload is distinct from expected or fact.payload_hash is distinct from encode(sha256(convert_to(expected::text,'UTF8')),'hex') or fact.idempotency_key is distinct from draft->>'postingKey' or fact.policy_version is distinct from (draft->>'policyVersion')::integer or fact.created_by::text is distinct from p_receipt->>'posted_by' or fact.occurred_at is distinct from (p_receipt->>'posted_at')::timestamptz then raise exception 'Correction actual accounting fact differs';end if;
 expected:='[]';
 for line in select value from jsonb_array_elements(draft->'lines') loop
  i:=i+1;select value into account from jsonb_array_elements(proposal.plan#>'{context,gl_accounts}') where value->>'id'=line#>>'{dimensions,books_correction_account_id}';
  if account is null or account->>'org_id'<>org::text or account->>'code'<>line->>'accountCode' then raise exception 'Correction approved account identity differs';end if;
  expected:=expected||jsonb_build_array(jsonb_build_object('line_no',i,'account_id',account->>'id','project_id',line->>'projectId','company_id',null,'description',line->>'description','debit_cents',(line->>'debitCents')::bigint,'credit_cents',(line->>'creditCents')::bigint,'dimensions',line->'dimensions'||jsonb_build_object('payroll_correction_posting_id',receipt_id,'payroll_correction_proposal_id',proposal.id,'books_account_classification',jsonb_build_object('version',1,'account_id',account->>'id','code',account->>'code','account_type',account->>'account_type','subtype',account->>'subtype'))));
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('line_no',line_no,'account_id',account_id,'project_id',project_id,'company_id',company_id,'description',description,'debit_cents',debit_cents,'credit_cents',credit_cents,'dimensions',dimensions) order by line_no),'[]') into actual from public.journal_lines where org_id=org and entry_id=entry.id;
 if actual is distinct from expected then raise exception 'Correction actual journal lines differ';end if;
 if (select count(*) from public.journal_entries where org_id=org and source_type='payroll_correction' and source_id=source.id)<>1 or(select count(*) from public.accounting_facts where org_id=org and source_type='payroll_correction' and source_id=source.id)<>1 then raise exception 'Correction journal/fact inventory differs';end if;
 for cost in select value from jsonb_array_elements(proposal.plan->'projectCosts') loop
  link:=result->'jobCosts'->j;j:=j+1;
  select * into job from public.job_cost_entries where org_id=org and id=(link->>'jobCostId')::uuid;
  expected:=jsonb_build_object('payroll_correction_posting_id',receipt_id,'payroll_correction_proposal_id',proposal.id,'payroll_correction_source_id',source.id,'payroll_original_posting_id',root.id,'payroll_run_id',draft#>>'{lines,0,dimensions,payroll_run_id}','payroll_worker_id',cost->>'workerId','payroll_allocation_id',cost->>'allocationId','payroll_component',cost->>'component','cost_account_id',cost->>'accountId','cost_account_code',cost->>'accountCode','original_job_cost_ids',cost->'sourceJobCostIds','billing_action','preserve_time_and_materials_rates');
  if job.id is null or job.source_type<>'payroll_correction' or job.source_id is distinct from job.id::text or job.status<>'posted' or job.project_id::text is distinct from cost->>'projectId' or job.cost_code_id::text is distinct from cost->>'costCodeId' or job.budget_line_id::text is distinct from cost->>'budgetLineId' or job.gmp_classification is distinct from cost->>'gmpClassification' or job.incurred_on::text is distinct from cost->>'incurredOn' or job.cost_cents is distinct from (cost->>'costCents')::integer or job.is_billable is distinct from false or job.billable_cost_id is not null or job.invoice_id is not null or job.metadata is distinct from expected then raise exception 'Correction actual project cost differs';end if;
  links:=links||jsonb_build_array(cost||jsonb_build_object('jobCostId',job.id));
 end loop;
 if j<>(select count(*) from public.job_cost_entries where org_id=org and source_type='payroll_correction' and metadata->>'payroll_correction_posting_id'=receipt_id::text) then raise exception 'Correction project cost inventory differs';end if;
 expected:=jsonb_build_object('version',1,'postingId',receipt_id,'proposalId',proposal.id,'sourceId',source.id,'originalPostingId',root.id,'planDigest',proposal.plan_digest,'journalId',entry.id,'factId',fact.id,'jobCosts',links,'billingPreserved',proposal.plan->'preservedBillableCostIds');
 if result->'version'='2'::jsonb then expected:=expected||jsonb_build_object('version',2,'previousPostingId',baseline_data#>'{baseline,previousPostingId}','sequence',baseline_data#>'{baseline,sequence}');end if;
 if result is distinct from expected then raise exception 'Correction posting receipt result differs';end if;
 return true;
end $$;

create function public.guard_books_payroll_correction_back_reference() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare receipt public.books_payroll_correction_postings;
begin
 if new.posted_receipt_id is not null then
  select * into receipt from public.books_payroll_correction_postings where org_id=new.org_id and id=new.posted_receipt_id;
  if receipt.id is null or receipt.proposal_id<>new.id or receipt.source_id<>new.source_id or receipt.posting_id<>new.posting_id or receipt.plan_digest<>new.plan_digest or new.status<>'reviewed' then raise exception 'Correction proposal lacks matching actual monetary receipt';end if;
  perform public.assert_books_payroll_correction_posting(to_jsonb(receipt));
 end if;return new;
end $$;
create constraint trigger books_payroll_correction_posted_back_reference after insert or update on public.books_payroll_correction_proposals deferrable initially deferred for each row execute function public.guard_books_payroll_correction_back_reference();
revoke all on function public.guard_books_payroll_correction_back_reference() from public,anon,authenticated;
-- Existing schema-16 first receipts already contain proven immutable money.
-- Claim their proposal reservation through the same deferred ownership proof.
update public.books_payroll_correction_proposals q set posted_receipt_id=p.id from public.books_payroll_correction_postings p where p.org_id=q.org_id and p.proposal_id=q.id;


create or replace function public.post_books_payroll_correction_proposal(p_org_id uuid,p_id uuid,p_proposal_id uuid,p_actor_id uuid,p_digest text,p_notes text,p_key text) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_payroll_correction_postings;proposal public.books_payroll_correction_proposals;source public.books_payroll_correction_sources;context jsonb;draft jsonb;payload jsonb;line jsonb;account public.gl_accounts;cost jsonb;lines jsonb:='[]';costs jsonb:='[]';entry_id uuid;fact_id uuid;cost_id uuid;result jsonb;i integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' for share;
 if not found or coalesce(length(trim(p_notes)),0) not between 10 and 4000 or coalesce(length(trim(p_key)),0) not between 10 and 200 then raise exception 'Correction posting requires active actor, notes and retry identity';end if;
 select * into previous from public.books_payroll_correction_postings where org_id=p_org_id and idempotency_key=p_key;
 if found then
  if previous.id is distinct from p_id or previous.proposal_id is distinct from p_proposal_id or previous.posted_by is distinct from p_actor_id or previous.plan_digest is distinct from p_digest or previous.posting_notes is distinct from p_notes then raise exception 'Correction posting retry has different intent';end if;
  perform public.assert_books_payroll_correction_posting(to_jsonb(previous));return previous.result;
 end if;
 select * into proposal from public.books_payroll_correction_proposals where org_id=p_org_id and id=p_proposal_id for share;
 if proposal.id is null or proposal.status<>'reviewed' or proposal.plan_digest is distinct from p_digest then raise exception 'Correction posting requires exact reviewed monetary proposal';end if;
 if exists(select 1 from public.books_payroll_correction_postings where org_id=p_org_id and(proposal_id=proposal.id or source_id=proposal.source_id or id=p_id)) then raise exception 'Correction already posted with a different retry identity';end if;
 context:=public.lock_books_payroll_correction_context(p_org_id,proposal.source_id)-'locksHeldUntilTransactionEnd';
 if context is distinct from proposal.plan or context->'blockers'<>'[]'::jsonb or context->'requiresConstructionReview' is distinct from 'false'::jsonb then raise exception 'Correction current evidence changed or decisions remain unresolved';end if;
 select * into source from public.books_payroll_correction_sources where org_id=p_org_id and id=proposal.source_id;
 draft:=context#>'{math,journalDraft}';
 payload:=jsonb_build_object('payroll_correction_posting_id',p_id,'proposal_id',proposal.id,'plan_digest',proposal.plan_digest,'source_hash',source.evidence_hash,'original_posting_id',proposal.posting_id,'draft',draft);
 insert into public.accounting_facts(org_id,source_type,source_id,source_version,fact_kind,occurred_at,accounting_date,payload,payload_hash,policy_version,idempotency_key,created_by)
 values(p_org_id,'payroll_correction',source.id,1,'payroll_correction',now(),(draft->>'entryDate')::date,payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),(draft->>'policyVersion')::integer,draft->>'postingKey',p_actor_id) returning id into fact_id;
 for line in select value from jsonb_array_elements(draft->'lines') loop
  i:=i+1;select * into account from public.gl_accounts where org_id=p_org_id and id=(line#>>'{dimensions,books_correction_account_id}')::uuid and active;
  if account.id is null or account.code is distinct from line->>'accountCode' then raise exception 'Correction approved account changed';end if;
  lines:=lines||jsonb_build_array(jsonb_build_object('line_no',i,'account_id',account.id,'project_id',line->>'projectId','description',line->>'description','debit_cents',(line->>'debitCents')::bigint,'credit_cents',(line->>'creditCents')::bigint,'dimensions',line->'dimensions'||jsonb_build_object('payroll_correction_posting_id',p_id,'payroll_correction_proposal_id',proposal.id,'books_account_classification',jsonb_build_object('version',1,'account_id',account.id,'code',account.code,'account_type',account.account_type,'subtype',account.subtype))));
 end loop;
 entry_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('fact_id',fact_id,'entry_date',draft->>'entryDate','entry_kind',draft->>'entryKind','memo',draft->>'memo','posting_key',draft->>'postingKey','projection_version',draft->'projectionVersion','policy_version',draft->'policyVersion','source_type','payroll_correction','source_id',source.id,'created_by',p_actor_id),lines);
 for cost in select value from jsonb_array_elements(context->'projectCosts') loop
  cost_id:=gen_random_uuid();
  insert into public.job_cost_entries(id,org_id,project_id,cost_code_id,budget_line_id,gmp_classification,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata)
  values(cost_id,p_org_id,(cost->>'projectId')::uuid,(cost->>'costCodeId')::uuid,(cost->>'budgetLineId')::uuid,cost->>'gmpClassification','payroll_correction',cost_id,(cost->>'incurredOn')::date,(cost->>'costCents')::integer,'posted',false,jsonb_build_object('payroll_correction_posting_id',p_id,'payroll_correction_proposal_id',proposal.id,'payroll_correction_source_id',source.id,'payroll_original_posting_id',proposal.posting_id,'payroll_run_id',draft#>>'{lines,0,dimensions,payroll_run_id}','payroll_worker_id',cost->>'workerId','payroll_allocation_id',cost->>'allocationId','payroll_component',cost->>'component','cost_account_id',cost->>'accountId','cost_account_code',cost->>'accountCode','original_job_cost_ids',cost->'sourceJobCostIds','billing_action','preserve_time_and_materials_rates'));
  costs:=costs||jsonb_build_array(cost||jsonb_build_object('jobCostId',cost_id));
 end loop;
 result:=jsonb_build_object('version',2,'previousPostingId',context#>'{baseline,previousPostingId}','sequence',context#>'{baseline,sequence}','postingId',p_id,'proposalId',proposal.id,'sourceId',source.id,'originalPostingId',proposal.posting_id,'planDigest',p_digest,'journalId',entry_id,'factId',fact_id,'jobCosts',costs,'billingPreserved',context->'preservedBillableCostIds');
 update public.books_payroll_correction_proposals set posted_receipt_id=p_id where org_id=p_org_id and id=proposal.id;
 insert into public.books_payroll_correction_postings(id,org_id,proposal_id,source_id,posting_id,plan_digest,posted_by,posting_notes,idempotency_key,result,previous_posting_id,sequence) values(p_id,p_org_id,proposal.id,source.id,proposal.posting_id,p_digest,p_actor_id,p_notes,p_key,result,(context#>>'{baseline,previousPostingId}')::uuid,(context#>>'{baseline,sequence}')::integer);
 return result;
end $$;

create or replace function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  if p_org_id is null then raise exception 'Export organization is required'; end if;
  foreach v_table in array array[
    'closings',
    'closing_checklist_items',
    'lot_takedowns',
    'lot_reservations',
    'budgets',
    'budget_lines',
    'commitments',
    'commitment_lines',
    'change_orders',
    'file_links',
    'project_financial_settings',
    'divisions',
    'communities',
    'community_phases',
    'lots',
    'contracts',
    'cost_codes',
    'time_entries',
    'warranty_requests',
    'warranty_service_visits',
    'warranty_backcharges',
    'org_funding_sources',
    'disbursements',
    'payment_runs',
    'payment_run_items',
    'payment_run_fee_charges',
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
    'books_tax_adjustment_workpapers',
    'books_payroll_imports',
    'books_payroll_payment_reviews',
    'books_payroll_posting_proposals','books_payroll_postings','books_payroll_labor_ownership',
    'books_payroll_correction_sources','books_payroll_correction_proposals',
    'books_payroll_correction_postings',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_settings',
    'accounting_policies',
    'accounting_account_mappings',
    'gl_accounts',
    'books_projection_receipts',
    'accounting_facts',
    'journal_entries',
    'journal_lines',
    'accounting_periods',
    'accounting_reconciliation_runs',
    'accounting_reconciliation_items',
    'poc_snapshots',
    'books_comparison_runs',
    'books_comparison_items',
    'opening_balance_batches',
    'opening_balance_lines',
    'opening_balance_approvals',
    'bank_accounts',
    'bank_transactions',
    'bank_transaction_details',
    'bank_receipts',
    'bank_transaction_revisions',
    'bank_transaction_matches',
    'bank_reconciliations',
    'bank_reconciliation_items',
    'bank_rules',
    'coding_rules',
    'books_debt_instruments',
    'books_debt_events',
    'books_fixed_assets',
    'books_fixed_asset_events',
    'books_tax_jurisdictions',
    'books_tax_filings',
    'books_greenfield_launches',
    'books_journal_proposals',
    'books_cutover_runs',
    'books_cutover_approvals',
    'books_close_items',
    'recurring_posting_templates',
    'recurring_posting_lines',
    'financial_statement_snapshots',
    'tax_policy_versions',
    'companies',
    'contacts',
    'projects',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'vendor_bills',
    'bill_lines',
    'project_expenses',
    'project_expense_lines',
    'job_cost_entries',
    'billable_costs',
    'retainage',
    'doc_versions',
    'files',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;

