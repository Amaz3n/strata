-- Operational ownership contains source IDs only, never provider wages,
-- documents, worker funding, register data or payroll approval metadata.
create unique index books_payroll_native_projects_scope_idx on public.projects(org_id,id);
create unique index books_payroll_native_cost_codes_scope_idx on public.cost_codes(org_id,id);
create unique index books_payroll_native_time_scope_idx on public.time_entries(org_id,id);
create unique index books_payroll_native_job_scope_idx on public.job_cost_entries(org_id,id);
create table public.books_payroll_labor_ownership(
 id uuid primary key,org_id uuid not null references public.orgs(id),project_id uuid not null,cost_code_id uuid,
 posting_id uuid not null,time_entry_id uuid not null,job_cost_entry_id uuid not null,
 fact_id uuid not null references public.accounting_facts(id),journal_id uuid not null references public.journal_entries(id),projection_receipt_id uuid not null references public.books_projection_receipts(id),
 created_at timestamptz not null,unique(org_id,job_cost_entry_id),unique(org_id,time_entry_id),
 foreign key(org_id,project_id) references public.projects(org_id,id),foreign key(org_id,cost_code_id) references public.cost_codes(org_id,id),
 foreign key(org_id,time_entry_id) references public.time_entries(org_id,id),foreign key(org_id,job_cost_entry_id) references public.job_cost_entries(org_id,id),
 foreign key(org_id,posting_id) references public.books_payroll_postings(org_id,id) deferrable initially deferred
);
create index books_payroll_labor_ownership_posting_idx on public.books_payroll_labor_ownership(org_id,posting_id,job_cost_entry_id);
create index books_payroll_labor_ownership_journal_idx on public.books_payroll_labor_ownership(org_id,journal_id);
create index books_payroll_labor_ownership_receipt_idx on public.books_payroll_labor_ownership(org_id,projection_receipt_id);
alter table public.books_payroll_labor_ownership enable row level security;
revoke all on public.books_payroll_labor_ownership from public,anon,authenticated;
grant select on public.books_payroll_labor_ownership to authenticated;
grant select,insert on public.books_payroll_labor_ownership to service_role;
-- Visibility follows either original operational source and its own RLS.
-- A cost writer may lack time access (or vice versa); the invoker guard must
-- still see ownership for the source it can write. No salary data is exposed.
create policy books_payroll_labor_ownership_read on public.books_payroll_labor_ownership for select to authenticated using(
 exists(select 1 from public.time_entries t where t.org_id=books_payroll_labor_ownership.org_id and t.id=books_payroll_labor_ownership.time_entry_id)
 or exists(select 1 from public.job_cost_entries j where j.org_id=books_payroll_labor_ownership.org_id and j.id=books_payroll_labor_ownership.job_cost_entry_id)
);
create policy books_payroll_labor_ownership_service_read on public.books_payroll_labor_ownership for select to service_role using(true);
create policy books_payroll_labor_ownership_service_insert on public.books_payroll_labor_ownership for insert to service_role with check(true);

create function public.books_payroll_time_economics(p_row jsonb) returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 select jsonb_object_agg(key,coalesce(p_row->key,'null'::jsonb)) from unnest(array['id','org_id','project_id','cost_code_id','budget_line_id','billable_cost_id','worker_user_id','worker_company_id','work_date','hours','base_rate_cents','burden_multiplier','is_overtime','ot_multiplier','is_double_time','dt_multiplier','labor_cost_policy_version','cost_cents']) key
$$;
create function public.books_payroll_job_economics(p_row jsonb) returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 select (select jsonb_object_agg(key,coalesce(p_row->key,'null'::jsonb)) from unnest(array['id','org_id','project_id','cost_code_id','budget_line_id','gmp_classification','billable_cost_id','source_type','source_id','incurred_on','cost_cents','status']) key)||jsonb_build_object('metadata',(select jsonb_object_agg(key,coalesce(p_row->'metadata'->key,'null'::jsonb)) from unnest(array['worker_user_id','worker_company_id','hours','base_rate_cents','burden_multiplier','is_overtime','ot_multiplier','is_double_time','dt_multiplier','labor_cost_policy_version']) key))
$$;
-- Trigger callers need these pure public-row helpers; they reveal no private data.
revoke all on function public.books_payroll_time_economics(jsonb),public.books_payroll_job_economics(jsonb) from public,anon;
grant execute on function public.books_payroll_time_economics(jsonb),public.books_payroll_job_economics(jsonb) to authenticated,service_role;

