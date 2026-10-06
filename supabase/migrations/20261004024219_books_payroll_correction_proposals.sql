-- JSONB numeric scale is formatting, not a changed budget or customer rate.
-- Normalize it before hashing so HTTP transport and restore cannot invalidate
-- an otherwise identical review merely by removing trailing decimal zeros.
create function public.books_payroll_context_canonical(p_value jsonb) returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 case jsonb_typeof(p_value)
 when 'number' then return to_jsonb(trim_scale((p_value#>>'{}')::numeric));
 when 'array' then select coalesce(jsonb_agg(public.books_payroll_context_canonical(value) order by ord),'[]'::jsonb) into result from jsonb_array_elements(p_value) with ordinality rows(value,ord);return result;
 when 'object' then select coalesce(jsonb_object_agg(key,public.books_payroll_context_canonical(value)),'{}'::jsonb) into result from jsonb_each(p_value);return result;
 else return p_value;end case;
end $$;
revoke all on function public.books_payroll_context_canonical(jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_context_canonical(jsonb) to service_role;

create or replace function public.lock_books_payroll_correction_context(p_org_id uuid,p_source_id uuid)
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
 context:=public.books_payroll_context_canonical(context);
 select array_agg(value order by value collate "C") into blockers from(select distinct value from unnest(blockers) value) reasons;
 return jsonb_build_object('version',1,'orgId',p_org_id,'sourceId',source.id,'sourceHash',source.evidence_hash,'originalPostingId',posting.id,'originalPlanDigest',posting.plan_digest,'request',source.request,'math',math,'projectCosts',project_costs,'workers',workers,'remainingBeforeAdditionalAttribution',remaining,'additionalLiabilityJournalIds',coalesce(to_jsonb(additional_ids),'[]'::jsonb),'context',context,'contextHash',encode(sha256(convert_to(context::text,'UTF8')),'hex'),'blockers',coalesce(to_jsonb(blockers),'[]'::jsonb),'requiresConstructionReview',exists(select 1 from jsonb_array_elements(project_costs) where jsonb_array_length(value->'blockers')>0),'preservedBillableCostIds',coalesce(to_jsonb(billable_ids),'[]'::jsonb),'postingImplemented',false,'requiresCommitRevalidation',true,'locksHeldUntilTransactionEnd',true);
end $$;

-- Reviewed corrective monetary proposal; source review alone is not authority.
-- Store canonical JSON text as well as JSONB so offline recovery preserves exact
-- numeric spelling in frozen construction evidence and can reproduce DB hashes.
create table public.books_payroll_correction_proposals(
 id uuid primary key,org_id uuid not null references public.orgs(id),source_id uuid not null,posting_id uuid not null,
 status text not null default 'draft' check(status in('draft','reviewed','withdrawn')),
 plan jsonb not null check(jsonb_typeof(plan)='object'),plan_text text not null,context_text text not null,
 plan_digest text not null check(plan_digest~'^[a-f0-9]{64}$'),
 prepared_by uuid not null references public.app_users(id),prepared_at timestamptz not null default now(),preparation_notes text not null check(length(trim(preparation_notes)) between 10 and 4000),
 reviewed_by uuid references public.app_users(id),reviewed_at timestamptz,review_notes text,
 withdrawn_by uuid references public.app_users(id),withdrawn_at timestamptz,withdrawal_reason text,
 idempotency_key text not null check(length(trim(idempotency_key)) between 10 and 200),unique(org_id,id),unique(org_id,idempotency_key),
 foreign key(org_id,source_id) references public.books_payroll_correction_sources(org_id,id),foreign key(org_id,posting_id) references public.books_payroll_postings(org_id,id),
 check(plan_text=plan::text and context_text=(plan->'context')::text and plan_digest=encode(sha256(convert_to(plan_text,'UTF8')),'hex') and plan->>'contextHash'=encode(sha256(convert_to(context_text,'UTF8')),'hex')),
 check((reviewed_by is null and reviewed_at is null and review_notes is null and status<>'reviewed') or(reviewed_by is not null and reviewed_by<>prepared_by and reviewed_at is not null and length(trim(review_notes)) between 10 and 4000 and status<>'draft')),
 check((status<>'withdrawn' and withdrawn_by is null and withdrawn_at is null and withdrawal_reason is null) or(status='withdrawn' and withdrawn_by is not null and withdrawn_at is not null and length(trim(withdrawal_reason)) between 10 and 4000))
);
create unique index books_payroll_correction_proposal_active_idx on public.books_payroll_correction_proposals(org_id,posting_id) where status<>'withdrawn';
alter table public.books_payroll_correction_proposals enable row level security;
revoke all on public.books_payroll_correction_proposals from public,anon,authenticated;
grant select,insert,update on public.books_payroll_correction_proposals to service_role;
create policy books_payroll_correction_proposal_service on public.books_payroll_correction_proposals to service_role using(true) with check(true);

create function public.guard_books_payroll_correction_proposal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source public.books_payroll_correction_sources;posting public.books_payroll_postings;parent public.books_payroll_imports;original public.books_payroll_posting_proposals;payment public.books_payroll_payment_reviews;actor uuid;expected jsonb;
begin
 if tg_op='DELETE' then raise exception 'Correction proposal history cannot be deleted';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('payroll-import:'||new.org_id::text,0)) then raise exception 'Correction proposal history is changing; retry' using errcode='40001';end if;
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
create trigger books_payroll_correction_proposal_guard before insert or update or delete on public.books_payroll_correction_proposals for each row execute function public.guard_books_payroll_correction_proposal();
revoke all on function public.guard_books_payroll_correction_proposal() from public,anon,authenticated;

create function public.prepare_books_payroll_correction_proposal(p_org_id uuid,p_id uuid,p_source_id uuid,p_actor_id uuid,p_plan jsonb,p_notes text,p_key text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_payroll_correction_proposals;expected jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' for share;
 if not found then raise exception 'Correction proposal requires active preparer';end if;
 select * into previous from public.books_payroll_correction_proposals where org_id=p_org_id and idempotency_key=p_key;
 if found then
  if previous.id is distinct from p_id or previous.source_id is distinct from p_source_id or previous.prepared_by is distinct from p_actor_id or previous.preparation_notes is distinct from p_notes or previous.plan is distinct from p_plan then raise exception 'Correction proposal retry has different intent';end if;
  return previous.id;
 end if;
 expected:=public.lock_books_payroll_correction_context(p_org_id,p_source_id)-'locksHeldUntilTransactionEnd';
 if expected is distinct from p_plan then raise exception 'Correction context changed before preparation';end if;
 insert into public.books_payroll_correction_proposals(id,org_id,source_id,posting_id,plan,plan_text,context_text,plan_digest,prepared_by,preparation_notes,idempotency_key)
 values(p_id,p_org_id,p_source_id,(expected->>'originalPostingId')::uuid,expected,expected::text,(expected->'context')::text,encode(sha256(convert_to(expected::text,'UTF8')),'hex'),p_actor_id,p_notes,p_key);
 return p_id;
end $$;

create function public.review_books_payroll_correction_proposal(p_org_id uuid,p_id uuid,p_actor_id uuid,p_digest text,p_notes text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_correction_proposals;expected jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into item from public.books_payroll_correction_proposals where org_id=p_org_id and id=p_id for update;
 if item.id is null or item.plan_digest is distinct from p_digest then raise exception 'Correction monetary proposal identity/digest differs';end if;
 expected:=public.lock_books_payroll_correction_context(p_org_id,item.source_id)-'locksHeldUntilTransactionEnd';
 if expected is distinct from item.plan then raise exception 'Correction evidence changed; withdraw and prepare again';end if;
 if item.status='reviewed' and item.reviewed_by=p_actor_id and item.review_notes=p_notes then
  perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' for share;
  if not found then raise exception 'Correction proposal requires active reviewer';end if;return item.id;
 end if;
 if item.status<>'draft' then raise exception 'Correction review requires awaiting-review draft';end if;
 update public.books_payroll_correction_proposals set status='reviewed',reviewed_by=p_actor_id,reviewed_at=now(),review_notes=p_notes where org_id=p_org_id and id=p_id;
 return item.id;
end $$;

create function public.withdraw_books_payroll_correction_proposal(p_org_id uuid,p_id uuid,p_actor_id uuid,p_reason text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_correction_proposals;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' for share;
 if not found or coalesce(length(trim(p_reason)),0) not between 10 and 4000 then raise exception 'Correction withdrawal requires active actor and explanation';end if;
 select * into item from public.books_payroll_correction_proposals where org_id=p_org_id and id=p_id for update;
 if item.id is null then raise exception 'Correction proposal is unavailable in organization';end if;
 if item.status='withdrawn' and item.withdrawn_by=p_actor_id and item.withdrawal_reason=p_reason then return item.id;end if;
 update public.books_payroll_correction_proposals set status='withdrawn',withdrawn_by=p_actor_id,withdrawn_at=now(),withdrawal_reason=p_reason where org_id=p_org_id and id=p_id;
 return item.id;
end $$;

create function public.withdraw_books_correction_proposals_with_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.status='withdrawn' and old.status<>'withdrawn' then
  update public.books_payroll_correction_proposals set status='withdrawn',withdrawn_by=new.withdrawn_by,withdrawn_at=new.withdrawn_at,withdrawal_reason=left('Corrected source withdrawn: '||new.withdrawal_reason,4000) where org_id=new.org_id and source_id=new.id and status<>'withdrawn';
 end if;return new;
end $$;
create trigger books_correction_source_proposal_withdrawal after update of status on public.books_payroll_correction_sources for each row execute function public.withdraw_books_correction_proposals_with_source();
revoke all on function public.withdraw_books_correction_proposals_with_source() from public,anon,authenticated;
revoke all on function public.prepare_books_payroll_correction_proposal(uuid,uuid,uuid,uuid,jsonb,text,text),public.review_books_payroll_correction_proposal(uuid,uuid,uuid,text,text),public.withdraw_books_payroll_correction_proposal(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_books_payroll_correction_proposal(uuid,uuid,uuid,uuid,jsonb,text,text),public.review_books_payroll_correction_proposal(uuid,uuid,uuid,text,text),public.withdraw_books_payroll_correction_proposal(uuid,uuid,uuid,text) to service_role;

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
