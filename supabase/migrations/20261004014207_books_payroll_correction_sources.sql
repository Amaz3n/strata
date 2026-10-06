-- Corrected provider source history, not a correction posting approval.
create table public.books_payroll_correction_sources(
 id uuid primary key,org_id uuid not null references public.orgs(id),posting_id uuid not null,
 revision integer not null check(revision>0),status text not null default 'draft' check(status in('draft','reviewed','withdrawn')),
 request jsonb not null,run jsonb not null,source_proof jsonb not null,column_mapping jsonb not null,account_snapshot jsonb not null,
 source_mapping_digest text not null check(source_mapping_digest~'^[a-f0-9]{64}$'),evidence_hash text not null check(evidence_hash~'^[a-f0-9]{64}$'),
 prepared_by uuid not null references public.app_users(id),prepared_at timestamptz not null default now(),preparation_notes text not null check(length(trim(preparation_notes)) between 10 and 4000),
 reviewed_by uuid references public.app_users(id),reviewed_at timestamptz,review_notes text,
 withdrawn_by uuid references public.app_users(id),withdrawn_at timestamptz,withdrawal_reason text,
 idempotency_key text not null check(length(trim(idempotency_key)) between 10 and 200),
 unique(org_id,id),unique(org_id,posting_id,revision),unique(org_id,idempotency_key),
 foreign key(org_id,posting_id) references public.books_payroll_postings(org_id,id),
 check((reviewed_by is null and reviewed_at is null and review_notes is null and status<>'reviewed') or(reviewed_by is not null and reviewed_by<>prepared_by and reviewed_at is not null and length(trim(review_notes)) between 10 and 4000 and status<>'draft')),
 check((status<>'withdrawn' and withdrawn_by is null and withdrawn_at is null and withdrawal_reason is null) or(status='withdrawn' and withdrawn_by is not null and withdrawn_at is not null and length(trim(withdrawal_reason)) between 10 and 4000))
);
create unique index books_payroll_correction_source_draft_idx on public.books_payroll_correction_sources(org_id,posting_id) where status='draft';
create index books_payroll_correction_source_file_idx on public.books_payroll_correction_sources(org_id,(source_proof->>'file_id'));
create index books_payroll_correction_source_version_idx on public.books_payroll_correction_sources(org_id,(source_proof->>'document_version_id'));
alter table public.books_payroll_correction_sources enable row level security;
revoke all on public.books_payroll_correction_sources from public,anon,authenticated;
grant select,insert,update on public.books_payroll_correction_sources to service_role;
create policy books_payroll_correction_source_service on public.books_payroll_correction_sources to service_role using(true) with check(true);