create function public.guard_books_payroll_native_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare owned boolean;
begin
 if tg_table_name='time_entries' then select exists(select 1 from public.books_payroll_labor_ownership where org_id=old.org_id and time_entry_id=old.id) into owned;
 elsif tg_table_name='job_cost_entries' then select exists(select 1 from public.books_payroll_labor_ownership where org_id=old.org_id and job_cost_entry_id=old.id) into owned;
 else select exists(select 1 from public.books_payroll_labor_ownership where org_id=old.org_id and projection_receipt_id=old.id) into owned;end if;
 if not owned then if tg_op='DELETE' then return old;end if;return new;end if;
 if tg_op='DELETE' then raise exception 'Native labor consumed by posted payroll requires coordinated correction';end if;
 if tg_table_name='time_entries' then
  if public.books_payroll_time_economics(to_jsonb(new)) is distinct from public.books_payroll_time_economics(to_jsonb(old)) or (new.status is null or new.status not in('pm_approved','client_approved','locked')) then raise exception 'Native time consumed by posted payroll requires coordinated correction';end if;
 elsif tg_table_name='job_cost_entries' then
  if public.books_payroll_job_economics(to_jsonb(new)) is distinct from public.books_payroll_job_economics(to_jsonb(old)) then raise exception 'Native project cost consumed by posted payroll requires coordinated correction';end if;
  -- An idempotent upsert or customer invoice link must not make the original
  -- native accounting receipt stale. This trigger runs after touch triggers.
  new.updated_at:=old.updated_at;
 else
  if to_jsonb(new)-'checked_at' is distinct from to_jsonb(old)-'checked_at' then raise exception 'Native accounting receipt consumed by posted payroll requires coordinated correction';end if;
 end if;return new;
end $$;
create trigger zz_books_payroll_native_source_guard before update or delete on public.time_entries for each row execute function public.guard_books_payroll_native_source();
create trigger zz_books_payroll_native_source_guard before update or delete on public.job_cost_entries for each row execute function public.guard_books_payroll_native_source();
create trigger zz_books_payroll_native_source_guard before update or delete on public.books_projection_receipts for each row execute function public.guard_books_payroll_native_source();
revoke all on function public.guard_books_payroll_native_source() from public,anon,authenticated;

create function public.guard_books_payroll_native_reversal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' then
  if new.reversal_of_entry_id is not null and exists(select 1 from public.books_payroll_labor_ownership where org_id=new.org_id and journal_id=new.reversal_of_entry_id) then raise exception 'Native labor journal consumed by posted payroll requires coordinated correction';end if;
 elsif old.status='posted' and new.status='reversed' and exists(select 1 from public.books_payroll_labor_ownership where org_id=old.org_id and journal_id=old.id) then raise exception 'Native labor journal consumed by posted payroll requires coordinated correction';end if;
 return new;
end $$;
create trigger books_payroll_native_reversal_guard before insert or update of status on public.journal_entries for each row execute function public.guard_books_payroll_native_reversal();
revoke all on function public.guard_books_payroll_native_reversal() from public,anon,authenticated;

