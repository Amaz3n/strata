-- Immutable payroll preparation/review. Posting and source correction are
-- deliberately separate transitions; this migration does not post GL or cash.
create table public.books_payroll_imports (
 id uuid primary key,
 org_id uuid not null references public.orgs(id),
 provider text not null, provider_run_id text not null,
 period_start date not null, period_end date not null,
 status text not null default 'draft' check(status in('draft','reviewed','withdrawn')),
 source_checksum text not null check(source_checksum ~ '^[a-f0-9]{64}$'),
 source_proof jsonb not null, column_mapping jsonb not null,
 run jsonb not null, reconciliation jsonb not null, labor_evidence jsonb not null,
 evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
 mapping_digest text not null check(mapping_digest ~ '^[a-f0-9]{64}$'),
 reconciliation_digest text not null check(reconciliation_digest ~ '^[a-f0-9]{64}$'),
 source_revision text not null check(source_revision ~ '^[a-f0-9]{64}$'),
 prepared_by uuid not null references public.app_users(id), prepared_at timestamptz not null default now(),
 preparation_notes text not null check(length(trim(preparation_notes))>=10),
 reviewed_by uuid references public.app_users(id), reviewed_at timestamptz, review_notes text,
 withdrawn_by uuid references public.app_users(id), withdrawn_at timestamptz, withdrawal_reason text,
 idempotency_key text not null,
 unique(org_id,id), unique(org_id,idempotency_key),
 check(period_start<=period_end and period_end-period_start<=370),
 check(jsonb_typeof(run)='object' and jsonb_typeof(reconciliation)='object' and jsonb_typeof(source_proof)='object' and jsonb_typeof(column_mapping)='object' and jsonb_typeof(labor_evidence)='array'),
 check((reviewed_by is null and reviewed_at is null and review_notes is null and status<>'reviewed') or (reviewed_by is not null and reviewed_by<>prepared_by and reviewed_at is not null and length(trim(review_notes))>=10)),
 check((status<>'withdrawn' and withdrawn_by is null and withdrawn_at is null and withdrawal_reason is null) or (status='withdrawn' and withdrawn_by is not null and withdrawn_at is not null and length(trim(withdrawal_reason))>=10))
);
create unique index books_payroll_provider_run_active_idx on public.books_payroll_imports(org_id,provider,provider_run_id) where status<>'withdrawn';
create unique index books_payroll_source_active_idx on public.books_payroll_imports(org_id,source_checksum) where status<>'withdrawn';
create index books_payroll_period_idx on public.books_payroll_imports(org_id,period_start,period_end,status);
create index books_payroll_labor_evidence_idx on public.books_payroll_imports using gin(labor_evidence jsonb_path_ops);
alter table public.books_payroll_imports enable row level security;
revoke all on public.books_payroll_imports from public,anon,authenticated;
grant select,insert,update on public.books_payroll_imports to service_role;

