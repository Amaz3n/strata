-- Atomic payroll commit and durable ownership. Reviewed business blockers stay
-- blockers; this transaction never guesses billing eligibility or placement.
create table public.books_payroll_postings(
 id uuid primary key,org_id uuid not null references public.orgs(id),proposal_id uuid not null,payroll_import_id uuid not null,
 plan_digest text not null check(plan_digest~'^[a-f0-9]{64}$'),posted_by uuid not null references public.app_users(id),posted_at timestamptz not null default now(),
 posting_notes text not null check(length(trim(posting_notes)) between 10 and 4000),idempotency_key text not null check(length(trim(idempotency_key)) between 10 and 200),
 result jsonb not null check(jsonb_typeof(result)='object'),unique(org_id,id),unique(org_id,proposal_id),unique(org_id,payroll_import_id),unique(org_id,idempotency_key),
 foreign key(org_id,proposal_id) references public.books_payroll_posting_proposals(org_id,id),foreign key(org_id,payroll_import_id) references public.books_payroll_imports(org_id,id)
);
alter table public.books_payroll_postings enable row level security;
revoke all on public.books_payroll_postings from public,anon,authenticated;
grant select,insert on public.books_payroll_postings to service_role;
alter table public.job_cost_entries drop constraint job_cost_entries_source_type_check;
alter table public.job_cost_entries add constraint job_cost_entries_source_type_check check(source_type in('vendor_bill_line','project_expense','project_expense_line','time_entry','bank_transaction','inventory_event','payroll_import'));

create function public.assert_books_payroll_posting_receipt(p_receipt jsonb) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proposal public.books_payroll_posting_proposals; parent public.books_payroll_imports; draft jsonb; link jsonb; allocation jsonb; component jsonb; cost_link jsonb; job public.job_cost_entries; entry public.journal_entries; fact public.accounting_facts;
 org uuid:=(p_receipt->>'org_id')::uuid; receipt_id uuid:=(p_receipt->>'id')::uuid; result jsonb:=p_receipt->'result'; expected jsonb; actual jsonb; account jsonb; i integer:=0; j integer; cost_count integer:=0; preserved jsonb;