create function public.claim_books_payroll_native_ownership(p_receipt jsonb) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare parent public.books_payroll_imports; item jsonb; job public.job_cost_entries; receipt public.books_projection_receipts;
begin
 perform public.assert_books_payroll_posting_financials(p_receipt);
 if not pg_try_advisory_xact_lock(hashtextextended('books-payroll-source:'||(p_receipt->>'org_id')::uuid::text,0)) then raise exception 'Payroll native sources are changing; retry ownership' using errcode='40001';end if;
 select * into parent from public.books_payroll_imports where org_id=(p_receipt->>'org_id')::uuid and id=(p_receipt->>'payroll_import_id')::uuid for share;
 for item in select value from jsonb_array_elements(parent.labor_evidence) order by value->>'id' loop
  select * into job from public.job_cost_entries where org_id=(p_receipt->>'org_id')::uuid and id=(item->>'id')::uuid for share;
  select * into receipt from public.books_projection_receipts where org_id=(p_receipt->>'org_id')::uuid and source_type='labor_cost' and source_id=job.id for share;
  if exists(select 1 from public.books_payroll_labor_ownership where org_id=(p_receipt->>'org_id')::uuid and(job_cost_entry_id=job.id or time_entry_id::text=job.source_id)) then raise exception 'Native time already reconciled by posted payroll; use coordinated correction';end if;
  insert into public.books_payroll_labor_ownership(id,org_id,project_id,cost_code_id,posting_id,time_entry_id,job_cost_entry_id,fact_id,journal_id,projection_receipt_id,created_at) values(job.id,(p_receipt->>'org_id')::uuid,job.project_id,job.cost_code_id,(p_receipt->>'id')::uuid,job.source_id::uuid,job.id,(item->>'fact_id')::uuid,(item->>'journal_id')::uuid,receipt.id,(p_receipt->>'posted_at')::timestamptz);
 end loop;return;
end $$;
revoke all on function public.claim_books_payroll_native_ownership(jsonb) from public,anon,authenticated;
grant execute on function public.claim_books_payroll_native_ownership(jsonb) to service_role;
create function public.attach_books_payroll_native_ownership() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform public.claim_books_payroll_native_ownership(to_jsonb(new));return new;
end $$;
-- Alphabetically before the existing receipt proof trigger. The posting FK is
-- deferred so the proof can see complete ownership before NEW is inserted.
create trigger books_payroll_postings_attach_labor before insert on public.books_payroll_postings for each row execute function public.attach_books_payroll_native_ownership();
revoke all on function public.attach_books_payroll_native_ownership() from public,anon,authenticated;