create function public.books_payroll_correction_source_hash(p_evidence jsonb) returns text language sql immutable security invoker set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(jsonb_build_object('request',p_evidence->'request','run',p_evidence->'run','source_proof',p_evidence->'source_proof','column_mapping',p_evidence->'column_mapping','source_mapping_digest',p_evidence->'source_mapping_digest','account_snapshot',p_evidence->'account_snapshot')::text,'UTF8')),'hex')
$$;
revoke all on function public.books_payroll_correction_source_hash(jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_correction_source_hash(jsonb) to service_role;

create function public.validate_books_payroll_correction_source(p_org uuid,p_id uuid,p_posting uuid,p_evidence jsonb) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare posting public.books_payroll_postings; parent public.books_payroll_imports; r jsonb:=p_evidence->'run'; proof jsonb:=p_evidence->'source_proof'; w jsonb; a jsonb; item jsonb; key text; expected numeric; actual numeric; seen_workers uuid[]:='{}';seen_allocations uuid[]:='{}';seen_native uuid[]:='{}'; identifier uuid; version_row public.doc_versions; latest_date date;
begin
 if jsonb_typeof(p_evidence->'request') is distinct from 'object' or (p_evidence->'request')-array['id','postingId','accountingDate','reason']<>'{}'::jsonb or jsonb_typeof(r) is distinct from 'object' or r-array['id','org_id','provider','provider_run_id','period_start','period_end','accrual_date','pay_date','source_checksum','employees','controls']<>'{}'::jsonb or jsonb_typeof(r->'controls') is distinct from 'object' or (r->'controls')-array['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents','funding_cents']<>'{}'::jsonb then raise exception 'Correction register/request shape differs';end if;
 select * into posting from public.books_payroll_postings where org_id=p_org and id=p_posting for share;
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
revoke all on function public.validate_books_payroll_correction_source(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.validate_books_payroll_correction_source(uuid,uuid,uuid,jsonb) to service_role;

create function public.guard_books_payroll_correction_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare posting public.books_payroll_postings;parent public.books_payroll_imports;proposal public.books_payroll_posting_proposals;payment public.books_payroll_payment_reviews;actor uuid; expected_revision integer;
begin
 if tg_op='DELETE' then raise exception 'Correction source history cannot be deleted';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('payroll-import:'||new.org_id::text,0)) then raise exception 'Payroll correction source is changing; retry' using errcode='40001';end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] then raise exception 'Corrected provider evidence and version are immutable';end if;
  if not((old.status='draft' and new.status='reviewed') or(old.status in('draft','reviewed') and new.status='withdrawn' and new.reviewed_by is not distinct from old.reviewed_by and new.reviewed_at is not distinct from old.reviewed_at and new.review_notes is not distinct from old.review_notes)) then raise exception 'Invalid correction source transition';end if;
 else
  select coalesce(max(revision),0)+1 into expected_revision from public.books_payroll_correction_sources where org_id=new.org_id and posting_id=new.posting_id;
  if new.status<>'draft' or new.reviewed_by is not null or new.withdrawn_by is not null or new.revision<>expected_revision then raise exception 'Correction source must start with next immutable documentary revision';end if;
 end if;
 actor:=case new.status when 'reviewed' then new.reviewed_by when 'withdrawn' then new.withdrawn_by else new.prepared_by end;
 perform 1 from public.memberships where org_id=new.org_id and user_id=actor and status='active' for share;
 if not found then raise exception 'Correction source requires active actor';end if;
 if new.status='withdrawn' then return new;end if;
 if new.evidence_hash is distinct from public.books_payroll_correction_source_hash(to_jsonb(new)) then raise exception 'Correction source hash differs';end if;
 perform public.validate_books_payroll_correction_source(new.org_id,new.id,new.posting_id,to_jsonb(new));
 if new.status='reviewed' then
  select * into posting from public.books_payroll_postings where org_id=new.org_id and id=new.posting_id;
  select * into parent from public.books_payroll_imports where org_id=new.org_id and id=posting.payroll_import_id;
  select * into proposal from public.books_payroll_posting_proposals where org_id=new.org_id and id=posting.proposal_id;
  select * into payment from public.books_payroll_payment_reviews where org_id=new.org_id and id=proposal.payment_review_id;
  if new.reviewed_by in(new.prepared_by,parent.prepared_by,proposal.prepared_by) or new.reviewed_by=payment.prepared_by then raise exception 'Correction source requires reviewer separate from all preparers';end if;
 end if;
 return new;
end $$;
create trigger books_payroll_correction_source_guard before insert or update or delete on public.books_payroll_correction_sources for each row execute function public.guard_books_payroll_correction_source();
revoke all on function public.guard_books_payroll_correction_source() from public,anon,authenticated;