-- One scoped dependency vector. Unrelated invoice/cash activity does not stale
-- a payroll review; new/moved time and missing/unowned labor do participate.
create function public.books_payroll_source_revision(p_snapshot jsonb,p_run jsonb)
returns text language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare basis jsonb; table_name text;
begin
 if p_snapshot->>'orgId' is distinct from p_run->>'org_id' then raise exception 'Payroll snapshot organization mismatch'; end if;
 foreach table_name in array array['time_entries','job_cost_entries','accounting_facts','journal_entries','journal_lines','books_projection_receipts','gl_accounts'] loop
  if jsonb_typeof(p_snapshot->'tables'->table_name) is distinct from 'array' then raise exception 'Missing payroll source table %',table_name; end if;
  if exists(select 1 from jsonb_array_elements(p_snapshot->'tables'->table_name) r where r.value->>'org_id' is distinct from p_run->>'org_id') then raise exception 'Foreign payroll source rows'; end if;
 end loop;
 with workers as(select value->>'worker_id' id from jsonb_array_elements(p_run->'employees')),
 requested as(select e.value#>>'{}' id from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a cross join lateral jsonb_array_elements(a.value->'labor_evidence_ids') e),
 times as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'time_entries') r where (r.value->>'work_date' between p_run->>'period_start' and p_run->>'period_end') and (r.value->>'worker_user_id' in(select id from workers) or r.value->>'worker_user_id' is null)
  or r.value->>'id' in(select c.value->>'source_id' from jsonb_array_elements(p_snapshot->'tables'->'job_cost_entries') c where c.value->>'id' in(select id from requested))),
 costs as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'job_cost_entries') r where r.value->>'source_type'='time_entry' and (r.value->>'id' in(select id from requested) or r.value->>'source_id' in(select value->>'id' from times) or (r.value->>'incurred_on' between p_run->>'period_start' and p_run->>'period_end') and (r.value#>>'{metadata,worker_user_id}' in(select id from workers) or r.value#>>'{metadata,worker_user_id}' is null))),
 facts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'accounting_facts') r where r.value->>'source_type'='labor_cost' and (r.value->>'source_id' in(select value->>'id' from costs) or (r.value->>'accounting_date' between p_run->>'period_start' and p_run->>'period_end') and (r.value#>>'{payload,labor_basis,worker_id}' in(select id from workers) or r.value#>>'{payload,labor_basis,worker_id}' is null))),
 entries as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_entries') r where r.value->>'source_type'='labor_cost' and (r.value->>'source_id' in(select value->>'id' from costs) or r.value->>'fact_id' in(select value->>'id' from facts) or (r.value->>'entry_date' between p_run->>'period_start' and p_run->>'period_end') and not exists(select 1 from jsonb_array_elements(p_snapshot->'tables'->'accounting_facts') f where f.value->>'id'=r.value->>'fact_id'))),
 lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'entry_id' in(select value->>'id' from entries)),
 receipts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'books_projection_receipts') r where r.value->>'source_type'='labor_cost' and r.value->>'source_id' in(select value->>'id' from costs union select value->>'source_id' from facts)),
 codes as(select '2200' code union select '2230' union select a.value->>'cost_account_code' from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a),
 accounts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'gl_accounts') r where r.value->>'code' in(select code from codes) or r.value->>'id' in(select value->>'account_id' from lines))
 select jsonb_build_object('times',coalesce((select jsonb_agg(value order by value->>'id') from times),'[]'), 'costs',coalesce((select jsonb_agg(value order by value->>'id') from costs),'[]'), 'facts',coalesce((select jsonb_agg(value order by value->>'id') from facts),'[]'), 'entries',coalesce((select jsonb_agg(value order by value->>'id') from entries),'[]'), 'lines',coalesce((select jsonb_agg(value order by value->>'id') from lines),'[]'), 'receipts',coalesce((select jsonb_agg(value order by value->>'source_id') from receipts),'[]'), 'accounts',coalesce((select jsonb_agg(value order by value->>'id') from accounts),'[]')) into basis;
 return encode(sha256(convert_to(basis::text,'UTF8')),'hex');