begin
 select * into proposal from public.books_payroll_posting_proposals where org_id=org and id=(p_receipt->>'proposal_id')::uuid;
 select * into parent from public.books_payroll_imports where org_id=org and id=proposal.payroll_import_id;
 if proposal.id is null or proposal.status<>'reviewed' or parent.status<>'reviewed' or proposal.payroll_import_id::text is distinct from p_receipt->>'payroll_import_id' or proposal.plan_digest is distinct from p_receipt->>'plan_digest' or result->>'version' is distinct from '1' or result->>'postingId' is distinct from receipt_id::text or result->>'proposalId' is distinct from proposal.id::text or result->>'payrollImportId' is distinct from parent.id::text or result->>'planDigest' is distinct from proposal.plan_digest then raise exception 'Payroll posting receipt identity or approved evidence differs';end if;
 if result is distinct from jsonb_build_object('version',1,'postingId',receipt_id,'proposalId',proposal.id,'payrollImportId',parent.id,'planDigest',proposal.plan_digest,'journals',result->'journals','jobCostCorrections',result->'jobCostCorrections','billingPreserved',result->'billingPreserved') then raise exception 'Payroll posting result shape differs';end if;
 if jsonb_typeof(result->'journals') is distinct from 'array' or jsonb_typeof(result->'jobCostCorrections') is distinct from 'array' or jsonb_array_length(result->'journals')<>jsonb_array_length(proposal.plan->'journalDrafts') then raise exception 'Payroll posting receipt journal inventory differs';end if;
 for draft in select value from jsonb_array_elements(proposal.plan->'journalDrafts') loop
  link:=result->'journals'->i;i:=i+1;
  select * into entry from public.journal_entries where org_id=org and id=(link->>'journalId')::uuid;
  select * into fact from public.accounting_facts where org_id=org and id=(link->>'factId')::uuid;
  if entry.id is null or fact.id is null or entry.fact_id is distinct from fact.id or entry.status<>'posted' or entry.entry_date::text is distinct from draft->>'entryDate' or entry.entry_kind is distinct from draft->>'entryKind' or entry.posting_key is distinct from draft->>'postingKey' or entry.memo is distinct from draft->>'memo' or entry.source_type<>'payroll_import' or entry.source_id<>parent.id or entry.projection_version<>(draft->>'projectionVersion')::integer or entry.policy_version<>(draft->>'policyVersion')::integer or entry.created_by::text is distinct from p_receipt->>'posted_by' or entry.posted_by::text is distinct from p_receipt->>'posted_by' or entry.posted_at is distinct from (p_receipt->>'posted_at')::timestamptz or link->>'entryDate' is distinct from draft->>'entryDate' or link->>'postingKey' is distinct from draft->>'postingKey' then raise exception 'Payroll posting receipt journal differs from approved draft';end if;
  if link is distinct from jsonb_build_object('journalId',entry.id,'factId',fact.id,'entryDate',draft->>'entryDate','postingKey',draft->>'postingKey') then raise exception 'Payroll posting journal link shape differs';end if;
  expected:=jsonb_build_object('payroll_posting_id',receipt_id,'proposal_id',proposal.id,'plan_digest',proposal.plan_digest,'source_revision',proposal.plan->>'sourceRevision','draft',draft);
  if fact.source_type<>'payroll_import' or fact.source_id<>parent.id or fact.source_version<>i or fact.fact_kind<>'payroll_reconciliation' or fact.accounting_date<>entry.entry_date or fact.payload is distinct from expected or fact.payload_hash is distinct from encode(sha256(convert_to(expected::text,'UTF8')),'hex') or fact.idempotency_key is distinct from draft->>'postingKey' or fact.policy_version<>(draft->>'policyVersion')::integer or fact.created_by::text is distinct from p_receipt->>'posted_by' or fact.occurred_at is distinct from (p_receipt->>'posted_at')::timestamptz then raise exception 'Payroll posting receipt fact differs';end if;
  expected:='[]';j:=0;
  for component in select value from jsonb_array_elements(draft->'lines') loop
   j:=j+1;select value into account from jsonb_array_elements(parent.reconciliation->'postingAccounts') where value->>'code'=component->>'accountCode';
   expected:=expected||jsonb_build_array(jsonb_build_object('line_no',j,'account_id',account->>'id','project_id',component->>'projectId','company_id',null,'description',component->>'description','debit_cents',(component->>'debitCents')::bigint,'credit_cents',(component->>'creditCents')::bigint,'dimensions',coalesce(component->'dimensions','{}')||jsonb_build_object('payroll_posting_id',receipt_id,'payroll_proposal_id',proposal.id,'books_account_classification',jsonb_build_object('version',1,'account_id',account->>'id','code',account->>'code','account_type',account->>'account_type','subtype',account->>'subtype'))));
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('line_no',line_no,'account_id',account_id,'project_id',project_id,'company_id',company_id,'description',description,'debit_cents',debit_cents,'credit_cents',credit_cents,'dimensions',dimensions) order by line_no),'[]') into actual from public.journal_lines where org_id=org and entry_id=entry.id;
  if actual is distinct from expected then raise exception 'Payroll posting receipt lines differ from approved draft';end if;
 end loop;
 if i<>(select count(*) from public.journal_entries where org_id=org and source_type='payroll_import' and source_id=parent.id) or i<>(select count(*) from public.accounting_facts where org_id=org and source_type='payroll_import' and source_id=parent.id) then raise exception 'Payroll posted journal/fact inventory differs';end if;
 for allocation in select value from jsonb_array_elements(proposal.plan->'allocations') loop
  if jsonb_array_length(allocation#>'{construction,blockers}')<>0 or allocation#>'{construction,billing,requiresReview}'='true'::jsonb then raise exception 'Payroll posting receipt has unresolved construction controls';end if;
  for component in select value from jsonb_array_elements(allocation#>'{construction,jobCostCorrections}') loop
   cost_link:=result->'jobCostCorrections'->cost_count;cost_count:=cost_count+1;
   select * into job from public.job_cost_entries where org_id=org and id=(cost_link->>'jobCostId')::uuid;
   if cost_link is distinct from jsonb_build_object('jobCostId',job.id,'allocationId',allocation->>'allocationId','component',component->>'component','sourceKey',component->>'sourceKey','costCents',component->'costCents') then raise exception 'Payroll posting correction link shape differs';end if;
   if job.id is null or job.source_type<>'payroll_import' or job.source_id<>job.id::text or job.status<>'posted' or job.project_id::text is distinct from allocation#>>'{construction,projectId}' or job.cost_code_id::text is distinct from allocation#>>'{construction,costCodeId}' or job.budget_line_id::text is distinct from allocation#>>'{construction,budgetLineId}' or job.gmp_classification is distinct from allocation#>>'{construction,gmpClassification}' or job.incurred_on::text is distinct from allocation#>>'{construction,incurredOn}' or job.cost_cents is distinct from (component->>'costCents')::integer or job.is_billable or job.billable_cost_id is not null or job.invoice_id is not null or cost_link->>'allocationId' is distinct from allocation->>'allocationId' or cost_link->>'component' is distinct from component->>'component' or cost_link->>'sourceKey' is distinct from component->>'sourceKey' or (cost_link->>'costCents')::integer is distinct from job.cost_cents or job.metadata is distinct from jsonb_build_object('payroll_posting_id',receipt_id,'payroll_proposal_id',proposal.id,'payroll_run_id',parent.id,'payroll_worker_id',allocation->>'workerId','payroll_allocation_id',allocation->>'allocationId','payroll_component',component->>'component','payroll_source_key',component->>'sourceKey','cost_account_code',allocation->>'accountCode','original_job_cost_ids',allocation#>'{construction,sourceJobCostIds}','billing_action',allocation#>>'{construction,billing,action}') then raise exception 'Payroll posting receipt construction correction differs';end if;
  end loop;
 end loop;
 if cost_count<>jsonb_array_length(result->'jobCostCorrections') or cost_count<>(select count(*) from public.job_cost_entries where org_id=org and source_type='payroll_import' and metadata->>'payroll_posting_id'=receipt_id::text) then raise exception 'Payroll posting correction inventory differs';end if;
 select coalesce(jsonb_agg(distinct b.value order by b.value),'[]') into preserved from jsonb_array_elements(proposal.plan->'allocations') a cross join lateral jsonb_array_elements(a.value#>'{construction,billing,originalBillableCostIds}') b(value);
 if result->'billingPreserved' is distinct from preserved then raise exception 'Payroll preserved billing inventory differs';end if;
 return true;
end $$;
revoke all on function public.assert_books_payroll_posting_receipt(jsonb) from public,anon,authenticated;
grant execute on function public.assert_books_payroll_posting_receipt(jsonb) to service_role;

create function public.guard_books_payroll_posting_receipt() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_op<>'INSERT' then raise exception 'Posted payroll receipt is immutable';end if;
 if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.posted_by and status='active') then raise exception 'Payroll posting receipt requires active own-organization actor';end if;
 perform public.assert_books_payroll_posting_receipt(to_jsonb(new));return new;
end $$;
create trigger books_payroll_postings_immutable before insert or update or delete on public.books_payroll_postings for each row execute function public.guard_books_payroll_posting_receipt();
revoke all on function public.guard_books_payroll_posting_receipt() from public,anon,authenticated;

create function public.guard_books_posted_payroll_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare owned boolean;
begin
 if new.status is distinct from 'withdrawn' then return new;end if;
 if tg_table_name='books_payroll_imports' then select exists(select 1 from public.books_payroll_postings where org_id=new.org_id and payroll_import_id=new.id) into owned;
 elsif tg_table_name='books_payroll_payment_reviews' then select exists(select 1 from public.books_payroll_postings p join public.books_payroll_posting_proposals r on r.id=p.proposal_id and r.org_id=p.org_id where r.org_id=new.org_id and r.payment_review_id=new.id) into owned;
 else select exists(select 1 from public.books_payroll_postings where org_id=new.org_id and proposal_id=new.id) into owned;end if;
 if owned then raise exception 'Posted payroll source requires coordinated correction, not withdrawal';end if;return new;
end $$;
do $$declare name text;begin foreach name in array array['books_payroll_imports','books_payroll_payment_reviews','books_payroll_posting_proposals'] loop execute format('create trigger books_posted_payroll_source_guard before update of status on public.%I for each row execute function public.guard_books_posted_payroll_source()',name);end loop;end $$;
revoke all on function public.guard_books_posted_payroll_source() from public,anon,authenticated;

create function public.guard_books_payroll_cost() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare posting public.books_payroll_postings;
begin
 if tg_op<>'INSERT' and old.source_type='payroll_import' then raise exception 'Posted payroll project cost requires coordinated correction';end if;
 if tg_op='DELETE' then return old;end if;
 if new.source_type='payroll_import' then
  select * into posting from public.books_payroll_postings where org_id=new.org_id and id=(new.metadata->>'payroll_posting_id')::uuid;
  if posting.id is null then raise exception 'Payroll project cost lacks atomic posting receipt';end if;
  perform public.assert_books_payroll_posting_receipt(to_jsonb(posting));
 end if;return new;
end $$;
create constraint trigger books_payroll_cost_ownership after insert or update or delete on public.job_cost_entries deferrable initially deferred for each row execute function public.guard_books_payroll_cost();
revoke all on function public.guard_books_payroll_cost() from public,anon,authenticated;

create function public.guard_books_payroll_journal_reversal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' then
  if old.source_type='payroll_import' and old.status='posted' and new.status='reversed' and exists(select 1 from public.books_payroll_postings where org_id=old.org_id and payroll_import_id=old.source_id) then raise exception 'Payroll journal requires coordinated project cost and billing correction';end if;
 elsif new.reversal_of_entry_id is not null and exists(select 1 from public.journal_entries j join public.books_payroll_postings p on p.org_id=j.org_id and p.payroll_import_id=j.source_id where j.org_id=new.org_id and j.id=new.reversal_of_entry_id and j.source_type='payroll_import') then raise exception 'Payroll journal requires coordinated project cost and billing correction';end if;
 return new;
end $$;
create trigger books_payroll_journal_reversal_guard before insert or update of status on public.journal_entries for each row execute function public.guard_books_payroll_journal_reversal();
revoke all on function public.guard_books_payroll_journal_reversal() from public,anon,authenticated;

create function public.guard_books_payroll_journal_ownership() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare posting public.books_payroll_postings;
begin
 if new.source_type='payroll_import' then
  select * into posting from public.books_payroll_postings where org_id=new.org_id and payroll_import_id=new.source_id;
  if posting.id is null then raise exception 'Payroll journal lacks atomic posting receipt';end if;
  perform public.assert_books_payroll_posting_receipt(to_jsonb(posting));
 end if;return new;
end $$;
create constraint trigger books_payroll_journal_ownership after insert or update on public.journal_entries deferrable initially deferred for each row execute function public.guard_books_payroll_journal_ownership();
create constraint trigger books_payroll_fact_ownership after insert or update on public.accounting_facts deferrable initially deferred for each row execute function public.guard_books_payroll_journal_ownership();
revoke all on function public.guard_books_payroll_journal_ownership() from public,anon,authenticated;

create function public.post_books_payroll_proposal(p_org_id uuid,p_id uuid,p_proposal_id uuid,p_actor_id uuid,p_digest text,p_notes text,p_key text) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_payroll_postings; proposal public.books_payroll_posting_proposals; parent public.books_payroll_imports; controls jsonb; draft jsonb; line jsonb; account public.gl_accounts; allocation jsonb; component jsonb; facts jsonb; entry_id uuid; fact_id uuid; cost_id uuid; i integer:=0; j integer; lines jsonb; journals jsonb:='[]'; costs jsonb:='[]'; preserved jsonb; result jsonb;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_notes)),0)<10 or length(trim(p_notes))>4000 or coalesce(length(trim(p_key)),0)<10 or length(trim(p_key))>200 then raise exception 'Payroll posting requires active actor, notes and retry identity';end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' for share;
 if not found then raise exception 'Payroll posting actor membership changed';end if;
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into previous from public.books_payroll_postings where org_id=p_org_id and idempotency_key=p_key;
 if found then
  if previous.id<>p_id or previous.proposal_id<>p_proposal_id or previous.posted_by<>p_actor_id or previous.plan_digest is distinct from p_digest or previous.posting_notes is distinct from p_notes then raise exception 'Payroll posting retry identity belongs to different intent';end if;
  perform public.assert_books_payroll_posting_receipt(to_jsonb(previous));return previous.result;
 end if;
 if exists(select 1 from public.books_payroll_postings where org_id=p_org_id and(proposal_id=p_proposal_id or id=p_id)) then raise exception 'Payroll proposal already posted with a different retry identity';end if;
 controls:=public.lock_books_payroll_posting_context(p_org_id,p_proposal_id);
 if controls->'controlsSatisfied' is distinct from 'true'::jsonb then raise exception 'Payroll posting has unresolved accounting calendar or construction controls: %',controls;end if;
 select * into proposal from public.books_payroll_posting_proposals where org_id=p_org_id and id=p_proposal_id;
 select * into parent from public.books_payroll_imports where org_id=p_org_id and id=proposal.payroll_import_id;
 if proposal.plan_digest is distinct from p_digest then raise exception 'Payroll approved proposal digest changed';end if;
 -- Project/cost-code ownership can change without touching an existing source
 -- row. Lock those parents too and verify each non-null allocation scope.
 perform 1 from public.projects where org_id=p_org_id and id in(select (value->>'projectId')::uuid from jsonb_array_elements(proposal.plan->'allocations')) order by id for share;
 perform 1 from public.cost_codes where org_id=p_org_id and id in(select (value->>'costCodeId')::uuid from jsonb_array_elements(proposal.plan->'allocations')) order by id for share;
 if exists(select 1 from jsonb_array_elements(proposal.plan->'allocations') a where (a.value->>'projectId' is not null and not exists(select 1 from public.projects where org_id=p_org_id and id=(a.value->>'projectId')::uuid)) or(a.value->>'costCodeId' is not null and not exists(select 1 from public.cost_codes where org_id=p_org_id and id=(a.value->>'costCodeId')::uuid))) then raise exception 'Payroll project or cost-code organization scope changed';end if;
 for draft in select value from jsonb_array_elements(proposal.plan->'journalDrafts') loop
  i:=i+1;facts:=jsonb_build_object('payroll_posting_id',p_id,'proposal_id',proposal.id,'plan_digest',p_digest,'source_revision',proposal.plan->>'sourceRevision','draft',draft);
  insert into public.accounting_facts(org_id,source_type,source_id,source_version,fact_kind,occurred_at,accounting_date,payload,payload_hash,policy_version,idempotency_key,created_by) values(p_org_id,'payroll_import',parent.id,i,'payroll_reconciliation',now(),(draft->>'entryDate')::date,facts,encode(sha256(convert_to(facts::text,'UTF8')),'hex'),(draft->>'policyVersion')::integer,draft->>'postingKey',p_actor_id) returning id into fact_id;
  lines:='[]';j:=0;
  for line in select value from jsonb_array_elements(draft->'lines') loop
   j:=j+1;select * into account from public.gl_accounts where org_id=p_org_id and code=line->>'accountCode' and active;
   if not found or(select count(*) from public.gl_accounts where org_id=p_org_id and code=line->>'accountCode' and active)<>1 then raise exception 'Payroll posting account is missing or ambiguous';end if;
   lines:=lines||jsonb_build_array(jsonb_build_object('line_no',j,'account_id',account.id,'project_id',line->>'projectId','description',line->>'description','debit_cents',(line->>'debitCents')::bigint,'credit_cents',(line->>'creditCents')::bigint,'dimensions',coalesce(line->'dimensions','{}')||jsonb_build_object('payroll_posting_id',p_id,'payroll_proposal_id',proposal.id,'books_account_classification',jsonb_build_object('version',1,'account_id',account.id,'code',account.code,'account_type',account.account_type,'subtype',account.subtype))));
  end loop;
  entry_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('fact_id',fact_id,'entry_date',draft->>'entryDate','entry_kind',draft->>'entryKind','memo',draft->>'memo','posting_key',draft->>'postingKey','projection_version',draft->'projectionVersion','policy_version',draft->'policyVersion','source_type','payroll_import','source_id',parent.id,'created_by',p_actor_id),lines);
  journals:=journals||jsonb_build_array(jsonb_build_object('journalId',entry_id,'factId',fact_id,'entryDate',draft->>'entryDate','postingKey',draft->>'postingKey'));
 end loop;
 for allocation in select value from jsonb_array_elements(proposal.plan->'allocations') loop
  for component in select value from jsonb_array_elements(allocation#>'{construction,jobCostCorrections}') loop
   cost_id:=gen_random_uuid();
   insert into public.job_cost_entries(id,org_id,project_id,cost_code_id,budget_line_id,gmp_classification,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata) values(cost_id,p_org_id,(allocation#>>'{construction,projectId}')::uuid,(allocation#>>'{construction,costCodeId}')::uuid,(allocation#>>'{construction,budgetLineId}')::uuid,allocation#>>'{construction,gmpClassification}','payroll_import',cost_id,(allocation#>>'{construction,incurredOn}')::date,(component->>'costCents')::integer,'posted',false,jsonb_build_object('payroll_posting_id',p_id,'payroll_proposal_id',proposal.id,'payroll_run_id',parent.id,'payroll_worker_id',allocation->>'workerId','payroll_allocation_id',allocation->>'allocationId','payroll_component',component->>'component','payroll_source_key',component->>'sourceKey','cost_account_code',allocation->>'accountCode','original_job_cost_ids',allocation#>'{construction,sourceJobCostIds}','billing_action',allocation#>>'{construction,billing,action}'));
   costs:=costs||jsonb_build_array(jsonb_build_object('jobCostId',cost_id,'allocationId',allocation->>'allocationId','component',component->>'component','sourceKey',component->>'sourceKey','costCents',component->'costCents'));
  end loop;
 end loop;
 select coalesce(jsonb_agg(distinct b.value order by b.value),'[]') into preserved from jsonb_array_elements(proposal.plan->'allocations') a cross join lateral jsonb_array_elements(a.value#>'{construction,billing,originalBillableCostIds}') b(value);
 result:=jsonb_build_object('version',1,'postingId',p_id,'proposalId',proposal.id,'payrollImportId',parent.id,'planDigest',p_digest,'journals',journals,'jobCostCorrections',costs,'billingPreserved',preserved);
 insert into public.books_payroll_postings(id,org_id,proposal_id,payroll_import_id,plan_digest,posted_by,posting_notes,idempotency_key,result) values(p_id,p_org_id,proposal.id,parent.id,p_digest,p_actor_id,p_notes,p_key,result);
 return result;
end $$;
revoke all on function public.post_books_payroll_proposal(uuid,uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.post_books_payroll_proposal(uuid,uuid,uuid,uuid,text,text,text) to service_role;

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
    'books_payroll_posting_proposals','books_payroll_postings',
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
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;

-- Readiness reports the available atomic commit. Signed arithmetic plans
-- retain their historical preview flags and digest.
create or replace function public.lock_books_payroll_posting_context(p_org_id uuid,p_proposal_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proposal public.books_payroll_posting_proposals; parent public.books_payroll_imports; payment public.books_payroll_payment_reviews;
 parent_id uuid; period public.accounting_periods; date_key date; date_rows jsonb:='[]'; calendar_blockers jsonb:='[]'; allocation_blockers jsonb:='[]'; allocation jsonb; reason jsonb; sources jsonb; journal_ids uuid[];
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 if not pg_try_advisory_xact_lock(hashtextextended('books-payroll-source:'||p_org_id::text,0)) then raise exception 'Payroll sources are changing; retry payroll transaction' using errcode='40001';end if;
 if not pg_try_advisory_xact_lock_shared(hashtextextended('books-period-calendar:'||p_org_id::text,0)) then raise exception 'Accounting calendar is changing; retry payroll transaction' using errcode='40001';end if;
 select payroll_import_id into parent_id from public.books_payroll_posting_proposals where org_id=p_org_id and id=p_proposal_id;
 if not found then raise exception 'Payroll posting proposal is unavailable in organization';end if;
 select * into parent from public.books_payroll_imports where org_id=p_org_id and id=parent_id for share;
 select * into payment from public.books_payroll_payment_reviews where org_id=p_org_id and payroll_import_id=parent_id and status<>'withdrawn' for share;
 select * into proposal from public.books_payroll_posting_proposals where org_id=p_org_id and id=p_proposal_id for update;
 if proposal.status<>'reviewed' then raise exception 'Payroll posting requires independently reviewed full proposal';end if;
 perform public.verify_books_payroll_posting_plan(p_org_id,parent_id,proposal.plan);
 sources:=parent.reconciliation#>'{workflowEvidence,sourceTables}';
 -- Exclusive org source fence already blocks mutations/inserts and phantom
 -- dependent sources. Explicit row locks also coordinate original FK writers.
 perform 1 from public.time_entries where org_id=p_org_id and id in(select (value->>'source_id')::uuid from jsonb_array_elements(sources->'job_cost_entries')) order by id for share;
 perform 1 from public.job_cost_entries where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'job_cost_entries')) order by id for share;
 perform 1 from public.accounting_facts where org_id=p_org_id and id in(select (value->>'fact_id')::uuid from jsonb_array_elements(parent.labor_evidence)) order by id for share;
 select array_agg(distinct identifier order by identifier) into journal_ids from(select (value->>'id')::uuid identifier from jsonb_array_elements(sources->'journal_entries') union select (value->>'journal_id')::uuid from jsonb_array_elements(parent.labor_evidence)) j;
 perform 1 from public.journal_entries where org_id=p_org_id and id=any(journal_ids) order by id for share;
 perform 1 from public.journal_lines where org_id=p_org_id and entry_id=any(journal_ids) order by id for share;
 perform 1 from public.books_projection_receipts where org_id=p_org_id and journal_id=any(journal_ids) order by id for share;
 perform 1 from public.budgets where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'budgets')) order by id for share;
 perform 1 from public.budget_lines where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'budget_lines')) order by id for share;
 perform 1 from public.billable_costs where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'billable_costs')) order by id for share;
 perform 1 from public.gl_accounts where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'gl_accounts')) order by id for share;
 for date_key in select distinct accounting_date from(select (value->>'entryDate')::date accounting_date from jsonb_array_elements(proposal.plan->'journalDrafts') union select (value#>>'{construction,incurredOn}')::date from jsonb_array_elements(proposal.plan->'allocations') where value#>'{construction,jobCostCorrections}'<>'[]'::jsonb) dates order by accounting_date loop
  select * into period from public.accounting_periods where org_id=p_org_id and date_key between period_start and period_end order by id for share;
  if (select count(*) from public.accounting_periods where org_id=p_org_id and date_key between period_start and period_end)>1 then
   calendar_blockers:=calendar_blockers||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'code','ambiguous_accounting_period'));date_rows:=date_rows||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'periodId',null,'status',null));
  elsif period.id is null then
   calendar_blockers:=calendar_blockers||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'code','missing_accounting_period'));date_rows:=date_rows||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'periodId',null,'status',null));
  else
   date_rows:=date_rows||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'periodId',period.id,'status',period.status));
   if period.status is null or period.status not in('open','reopened') then calendar_blockers:=calendar_blockers||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'code','accounting_period_'||coalesce(period.status,'invalid')));end if;
  end if;
 end loop;
 for allocation in select value from jsonb_array_elements(proposal.plan->'allocations') loop
  for reason in select value from jsonb_array_elements(allocation#>'{construction,blockers}') loop
   allocation_blockers:=allocation_blockers||jsonb_build_array(jsonb_build_object('allocationId',allocation->>'allocationId','code',reason#>>'{}'));
  end loop;
  if allocation#>'{construction,billing,requiresReview}'='true'::jsonb then allocation_blockers:=allocation_blockers||jsonb_build_array(jsonb_build_object('allocationId',allocation->>'allocationId','code',allocation#>>'{construction,billing,action}'));end if;
 end loop;
 return jsonb_build_object('version',1,'orgId',p_org_id,'proposalId',proposal.id,'payrollImportId',parent_id,'planDigest',proposal.plan_digest,'accountingDates',date_rows,'calendarBlockers',calendar_blockers,'constructionBlockers',allocation_blockers,'controlsSatisfied',jsonb_array_length(calendar_blockers)=0 and jsonb_array_length(allocation_blockers)=0,'postingImplemented',true,'locksHeldUntilTransactionEnd',true);
end $$;
