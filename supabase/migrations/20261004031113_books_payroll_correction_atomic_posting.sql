-- First actual correction of an original payroll posting. Further corrections
-- require a latest-posted-register baseline, and are rejected until that lineage
-- is implemented; documentary source versions are never monetary baselines.
create table public.books_payroll_correction_postings(
 id uuid primary key,org_id uuid not null references public.orgs(id),proposal_id uuid not null,source_id uuid not null,posting_id uuid not null,
 plan_digest text not null check(plan_digest~'^[a-f0-9]{64}$'),posted_by uuid not null references public.app_users(id),posted_at timestamptz not null default now(),
 posting_notes text not null check(length(trim(posting_notes)) between 10 and 4000),idempotency_key text not null check(length(trim(idempotency_key)) between 10 and 200),result jsonb not null check(jsonb_typeof(result)='object'),
 unique(org_id,id),unique(org_id,proposal_id),unique(org_id,source_id),unique(org_id,posting_id),unique(org_id,idempotency_key),
 foreign key(org_id,proposal_id) references public.books_payroll_correction_proposals(org_id,id),
 foreign key(org_id,source_id) references public.books_payroll_correction_sources(org_id,id),
 foreign key(org_id,posting_id) references public.books_payroll_postings(org_id,id)
);
alter table public.books_payroll_correction_postings enable row level security;
revoke all on public.books_payroll_correction_postings from public,anon,authenticated;
grant select,insert on public.books_payroll_correction_postings to service_role;
create policy books_payroll_correction_posting_service on public.books_payroll_correction_postings to service_role using(true) with check(true);
alter table public.job_cost_entries drop constraint job_cost_entries_source_type_check;
alter table public.job_cost_entries add constraint job_cost_entries_source_type_check check(source_type in('vendor_bill_line','project_expense','project_expense_line','time_entry','bank_transaction','inventory_event','payroll_import','payroll_correction'));

-- Reconstruct actual ownership from frozen approval. Do not recompute current
-- liability context after writing the correction's own journal into that history.
create function public.assert_books_payroll_correction_posting(p_receipt jsonb) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proposal public.books_payroll_correction_proposals;source public.books_payroll_correction_sources;root public.books_payroll_postings;parent public.books_payroll_imports;
 entry public.journal_entries;fact public.accounting_facts;job public.job_cost_entries;draft jsonb;line jsonb;account jsonb;cost jsonb;link jsonb;expected jsonb;actual jsonb;links jsonb:='[]';i integer:=0;j integer:=0;
 org uuid:=(p_receipt->>'org_id')::uuid;receipt_id uuid:=(p_receipt->>'id')::uuid;result jsonb:=p_receipt->'result';
begin
 select * into proposal from public.books_payroll_correction_proposals where org_id=org and id=(p_receipt->>'proposal_id')::uuid;
 select * into source from public.books_payroll_correction_sources where org_id=org and id=(p_receipt->>'source_id')::uuid;
 select * into root from public.books_payroll_postings where org_id=org and id=(p_receipt->>'posting_id')::uuid;
 if proposal.id is null or source.id is null or root.id is null or proposal.status<>'reviewed' or source.status<>'reviewed' or proposal.source_id<>source.id or proposal.posting_id<>root.id or source.posting_id<>root.id or proposal.plan_digest is distinct from p_receipt->>'plan_digest' or proposal.plan->'blockers'<>'[]'::jsonb or proposal.plan->'requiresConstructionReview' is distinct from 'false'::jsonb then raise exception 'Correction receipt lacks reviewed source and monetary approval';end if;
 perform public.assert_books_payroll_posting_receipt(to_jsonb(root));
 select * into parent from public.books_payroll_imports where org_id=org and id=root.payroll_import_id;
 if source.evidence_hash is distinct from public.books_payroll_correction_source_hash(to_jsonb(source)) or proposal.plan->'math' is distinct from public.books_payroll_provider_delta(parent.run,parent.reconciliation->'postingAccounts',source.run,source.account_snapshot,source.request) then raise exception 'Correction receipt provider arithmetic differs';end if;
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
 if result is distinct from expected then raise exception 'Correction posting receipt result differs';end if;
 return true;