create function public.assert_books_payroll_native_ownership(p_receipt jsonb) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare parent public.books_payroll_imports; item jsonb; original jsonb; ownership public.books_payroll_labor_ownership; job public.job_cost_entries; time_row public.time_entries; fact public.accounting_facts; journal public.journal_entries; receipt public.books_projection_receipts; count_expected integer:=0; basis jsonb;
begin
 select * into parent from public.books_payroll_imports where org_id=(p_receipt->>'org_id')::uuid and id=(p_receipt->>'payroll_import_id')::uuid;
 if parent.id is null then raise exception 'Payroll native ownership parent is unavailable';end if;
 for item in select value from jsonb_array_elements(parent.labor_evidence) loop
  count_expected:=count_expected+1;
  select * into ownership from public.books_payroll_labor_ownership where org_id=parent.org_id and posting_id=(p_receipt->>'id')::uuid and job_cost_entry_id=(item->>'id')::uuid;
  select * into job from public.job_cost_entries where org_id=parent.org_id and id=(item->>'id')::uuid;
  select * into time_row from public.time_entries where org_id=parent.org_id and id::text=job.source_id;
  select * into fact from public.accounting_facts where org_id=parent.org_id and id=(item->>'fact_id')::uuid;
  select * into journal from public.journal_entries where org_id=parent.org_id and id=(item->>'journal_id')::uuid;
  select * into receipt from public.books_projection_receipts where org_id=parent.org_id and source_type='labor_cost' and source_id=job.id;
  select value into original from jsonb_array_elements(parent.reconciliation#>'{workflowEvidence,sourceTables,job_cost_entries}') where value->>'id'=job.id::text;
  basis:=fact.payload->'labor_basis';
  if ownership.id is null or job.id is null or fact.id is null or journal.id is null or receipt.id is null or basis is null or ownership.id<>job.id or ownership.project_id<>job.project_id or ownership.cost_code_id is distinct from job.cost_code_id or ownership.time_entry_id<>time_row.id or ownership.fact_id<>fact.id or ownership.journal_id<>journal.id or ownership.projection_receipt_id<>receipt.id or ownership.created_at is distinct from (p_receipt->>'posted_at')::timestamptz or time_row.id is null or (time_row.status is null or time_row.status not in('pm_approved','client_approved','locked')) or original is null or public.books_payroll_job_economics(to_jsonb(job)) is distinct from public.books_payroll_job_economics(original) or job.updated_at is distinct from (original->>'updated_at')::timestamptz or job.source_type<>'time_entry' or job.status<>'posted' or fact.source_type<>'labor_cost' or fact.source_id<>job.id or journal.source_type<>'labor_cost' or journal.source_id<>job.id or journal.status<>'posted' or journal.fact_id<>fact.id or receipt.fact_id<>fact.id or receipt.journal_id<>journal.id or receipt.source_observed_at<job.updated_at or basis->>'job_cost_id' is distinct from job.id::text or basis->>'time_entry_id' is distinct from time_row.id::text then raise exception 'Payroll native ownership differs from original reviewed sources';end if;
  if time_row.project_id is distinct from job.project_id or time_row.cost_code_id is distinct from job.cost_code_id or time_row.work_date is distinct from job.incurred_on or time_row.worker_user_id::text is distinct from job.metadata->>'worker_user_id' or time_row.cost_cents is distinct from job.cost_cents then raise exception 'Payroll native time scope differs from original reviewed cost';end if;
  -- JSONB compares exact numeric values, including decimal hours/multipliers,
  -- without binary floating-point math or exposing original rates in ownership.
  if exists(select 1 from unnest(array['worker_company_id','hours','base_rate_cents','burden_multiplier','is_overtime','ot_multiplier','is_double_time','dt_multiplier','labor_cost_policy_version']) key where coalesce(to_jsonb(time_row)->key,'null'::jsonb) is distinct from coalesce(job.metadata->key,'null'::jsonb)) then raise exception 'Payroll native time economics differ from original reviewed cost';end if;
 end loop;
 if count_expected<>(select count(*) from public.books_payroll_labor_ownership where org_id=parent.org_id and posting_id=(p_receipt->>'id')::uuid) then raise exception 'Payroll native ownership inventory differs';end if;
 return true;
end $$;
revoke all on function public.assert_books_payroll_native_ownership(jsonb) from public,anon,authenticated;
grant execute on function public.assert_books_payroll_native_ownership(jsonb) to service_role;

create function public.guard_books_payroll_labor_ownership() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare posting public.books_payroll_postings;
begin
 if tg_op<>'INSERT' then raise exception 'Posted payroll native ownership is immutable';end if;
 select * into posting from public.books_payroll_postings where org_id=new.org_id and id=new.posting_id;
 if posting.id is null then raise exception 'Native ownership lacks atomic payroll posting';end if;
 perform public.assert_books_payroll_posting_receipt(to_jsonb(posting));return new;
end $$;
-- Mutation protection is immediate; insert proof waits for its posting parent.
create trigger books_payroll_labor_ownership_immutable before update or delete on public.books_payroll_labor_ownership for each row execute function public.books_reject_mutation();
create constraint trigger books_payroll_labor_ownership_proof after insert on public.books_payroll_labor_ownership deferrable initially deferred for each row execute function public.guard_books_payroll_labor_ownership();
revoke all on function public.guard_books_payroll_labor_ownership() from public,anon,authenticated;

create function public.assert_books_payroll_posting_financials(p_receipt jsonb) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
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
revoke all on function public.assert_books_payroll_posting_financials(jsonb) from public,anon,authenticated;
grant execute on function public.assert_books_payroll_posting_financials(jsonb) to service_role;

create or replace function public.assert_books_payroll_posting_receipt(p_receipt jsonb) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform public.assert_books_payroll_posting_financials(p_receipt);
 perform public.assert_books_payroll_native_ownership(p_receipt);return true;
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

-- Upgrade valid existing receipts under the same source fence. Changed original
-- evidence aborts the migration rather than inventing historical ownership.
do $$declare posting public.books_payroll_postings;begin
 for posting in select * from public.books_payroll_postings order by org_id,id loop
  perform public.claim_books_payroll_native_ownership(to_jsonb(posting));
  perform public.assert_books_payroll_posting_receipt(to_jsonb(posting));
 end loop;
end $$;