create function public.prepare_books_payroll_correction_source(p_org_id uuid,p_actor_id uuid,p_evidence jsonb,p_notes text,p_key text) returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare old public.books_payroll_correction_sources;identifier uuid:=(p_evidence#>>'{request,id}')::uuid;root uuid:=(p_evidence#>>'{request,postingId}')::uuid;next_revision integer;
begin
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' for share;if not found then raise exception 'Correction source requires active preparer';end if;
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into old from public.books_payroll_correction_sources where org_id=p_org_id and idempotency_key=p_key;
 if found then
  if old.id is distinct from identifier or old.posting_id is distinct from root or old.prepared_by is distinct from p_actor_id or old.preparation_notes is distinct from p_notes or old.request is distinct from p_evidence->'request' or old.run is distinct from p_evidence->'run' or old.source_proof is distinct from p_evidence->'source_proof' or old.column_mapping is distinct from p_evidence->'column_mapping' or old.source_mapping_digest is distinct from p_evidence->>'source_mapping_digest' or old.account_snapshot is distinct from p_evidence->'account_snapshot' then raise exception 'Correction retry key belongs to different intent or evidence';end if;return old.id;
 end if;
 select coalesce(max(revision),0)+1 into next_revision from public.books_payroll_correction_sources where org_id=p_org_id and posting_id=root;
 insert into public.books_payroll_correction_sources(id,org_id,posting_id,revision,request,run,source_proof,column_mapping,account_snapshot,source_mapping_digest,evidence_hash,prepared_by,preparation_notes,idempotency_key) values(identifier,p_org_id,root,next_revision,p_evidence->'request',p_evidence->'run',p_evidence->'source_proof',p_evidence->'column_mapping',p_evidence->'account_snapshot',p_evidence->>'source_mapping_digest',public.books_payroll_correction_source_hash(p_evidence),p_actor_id,p_notes,p_key);
 return identifier;
end $$;
create function public.review_books_payroll_correction_source(p_org_id uuid,p_id uuid,p_actor_id uuid,p_evidence jsonb,p_notes text) returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_correction_sources;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into item from public.books_payroll_correction_sources where org_id=p_org_id and id=p_id for update;
 if item.id is null or item.status<>'draft' or item.request is distinct from p_evidence->'request' or item.run is distinct from p_evidence->'run' or item.source_proof is distinct from p_evidence->'source_proof' or item.column_mapping is distinct from p_evidence->'column_mapping' or item.source_mapping_digest is distinct from p_evidence->>'source_mapping_digest' or item.account_snapshot is distinct from p_evidence->'account_snapshot' then raise exception 'Correction source changed or is not awaiting review';end if;
 update public.books_payroll_correction_sources set status='reviewed',reviewed_by=p_actor_id,reviewed_at=now(),review_notes=p_notes where org_id=p_org_id and id=p_id;return p_id;
end $$;
create function public.withdraw_books_payroll_correction_source(p_org_id uuid,p_id uuid,p_actor_id uuid,p_reason text) returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 update public.books_payroll_correction_sources set status='withdrawn',withdrawn_by=p_actor_id,withdrawn_at=now(),withdrawal_reason=p_reason where org_id=p_org_id and id=p_id and status in('draft','reviewed');
 if not found then raise exception 'Correction source is not withdrawable';end if;return p_id;
end $$;
revoke all on function public.prepare_books_payroll_correction_source(uuid,uuid,jsonb,text,text),public.review_books_payroll_correction_source(uuid,uuid,uuid,jsonb,text),public.withdraw_books_payroll_correction_source(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_books_payroll_correction_source(uuid,uuid,jsonb,text,text),public.review_books_payroll_correction_source(uuid,uuid,uuid,jsonb,text),public.withdraw_books_payroll_correction_source(uuid,uuid,uuid,text) to service_role;

-- Extend the existing legacy document protector; no new definer RPC or grants.
create or replace function public.protect_books_payroll_document_evidence() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare file_identifier uuid;
begin
 if tg_table_name='files' then file_identifier:=old.id; else file_identifier:=old.file_id; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||old.org_id::text||':'||file_identifier::text,0)) then raise exception 'Payroll document evidence is changing concurrently; retry' using errcode='40001'; end if;
 if tg_table_name='files' then
  if exists(select 1 from (select org_id,source_proof from public.books_payroll_imports union all select org_id,source_proof from public.books_payroll_correction_sources) owned where org_id=old.org_id and source_proof->>'file_id'=old.id::text) then
   if tg_op='DELETE' then raise exception 'Payroll source document history cannot be deleted'; end if;
   if new.id is distinct from old.id or new.org_id is distinct from old.org_id then raise exception 'Payroll source document identity is immutable'; end if;
   if new.storage_path is not distinct from old.storage_path and (new.checksum is distinct from old.checksum or new.size_bytes is distinct from old.size_bytes) and exists(select 1 from (select org_id,source_proof from public.books_payroll_imports union all select org_id,source_proof from public.books_payroll_correction_sources) owned where org_id=old.org_id and source_proof->>'file_id'=old.id::text and source_proof->>'storage_path'=old.storage_path) then raise exception 'Payroll original object metadata is immutable'; end if;
   if new.storage_path is distinct from old.storage_path and exists(select 1 from (select org_id,source_proof from public.books_payroll_imports union all select org_id,source_proof from public.books_payroll_correction_sources) owned where org_id=old.org_id and source_proof->>'file_id'=old.id::text and source_proof->>'storage_path'=old.storage_path) and not exists(select 1 from public.doc_versions where org_id=old.org_id and file_id=old.id and storage_path=old.storage_path and checksum=old.checksum and size_bytes=old.size_bytes) then raise exception 'Missing retained original payroll document version'; end if;
  end if;
 else
  if tg_op='UPDATE' and to_jsonb(new)-array['label','notes'] is not distinct from to_jsonb(old)-array['label','notes'] then return new; end if;
  if exists(select 1 from (select org_id,source_proof from public.books_payroll_imports union all select org_id,source_proof from public.books_payroll_correction_sources) owned where org_id=old.org_id and source_proof->>'document_version_id'=old.id::text) then raise exception 'Payroll original document version evidence is immutable'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
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
    'books_payroll_correction_sources',
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