end $$;
revoke all on function public.assert_books_payroll_correction_posting(jsonb) from public,anon,authenticated;
grant execute on function public.assert_books_payroll_correction_posting(jsonb) to service_role;

create function public.guard_books_payroll_correction_receipt() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare current jsonb;context jsonb;remaining_ids jsonb;current_blockers jsonb;
begin
 if tg_op<>'INSERT' then raise exception 'Posted correction receipt is immutable';end if;
 perform 1 from public.memberships where org_id=new.org_id and user_id=new.posted_by and status='active' for share;
 if not found then raise exception 'Correction receipt requires active organization actor';end if;
 -- Direct SQL inserts must satisfy the same current transaction controls as
 -- the RPC. Remove only this proved journal from the pre-existing liability
 -- snapshot; every other movement still invalidates unassigned review.
 current:=public.lock_books_payroll_correction_context(new.org_id,new.source_id)-'locksHeldUntilTransactionEnd';
 context:=current->'context';
 context:=jsonb_set(context,'{liability_journals}',(select coalesce(jsonb_agg(value order by ord),'[]') from jsonb_array_elements(context->'liability_journals') with ordinality rows(value,ord) where value->>'id' is distinct from new.result->>'journalId'));
 context:=jsonb_set(context,'{liability_lines}',(select coalesce(jsonb_agg(value order by ord),'[]') from jsonb_array_elements(context->'liability_lines') with ordinality rows(value,ord) where value->>'entry_id' is distinct from new.result->>'journalId'));
 select coalesce(jsonb_agg(value order by ord),'[]') into remaining_ids from jsonb_array_elements(current->'additionalLiabilityJournalIds') with ordinality rows(value,ord) where value#>>'{}' is distinct from new.result->>'journalId';
 select coalesce(jsonb_agg(value order by ord),'[]') into current_blockers from jsonb_array_elements(current->'blockers') with ordinality rows(value,ord) where value#>>'{}'<>'review_additional_liability_attribution' or jsonb_array_length(remaining_ids)>0;
 current:=current||jsonb_build_object('context',context,'contextHash',encode(sha256(convert_to(context::text,'UTF8')),'hex'),'additionalLiabilityJournalIds',remaining_ids,'blockers',current_blockers);
 if current is distinct from(select plan from public.books_payroll_correction_proposals where org_id=new.org_id and id=new.proposal_id) then raise exception 'Correction evidence changed inside monetary transaction';end if;
 perform public.assert_books_payroll_correction_posting(to_jsonb(new));return new;
end $$;
create trigger books_payroll_correction_receipt_guard before insert or update or delete on public.books_payroll_correction_postings for each row execute function public.guard_books_payroll_correction_receipt();

create function public.guard_books_payroll_correction_history() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.status='withdrawn' and exists(select 1 from public.books_payroll_correction_postings where org_id=new.org_id and(case when tg_table_name='books_payroll_correction_sources' then source_id=new.id else proposal_id=new.id end)) then raise exception 'Posted correction requires a coordinated subsequent correction, not withdrawal';end if;
 return new;
end $$;
create trigger books_payroll_corrected_source_history before update of status on public.books_payroll_correction_sources for each row execute function public.guard_books_payroll_correction_history();
create trigger books_payroll_corrected_proposal_history before update of status on public.books_payroll_correction_proposals for each row execute function public.guard_books_payroll_correction_history();

create function public.guard_books_payroll_correction_cost_mutation() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if old.source_type='payroll_correction' then raise exception 'Posted correction project cost is immutable';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger books_payroll_correction_cost_immutable before update or delete on public.job_cost_entries for each row execute function public.guard_books_payroll_correction_cost_mutation();