end $$;
revoke all on function public.books_payroll_source_revision(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_source_revision(jsonb,jsonb) to service_role;

create function public.capture_books_payroll_context(p_org_id uuid,p_run jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;
begin
 if p_run->>'org_id' is distinct from p_org_id::text then raise exception 'Payroll run organization mismatch'; end if;
 snapshot:=public.capture_books_export_snapshot(p_org_id);
 return snapshot||jsonb_build_object('payrollSourceRevision',public.books_payroll_source_revision(snapshot,p_run));
end $$;
revoke all on function public.capture_books_payroll_context(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.capture_books_payroll_context(uuid,jsonb) to service_role;

create function public.books_payroll_exact_amount(p_value jsonb) returns numeric language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare amount numeric;
begin
 if jsonb_typeof(p_value) is distinct from 'number' then raise exception 'Payroll amounts require exact safe nonnegative integer cents'; end if;
 amount:=(p_value#>>'{}')::numeric;
 if amount<0 or amount>9007199254740991 or amount<>trunc(amount) then raise exception 'Payroll amounts require exact safe nonnegative integer cents'; end if;
 return amount;
end $$;
revoke all on function public.books_payroll_exact_amount(jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_exact_amount(jsonb) to service_role;

create function public.guard_books_payroll_import() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proof jsonb; item jsonb; worker jsonb; allocation jsonb; seen uuid[]:='{}'; identifier uuid; basis jsonb; job public.job_cost_entries; fact public.accounting_facts; journal public.journal_entries; receipt public.books_projection_receipts; amount_key text; expected numeric; observed numeric;
begin
 if tg_op='DELETE' then raise exception 'Payroll import history cannot be deleted'; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('payroll-import:'||new.org_id::text,0)) then raise exception 'Payroll imports are changing concurrently; retry' using errcode='40001'; end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] then raise exception 'Payroll source, mapping and reconciliation evidence is immutable'; end if;
  if not ((old.status='draft' and new.status='reviewed' and new.withdrawn_by is null) or (old.status in('draft','reviewed') and new.status='withdrawn' and new.reviewed_by is not distinct from old.reviewed_by and new.reviewed_at is not distinct from old.reviewed_at and new.review_notes is not distinct from old.review_notes)) then raise exception 'Invalid payroll import transition'; end if;
 else
  if new.status<>'draft' or new.reviewed_by is not null or new.withdrawn_by is not null then raise exception 'Payroll imports must start as drafts'; end if;
  if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active') then raise exception 'Payroll preparer must be an active organization member'; end if;
  if new.run->>'id' is distinct from new.id::text or new.run->>'org_id' is distinct from new.org_id::text or new.run->>'provider' is distinct from new.provider or new.run->>'provider_run_id' is distinct from new.provider_run_id or new.run->>'period_start' is distinct from new.period_start::text or new.run->>'period_end' is distinct from new.period_end::text or new.run->>'source_checksum' is distinct from new.source_checksum or jsonb_typeof(new.run->'employees') is distinct from 'array' or jsonb_array_length(new.run->'employees')=0 then raise exception 'Payroll run requires exact scoped provider identity and period'; end if;
  foreach amount_key in array array['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents'] loop
   expected:=public.books_payroll_exact_amount(new.run->'controls'->amount_key);
   select sum(public.books_payroll_exact_amount(e.value->amount_key)) into observed from jsonb_array_elements(new.run->'employees') e;
   if observed is distinct from expected then raise exception 'Payroll provider control total differs'; end if;
  end loop;
  expected:=public.books_payroll_exact_amount(new.run#>'{controls,gross_cents}')+public.books_payroll_exact_amount(new.run#>'{controls,employer_taxes_cents}')+public.books_payroll_exact_amount(new.run#>'{controls,employer_benefits_cents}');
  if public.books_payroll_exact_amount(new.run#>'{controls,funding_cents}')<>expected then raise exception 'Payroll provider funding control differs'; end if;
  if new.reconciliation->'totals' is distinct from (new.run->'controls')-'funding_cents' then raise exception 'Payroll reconciliation totals differ from provider controls'; end if;
  for worker in select value from jsonb_array_elements(new.run->'employees') loop
   if public.books_payroll_exact_amount(worker->'gross_cents')=0 or public.books_payroll_exact_amount(worker->'gross_cents')<>public.books_payroll_exact_amount(worker->'net_cents')+public.books_payroll_exact_amount(worker->'employee_taxes_cents')+public.books_payroll_exact_amount(worker->'employee_deductions_cents') then raise exception 'Payroll employee gross, net and deductions differ'; end if;
   foreach amount_key in array array['gross_cents','employer_taxes_cents','employer_benefits_cents'] loop
    select sum(public.books_payroll_exact_amount(a.value->amount_key)) into observed from jsonb_array_elements(worker->'allocations') a;
    if observed is distinct from public.books_payroll_exact_amount(worker->amount_key) then raise exception 'Payroll construction allocation totals differ'; end if;
   end loop;
   identifier:=(worker->>'worker_id')::uuid;
   if identifier is null or identifier=any(seen) or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=identifier) then raise exception 'Payroll worker mappings require unique organization workers'; end if;
   seen:=array_append(seen,identifier);
   if exists(select 1 from public.books_payroll_imports p where p.org_id=new.org_id and p.status<>'withdrawn' and p.period_start<=new.period_end and p.period_end>=new.period_start and exists(select 1 from jsonb_array_elements(p.run->'employees') e where e.value->>'worker_id'=identifier::text)) then raise exception 'Payroll worker period is already reserved; use a reviewed correction workflow'; end if;
   for allocation in select value from jsonb_array_elements(worker->'allocations') loop
    if allocation->>'project_id' is not null and not exists(select 1 from public.projects where org_id=new.org_id and id=(allocation->>'project_id')::uuid) or allocation->>'cost_code_id' is not null and not exists(select 1 from public.cost_codes where org_id=new.org_id and id=(allocation->>'cost_code_id')::uuid) then raise exception 'Payroll allocation is outside organization'; end if;
   end loop;
  end loop;
  seen:='{}';
  for item in select value from jsonb_array_elements(new.labor_evidence) loop
   identifier:=(item->>'id')::uuid;
   if identifier is null or identifier=any(seen) or item->>'org_id' is distinct from new.org_id::text then raise exception 'Payroll labor evidence requires unique scoped sources'; end if;
   seen:=array_append(seen,identifier);
   if not exists(select 1 from jsonb_array_elements(new.run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a where w.value->>'worker_id'=item->>'worker_id' and a.value->>'project_id' is not distinct from item->>'project_id' and a.value->>'cost_code_id' is not distinct from item->>'cost_code_id' and a.value->>'cost_account_code'=item->>'account_code' and a.value->'labor_evidence_ids' @> jsonb_build_array(identifier::text)) or (item->>'incurred_on')::date not between new.period_start and new.period_end then raise exception 'Payroll labor is outside its worker, allocation or period'; end if;
   if exists(select 1 from public.books_payroll_imports p where p.org_id=new.org_id and p.status<>'withdrawn' and p.labor_evidence @> jsonb_build_array(jsonb_build_object('id',identifier))) then raise exception 'Payroll labor is already claimed by another run'; end if;
   select * into job from public.job_cost_entries where org_id=new.org_id and id=identifier for share;
   select * into fact from public.accounting_facts where org_id=new.org_id and id=(item->>'fact_id')::uuid;
   select * into journal from public.journal_entries where org_id=new.org_id and id=(item->>'journal_id')::uuid;
   select * into receipt from public.books_projection_receipts where org_id=new.org_id and source_type='labor_cost' and source_id=identifier;
   basis:=fact.payload->'labor_basis';
   if job.id is null or job.status<>'posted' or job.source_type<>'time_entry' or fact.id is null or fact.source_type<>'labor_cost' or fact.source_id<>job.id or journal.id is null or journal.status<>'posted' or journal.fact_id<>fact.id or journal.source_type<>'labor_cost' or journal.source_id<>job.id or receipt.fact_id is distinct from fact.id or receipt.journal_id is distinct from journal.id or receipt.source_observed_at<job.updated_at then raise exception 'Payroll labor posting changed before preparation'; end if;
   if basis is null or basis->>'time_entry_id' is distinct from job.source_id::text or basis->>'project_id' is distinct from job.project_id::text or basis->>'incurred_on' is distinct from job.incurred_on::text or basis->>'cost_cents' is distinct from job.cost_cents::text or fact.accounting_date is distinct from job.incurred_on or journal.entry_date is distinct from fact.accounting_date or basis->>'org_id' is distinct from new.org_id::text or basis->>'job_cost_id' is distinct from identifier::text or basis->>'worker_id' is distinct from item->>'worker_id' or basis->>'project_id' is distinct from item->>'project_id' or basis->>'cost_code_id' is distinct from item->>'cost_code_id' or basis->>'incurred_on' is distinct from item->>'incurred_on' or basis->>'source_revision' is distinct from item->>'source_revision' or basis->>'gross_cents' is distinct from item->>'gross_cents' or basis->>'estimated_burden_cents' is distinct from item->>'estimated_burden_cents' or basis->>'cost_cents' is distinct from item->>'cost_cents' or item->>'cost_cents' is distinct from item->>'clearing_cents' then raise exception 'Payroll original labor evidence differs'; end if;
  end loop;
 end if;
 if new.status='reviewed' and (new.reviewed_by=new.prepared_by or coalesce(length(trim(new.review_notes)),0)<10 or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active')) then raise exception 'Payroll review requires a separate active reviewer and substantive notes'; end if;
 if new.status='withdrawn' then
  if coalesce(length(trim(new.withdrawal_reason)),0)<10 or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.withdrawn_by and status='active') then raise exception 'Payroll withdrawal requires an active actor and reason'; end if;
  return new;
 end if;
 proof:=new.source_proof;
 if proof->>'version' is distinct from '1' or proof->>'org_id' is distinct from new.org_id::text or proof->>'checksum' is distinct from new.source_checksum or proof->>'document_version_id' is null then raise exception 'Payroll requires a frozen original document version'; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||new.org_id::text||':'||(proof->>'file_id'),0)) then raise exception 'Payroll document evidence is changing concurrently; retry' using errcode='40001'; end if;
 perform 1 from public.files where org_id=new.org_id and id=(proof->>'file_id')::uuid for share;
 if not found then raise exception 'Payroll source file is outside organization'; end if;
 perform 1 from public.doc_versions where org_id=new.org_id and id=(proof->>'document_version_id')::uuid and file_id=(proof->>'file_id')::uuid and storage_path=proof->>'storage_path' and checksum=proof->>'checksum' and size_bytes=(proof->>'size_bytes')::bigint and file_name=proof->>'file_name' and mime_type is not distinct from proof->>'mime_type' for share;
 if not found then raise exception 'Payroll original document version changed'; end if;
 if public.books_payroll_source_revision(public.capture_books_export_snapshot(new.org_id),new.run) is distinct from new.source_revision then raise exception 'Payroll source revision changed; withdraw and prepare current evidence'; end if;
 return new;
end $$;
create trigger books_payroll_import_guard before insert or update or delete on public.books_payroll_imports for each row execute function public.guard_books_payroll_import();
revoke all on function public.guard_books_payroll_import() from public,anon,authenticated;

create function public.prepare_books_payroll_import(p_org_id uuid,p_actor_id uuid,p_evidence jsonb,p_notes text,p_idempotency_key text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_payroll_imports; result uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Payroll preparer must be an active organization member'; end if;
 if coalesce(length(trim(p_idempotency_key)),0)<10 or coalesce(length(trim(p_notes)),0)<10 then raise exception 'Payroll preparation requires retry identity and substantive notes'; end if;
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into previous from public.books_payroll_imports where org_id=p_org_id and idempotency_key=p_idempotency_key;
 if found then
  if previous.prepared_by<>p_actor_id or previous.run is distinct from p_evidence->'run' or previous.reconciliation is distinct from p_evidence->'reconciliation' or previous.labor_evidence is distinct from p_evidence->'labor_evidence' or previous.source_proof is distinct from p_evidence->'source_proof' or previous.column_mapping is distinct from p_evidence->'column_mapping' or previous.evidence_digest is distinct from p_evidence->>'evidence_digest' or previous.reconciliation_digest is distinct from p_evidence->>'reconciliation_digest' or previous.mapping_digest is distinct from p_evidence->>'mapping_digest' or previous.source_revision is distinct from p_evidence->>'source_revision' or previous.preparation_notes is distinct from p_notes then raise exception 'Payroll retry key has different evidence'; end if;
  return previous.id;
 end if;
 insert into public.books_payroll_imports(id,org_id,provider,provider_run_id,period_start,period_end,source_checksum,source_proof,column_mapping,run,reconciliation,labor_evidence,evidence_digest,mapping_digest,reconciliation_digest,source_revision,prepared_by,preparation_notes,idempotency_key)
 values((p_evidence#>>'{run,id}')::uuid,p_org_id,p_evidence#>>'{run,provider}',p_evidence#>>'{run,provider_run_id}',(p_evidence#>>'{run,period_start}')::date,(p_evidence#>>'{run,period_end}')::date,p_evidence#>>'{run,source_checksum}',p_evidence->'source_proof',p_evidence->'column_mapping',p_evidence->'run',p_evidence->'reconciliation',p_evidence->'labor_evidence',p_evidence->>'evidence_digest',p_evidence->>'mapping_digest',p_evidence->>'reconciliation_digest',p_evidence->>'source_revision',p_actor_id,p_notes,p_idempotency_key) returning id into result;
 return result;
end $$;
revoke all on function public.prepare_books_payroll_import(uuid,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.prepare_books_payroll_import(uuid,uuid,jsonb,text,text) to service_role;

create function public.review_books_payroll_import(p_org_id uuid,p_id uuid,p_actor_id uuid,p_evidence jsonb,p_notes text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_imports;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into item from public.books_payroll_imports where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Payroll import not found in organization'; end if;
 if p_actor_id=item.prepared_by or coalesce(length(trim(p_notes)),0)<10 or not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Payroll review requires a separate active reviewer and substantive notes'; end if;
 if item.run is distinct from p_evidence->'run' or item.reconciliation is distinct from p_evidence->'reconciliation' or item.labor_evidence is distinct from p_evidence->'labor_evidence' or item.source_proof is distinct from p_evidence->'source_proof' or item.column_mapping is distinct from p_evidence->'column_mapping' or item.evidence_digest is distinct from p_evidence->>'evidence_digest' or item.reconciliation_digest is distinct from p_evidence->>'reconciliation_digest' or item.mapping_digest is distinct from p_evidence->>'mapping_digest' or item.source_revision is distinct from p_evidence->>'source_revision' then raise exception 'Payroll source or reconciliation changed; withdraw and prepare current evidence'; end if;
 if public.books_payroll_source_revision(public.capture_books_export_snapshot(p_org_id),item.run) is distinct from item.source_revision then raise exception 'Payroll source revision changed before review'; end if;
 if item.status='reviewed' and item.reviewed_by=p_actor_id and item.review_notes=p_notes then return item.id; end if;
 if item.status<>'draft' then raise exception 'Payroll review requires a draft'; end if;
 update public.books_payroll_imports set status='reviewed',reviewed_by=p_actor_id,reviewed_at=now(),review_notes=p_notes where id=item.id;
 return item.id;
end $$;
revoke all on function public.review_books_payroll_import(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.review_books_payroll_import(uuid,uuid,uuid,jsonb,text) to service_role;

create function public.withdraw_books_payroll_import(p_org_id uuid,p_id uuid,p_actor_id uuid,p_reason text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_imports;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into item from public.books_payroll_imports where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Payroll import not found in organization'; end if;
 if coalesce(length(trim(p_reason)),0)<10 or not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Payroll withdrawal requires an active actor and reason'; end if;
 if item.status='withdrawn' and item.withdrawn_by=p_actor_id and item.withdrawal_reason=p_reason then return item.id; end if;
 if item.status not in('draft','reviewed') then raise exception 'Payroll import cannot be withdrawn'; end if;
 update public.books_payroll_imports set status='withdrawn',withdrawn_by=p_actor_id,withdrawn_at=now(),withdrawal_reason=p_reason where id=item.id;
 return item.id;
end $$;
revoke all on function public.withdraw_books_payroll_import(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.withdraw_books_payroll_import(uuid,uuid,uuid,text) to service_role;

-- Internal trigger lookup only: browser document writers cannot read the
-- private payroll table, but they must still preserve its original evidence.
create function public.protect_books_payroll_document_evidence() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare file_identifier uuid;
begin
 if tg_table_name='files' then file_identifier:=old.id; else file_identifier:=old.file_id; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||old.org_id::text||':'||file_identifier::text,0)) then raise exception 'Payroll document evidence is changing concurrently; retry' using errcode='40001'; end if;
 if tg_table_name='files' then
  if exists(select 1 from public.books_payroll_imports where org_id=old.org_id and source_proof->>'file_id'=old.id::text) then
   if tg_op='DELETE' then raise exception 'Payroll source document history cannot be deleted'; end if;
   if new.id is distinct from old.id or new.org_id is distinct from old.org_id then raise exception 'Payroll source document identity is immutable'; end if;
   if new.storage_path is not distinct from old.storage_path and (new.checksum is distinct from old.checksum or new.size_bytes is distinct from old.size_bytes) and exists(select 1 from public.books_payroll_imports where org_id=old.org_id and source_proof->>'file_id'=old.id::text and source_proof->>'storage_path'=old.storage_path) then raise exception 'Payroll original object metadata is immutable'; end if;
   if new.storage_path is distinct from old.storage_path and exists(select 1 from public.books_payroll_imports where org_id=old.org_id and source_proof->>'file_id'=old.id::text and source_proof->>'storage_path'=old.storage_path) and not exists(select 1 from public.doc_versions where org_id=old.org_id and file_id=old.id and storage_path=old.storage_path and checksum=old.checksum and size_bytes=old.size_bytes) then raise exception 'Missing retained original payroll document version'; end if;
  end if;
 else
  if tg_op='UPDATE' and to_jsonb(new)-array['label','notes'] is not distinct from to_jsonb(old)-array['label','notes'] then return new; end if;
  if exists(select 1 from public.books_payroll_imports where org_id=old.org_id and source_proof->>'document_version_id'=old.id::text) then raise exception 'Payroll original document version evidence is immutable'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.protect_books_payroll_document_evidence() from public,anon,authenticated;
create trigger books_payroll_file_evidence_guard before update or delete on public.files for each row execute function public.protect_books_payroll_document_evidence();
create trigger books_payroll_version_evidence_guard before update or delete on public.doc_versions for each row execute function public.protect_books_payroll_document_evidence();
create index books_payroll_source_file_idx on public.books_payroll_imports(org_id,(source_proof->>'file_id'));
create index books_payroll_source_version_idx on public.books_payroll_imports(org_id,(source_proof->>'document_version_id'));


-- Schema v9 payroll draft/review history participates in the MVCC archive.
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