create function public.guard_books_payroll_correction_ownership() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare receipt public.books_payroll_correction_postings;entry public.journal_entries;owned_source_id uuid;owned boolean:=false;
begin
 if tg_table_name='journal_lines' then
  select * into entry from public.journal_entries where org_id=new.org_id and id=new.entry_id;
  owned:=entry.source_type='payroll_correction';owned_source_id:=entry.source_id;
 elsif tg_table_name='job_cost_entries' then
  if new.source_type='payroll_correction' then
   select * into receipt from public.books_payroll_correction_postings where org_id=new.org_id and id=(new.metadata->>'payroll_correction_posting_id')::uuid;owned:=true;
  end if;
 else owned:=new.source_type='payroll_correction';owned_source_id:=new.source_id;
 end if;
 if owned then
  if tg_table_name<>'job_cost_entries' then select * into receipt from public.books_payroll_correction_postings where org_id=new.org_id and books_payroll_correction_postings.source_id=owned_source_id;end if;
  if receipt.id is null then raise exception 'Correction money lacks atomic posting receipt';end if;
  perform public.assert_books_payroll_correction_posting(to_jsonb(receipt));
 end if;return new;
end $$;
create constraint trigger books_payroll_correction_journal_ownership after insert or update on public.journal_entries deferrable initially deferred for each row execute function public.guard_books_payroll_correction_ownership();
create constraint trigger books_payroll_correction_fact_ownership after insert or update on public.accounting_facts deferrable initially deferred for each row execute function public.guard_books_payroll_correction_ownership();
create constraint trigger books_payroll_correction_line_ownership after insert or update on public.journal_lines deferrable initially deferred for each row execute function public.guard_books_payroll_correction_ownership();
create constraint trigger books_payroll_correction_cost_ownership after insert or update on public.job_cost_entries deferrable initially deferred for each row execute function public.guard_books_payroll_correction_ownership();

create function public.guard_books_payroll_correction_reversal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' then
  if old.source_type='payroll_correction' and old.status='posted' and new.status='reversed' then raise exception 'Correction journal requires coordinated project cost correction';end if;
 elsif new.reversal_of_entry_id is not null and exists(select 1 from public.journal_entries where org_id=new.org_id and id=new.reversal_of_entry_id and source_type='payroll_correction') then raise exception 'Correction journal requires coordinated project cost correction';end if;
 return new;
end $$;
create trigger books_payroll_correction_reversal_guard before insert or update of status on public.journal_entries for each row execute function public.guard_books_payroll_correction_reversal();
revoke all on function public.guard_books_payroll_correction_receipt(),public.guard_books_payroll_correction_history(),public.guard_books_payroll_correction_cost_mutation(),public.guard_books_payroll_correction_ownership(),public.guard_books_payroll_correction_reversal() from public,anon,authenticated;

create function public.post_books_payroll_correction_proposal(p_org_id uuid,p_id uuid,p_proposal_id uuid,p_actor_id uuid,p_digest text,p_notes text,p_key text) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
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
 if exists(select 1 from public.books_payroll_correction_postings where org_id=p_org_id and(posting_id=proposal.posting_id or id=p_id)) then raise exception 'Subsequent correction requires latest actually posted register baseline';end if;
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
 result:=jsonb_build_object('version',1,'postingId',p_id,'proposalId',proposal.id,'sourceId',source.id,'originalPostingId',proposal.posting_id,'planDigest',p_digest,'journalId',entry_id,'factId',fact_id,'jobCosts',costs,'billingPreserved',context->'preservedBillableCostIds');
 insert into public.books_payroll_correction_postings(id,org_id,proposal_id,source_id,posting_id,plan_digest,posted_by,posting_notes,idempotency_key,result) values(p_id,p_org_id,proposal.id,source.id,proposal.posting_id,p_digest,p_actor_id,p_notes,p_key,result);
 return result;
end $$;
revoke all on function public.post_books_payroll_correction_proposal(uuid,uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.post_books_payroll_correction_proposal(uuid,uuid,uuid,uuid,text,text,text) to service_role;

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
