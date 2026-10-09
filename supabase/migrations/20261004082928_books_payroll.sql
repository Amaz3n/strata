-- Payroll imports, payment reviews, posting proposals and atomic posting, corrections, private payroll documents and the payroll workspaces (B13; ships dark, after day one).
--
-- Consolidated before deploy (2026-10-09) from 25 unapplied migrations, in their
-- original order; each section is marked with the file it came from.

-- ==== 20261003195833_books_time_cost_double_time_policy ====
-- Keep the formula used by historical rows; only new time entries adopt the
-- double-time fix by default. Changing legacy policy is a reviewed source
-- correction, not part of this migration. PostgreSQL 17+ preserves the generated
-- column identity and dependent objects with SET EXPRESSION.
alter table public.time_entries add column labor_cost_policy_version smallint not null default 0
 check (labor_cost_policy_version in (0,1));
alter table public.time_entries alter column labor_cost_policy_version set default 1;
alter table public.time_entries alter column cost_cents set expression as (
 round(hours * base_rate_cents::numeric * burden_multiplier *
  case when labor_cost_policy_version=0 then case when is_overtime then ot_multiplier else 1 end
   when is_double_time then dt_multiplier
   when is_overtime then ot_multiplier else 1 end)::integer
);
comment on column public.time_entries.labor_cost_policy_version is
 '0 retains the original overtime-only cost calculation. 1 includes double time. Legacy double-time differences require reviewed correction or payroll reconciliation.';
analyze public.time_entries;

-- ==== 20261003203019_books_payroll_import_drafts ====
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

-- ==== 20261003214553_books_payroll_liability_history ====
-- Preserve the original function identity so existing prepared PL/pgSQL callers
-- use the widened dependency vector. Previously prepared runs intentionally
-- become stale and require withdrawal/repreparation; never rewrite their proof.
create function public.books_payroll_labor_source_revision(p_snapshot jsonb,p_run jsonb)
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
revoke all on function public.books_payroll_labor_source_revision(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_labor_source_revision(jsonb,jsonb) to service_role;


create or replace function public.books_payroll_source_revision(p_snapshot jsonb,p_run jsonb)
returns text language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare labor_revision text; history jsonb;
begin
 labor_revision:=public.books_payroll_labor_source_revision(p_snapshot,p_run);
 -- Native labor already participates in the worker/source vector above.
 -- Non-labor wage/deduction movements have no reliable worker-period ownership
 -- in legacy/manual settlements. Capture all history, including future-dated
 -- entries and both original/reversal journals, rather than guessing that a
 -- payment outside the work period belongs to a different payroll run.
 with accounts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'gl_accounts') r where r.value->>'code' in('2200','2230')),
 liability_lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'account_id' in(select value->>'id' from accounts) or r.value#>>'{dimensions,books_account_classification,code}' in('2200','2230')),
 entries as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_entries') r where r.value->>'status' in('posted','reversed') and r.value->>'source_type' is distinct from 'labor_cost' and r.value->>'id' in(select value->>'entry_id' from liability_lines)),
 lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'entry_id' in(select value->>'id' from entries))
 select jsonb_build_object('entries',coalesce((select jsonb_agg(value order by value->>'id') from entries),'[]'),'lines',coalesce((select jsonb_agg(value order by value->>'id') from lines),'[]')) into history;
 return encode(sha256(convert_to(jsonb_build_object('version',2,'labor_revision',labor_revision,'liability_history',history)::text,'UTF8')),'hex');
end $$;
revoke all on function public.books_payroll_source_revision(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_source_revision(jsonb,jsonb) to service_role;

-- ==== 20261003220020_books_payroll_workflow_evidence ====
-- Frozen construction/payment source witnesses inside versioned reconciliation
-- JSON. No new columns, posting transition or money movement. Older ledger-only
-- evidence remains retained/readable and is not a complete posting approval.
create function public.books_payroll_liability_source_revision(p_snapshot jsonb,p_run jsonb)
returns text language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare labor_revision text; history jsonb;
begin
 labor_revision:=public.books_payroll_labor_source_revision(p_snapshot,p_run);
 -- Native labor already participates in the worker/source vector above.
 -- Non-labor wage/deduction movements have no reliable worker-period ownership
 -- in legacy/manual settlements. Capture all history, including future-dated
 -- entries and both original/reversal journals, rather than guessing that a
 -- payment outside the work period belongs to a different payroll run.
 with accounts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'gl_accounts') r where r.value->>'code' in('2200','2230')),
 liability_lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'account_id' in(select value->>'id' from accounts) or r.value#>>'{dimensions,books_account_classification,code}' in('2200','2230')),
 entries as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_entries') r where r.value->>'status' in('posted','reversed') and r.value->>'source_type' is distinct from 'labor_cost' and r.value->>'id' in(select value->>'entry_id' from liability_lines)),
 lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'entry_id' in(select value->>'id' from entries))
 select jsonb_build_object('entries',coalesce((select jsonb_agg(value order by value->>'id') from entries),'[]'),'lines',coalesce((select jsonb_agg(value order by value->>'id') from lines),'[]')) into history;
 return encode(sha256(convert_to(jsonb_build_object('version',2,'labor_revision',labor_revision,'liability_history',history)::text,'UTF8')),'hex');
end $$;
revoke all on function public.books_payroll_liability_source_revision(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_liability_source_revision(jsonb,jsonb) to service_role;

create function public.books_payroll_workflow_sources(p_snapshot jsonb,p_run jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; name text;
begin
 if p_snapshot->>'orgId' is distinct from p_run->>'org_id' then raise exception 'Payroll workflow organization mismatch'; end if;
 foreach name in array array['job_cost_entries','budgets','budget_lines','billable_costs','journal_entries','journal_lines','gl_accounts'] loop
  if jsonb_typeof(p_snapshot->'tables'->name) is distinct from 'array' then raise exception 'Missing payroll workflow population %',name; end if;
  if exists(select 1 from jsonb_array_elements(p_snapshot->'tables'->name) r where r.value->>'org_id' is distinct from p_run->>'org_id') then raise exception 'Foreign payroll workflow source'; end if;
 end loop;
 with requested as(select e.value#>>'{}' id from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a cross join lateral jsonb_array_elements(a.value->'labor_evidence_ids') e),
 jobs as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'job_cost_entries') r where r.value->>'id' in(select id from requested)),
 budget_lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'budget_lines') r where r.value->>'id' in(select value->>'budget_line_id' from jobs)),
 budgets as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'budgets') r where r.value->>'id' in(select value->>'budget_id' from budget_lines)),
 billables as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'billable_costs') r where r.value->>'source_type'='time_entry' and r.value->>'source_id' in(select value->>'source_id' from jobs) or r.value->>'id' in(select value->>'billable_cost_id' from jobs)),
 liability_accounts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'gl_accounts') r where r.value->>'code' in('2200','2230')),
 liability_lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'account_id' in(select value->>'id' from liability_accounts) or r.value#>>'{dimensions,books_account_classification,code}' in('2200','2230')),
 entries as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_entries') r where r.value->>'id' in(select value->>'entry_id' from liability_lines) and r.value->>'status' in('posted','reversed') and r.value->>'source_type' is distinct from 'labor_cost'),
 lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'entry_id' in(select value->>'id' from entries)),
 codes as(select '2200' code union select '2230' union select a.value->>'cost_account_code' from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a),
 accounts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'gl_accounts') r where r.value->>'code' in(select code from codes) or r.value->>'id' in(select value->>'account_id' from lines))
 select jsonb_build_object('job_cost_entries',coalesce((select jsonb_agg(value order by value->>'id') from jobs),'[]'),'budget_lines',coalesce((select jsonb_agg(value order by value->>'id') from budget_lines),'[]'),'budgets',coalesce((select jsonb_agg(value order by value->>'id') from budgets),'[]'),'billable_costs',coalesce((select jsonb_agg(value order by value->>'id') from billables),'[]'),'journal_entries',coalesce((select jsonb_agg(value order by value->>'id') from entries),'[]'),'journal_lines',coalesce((select jsonb_agg(value order by value->>'id') from lines),'[]'),'gl_accounts',coalesce((select jsonb_agg(value order by value->>'id') from accounts),'[]')) into result;
 return result;
end $$;
revoke all on function public.books_payroll_workflow_sources(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_workflow_sources(jsonb,jsonb) to service_role;

-- Keep the existing function OID so prepared SQL callers receive v3 too.
create or replace function public.books_payroll_source_revision(p_snapshot jsonb,p_run jsonb)
returns text language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
begin
 return encode(sha256(convert_to(jsonb_build_object('version',3,'previous_revision',public.books_payroll_liability_source_revision(p_snapshot,p_run),'workflow_sources',public.books_payroll_workflow_sources(p_snapshot,p_run))::text,'UTF8')),'hex');
end $$;
revoke all on function public.books_payroll_source_revision(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_source_revision(jsonb,jsonb) to service_role;

create function public.guard_books_payroll_workflow_evidence() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proof jsonb; sources jsonb; construction jsonb; worker jsonb; allocation jsonb; item jsonb; expected_components jsonb; corrections jsonb;
 native_gross numeric; native_burden numeric; native_cost numeric; actual_cost numeric; delta numeric; project_delta numeric:=0; overhead_delta numeric:=0;
 count_expected integer:=0; count_observed integer; budget_id text; gmp text; wages numeric; deductions numeric; amount_key text;
begin
 if tg_op='UPDATE' and new.status='withdrawn' then return new; end if;
 -- Legacy evidence remains immutable/readable. Any future posting transition
 -- must require v2 evidence plus resolved attribution, never this legacy branch.
 if not(new.reconciliation ? 'evidenceVersion') and not(new.reconciliation ? 'workflowEvidence') then return new; end if;
 if new.reconciliation->'evidenceVersion' is distinct from '2'::jsonb then raise exception 'Unsupported payroll workflow evidence version'; end if;
 proof:=new.reconciliation->'workflowEvidence'; construction:=proof->'constructionImpact';
 if proof->'version' is distinct from '1'::jsonb or construction->>'runId' is distinct from new.id::text or construction->'previewOnly' is distinct from 'true'::jsonb or construction->'postingImplemented' is distinct from 'false'::jsonb or proof#>>'{liabilityHistory,orgId}' is distinct from new.org_id::text or proof#>'{liabilityHistory,unpaidStatusProven}' is distinct from 'false'::jsonb then raise exception 'Payroll workflow requires scoped advisory construction and liability evidence'; end if;
 sources:=public.books_payroll_workflow_sources(public.capture_books_export_snapshot(new.org_id),new.run);
 if proof->'sourceTables' is distinct from sources then raise exception 'Payroll workflow source records changed or are incomplete'; end if;
 for worker in select value from jsonb_array_elements(new.run->'employees') loop
  for allocation in select value from jsonb_array_elements(worker->'allocations') loop
   count_expected:=count_expected+1;
   select count(*) into count_observed from jsonb_array_elements(construction->'allocations') r where r.value->>'allocationId'=allocation->>'id';
   if count_observed<>1 then raise exception 'Payroll workflow requires every allocation exactly once'; end if;
   select value into item from jsonb_array_elements(construction->'allocations') r where r.value->>'allocationId'=allocation->>'id';
   foreach amount_key in array array['originalCostCents','actualCostCents','costDeltaCents'] loop
    if jsonb_typeof(item->amount_key) is distinct from 'number' then raise exception 'Payroll workflow costs require JSON integer cents'; end if;
   end loop;
   if item->>'workerId' is distinct from worker->>'worker_id' or item->>'projectId' is distinct from allocation->>'project_id' or item->>'costCodeId' is distinct from allocation->>'cost_code_id' or item->>'accountCode' is distinct from allocation->>'cost_account_code' or item->>'incurredOn' is distinct from new.run->>'accrual_date' then raise exception 'Payroll workflow allocation identity differs'; end if;
   select coalesce(sum((e.value->>'gross_cents')::numeric),0),coalesce(sum((e.value->>'estimated_burden_cents')::numeric),0),coalesce(sum((e.value->>'cost_cents')::numeric),0) into native_gross,native_burden,native_cost from jsonb_array_elements(new.labor_evidence) e where e.value->>'id' in(select value#>>'{}' from jsonb_array_elements(allocation->'labor_evidence_ids'));
   actual_cost:=public.books_payroll_exact_amount(allocation->'gross_cents')+public.books_payroll_exact_amount(allocation->'employer_taxes_cents')+public.books_payroll_exact_amount(allocation->'employer_benefits_cents'); delta:=actual_cost-native_cost;
   if (item->>'originalCostCents')::numeric is distinct from native_cost or (item->>'actualCostCents')::numeric is distinct from actual_cost or (item->>'costDeltaCents')::numeric is distinct from delta then raise exception 'Payroll workflow costs differ from original and actual wages'; end if;
   select coalesce(jsonb_agg(jsonb_build_object('component',component,'costCents',amount) order by position),'[]') into expected_components from(values
    (1,'gross_variance',public.books_payroll_exact_amount(allocation->'gross_cents')-native_gross),(2,'estimated_burden_release',-native_burden),(3,'employer_taxes',public.books_payroll_exact_amount(allocation->'employer_taxes_cents')),(4,'employer_benefits',public.books_payroll_exact_amount(allocation->'employer_benefits_cents'))) c(position,component,amount) where amount<>0;
   if item->'components' is distinct from expected_components then raise exception 'Payroll workflow signed components differ'; end if;
   corrections:='[]';
   if allocation->>'project_id' is not null then
    project_delta:=project_delta+delta;
    select coalesce(jsonb_agg(value||jsonb_build_object('sourceType','payroll_import','sourceKey',new.id::text||':'||(allocation->>'id')||':'||(value->>'component')) order by ordinality),'[]') into corrections from jsonb_array_elements(expected_components) with ordinality;
   else overhead_delta:=overhead_delta+delta; end if;
   if item->'jobCostCorrections' is distinct from corrections then raise exception 'Payroll workflow project corrections differ'; end if;
   budget_id:=null;gmp:=null;
   if allocation->>'project_id' is not null and jsonb_array_length(expected_components)>0 then
    select case when count(distinct coalesce(r.value->>'budget_line_id','~'))=1 then max(r.value->>'budget_line_id') end,case when count(distinct coalesce(r.value->>'gmp_classification','~'))=1 then max(r.value->>'gmp_classification') end into budget_id,gmp from jsonb_array_elements(sources->'job_cost_entries') r where r.value->>'id' in(select value#>>'{}' from jsonb_array_elements(allocation->'labor_evidence_ids'));
   end if;
   if item->>'budgetLineId' is distinct from budget_id or item->>'gmpClassification' is distinct from gmp then raise exception 'Payroll workflow original budget or GMP attribution differs'; end if;
  end loop;
 end loop;
 if jsonb_typeof(construction->'projectCostDeltaCents') is distinct from 'number' or jsonb_typeof(construction->'overheadCostDeltaCents') is distinct from 'number' then raise exception 'Payroll workflow totals require JSON integer cents'; end if;
 if jsonb_array_length(construction->'allocations') is distinct from count_expected or (construction->>'projectCostDeltaCents')::numeric is distinct from project_delta or (construction->>'overheadCostDeltaCents')::numeric is distinct from overhead_delta then raise exception 'Payroll workflow cost totals or allocation population differ'; end if;
 if jsonb_typeof(proof#>'{liabilityHistory,organizationWagesMovementCents}') is distinct from 'number' or jsonb_typeof(proof#>'{liabilityHistory,organizationDeductionsMovementCents}') is distinct from 'number' then raise exception 'Payroll workflow liabilities require JSON integer cents'; end if;
 select coalesce(sum(case when code='2200' then movement else 0 end),0),coalesce(sum(case when code='2230' then movement else 0 end),0) into wages,deductions from(select coalesce(l.value#>>'{dimensions,books_account_classification,code}',(select a.value->>'code' from jsonb_array_elements(sources->'gl_accounts') a where a.value->>'id'=l.value->>'account_id')) code,(l.value->>'credit_cents')::numeric-(l.value->>'debit_cents')::numeric movement from jsonb_array_elements(sources->'journal_lines') l) movements;
 if jsonb_array_length(proof#>'{liabilityHistory,movements}') is distinct from jsonb_array_length(sources->'journal_entries') or (proof#>>'{liabilityHistory,organizationWagesMovementCents}')::numeric is distinct from wages or (proof#>>'{liabilityHistory,organizationDeductionsMovementCents}')::numeric is distinct from deductions or proof#>'{liabilityHistory,requiresSettlementAttribution}' is distinct from to_jsonb(jsonb_array_length(sources->'journal_entries')>0) then raise exception 'Payroll workflow liability history differs from recorded payments'; end if;
 return new;
end $$;
create trigger books_payroll_workflow_guard before insert or update on public.books_payroll_imports for each row execute function public.guard_books_payroll_workflow_evidence();
revoke all on function public.guard_books_payroll_workflow_evidence() from public,anon,authenticated;

-- ==== 20261003223805_books_payroll_payment_reviews ====
-- Review and reserve original payroll payment/recognition line portions. This
-- does not post payroll, pay cash, modify source journals or settle liabilities.
create table public.books_payroll_payment_reviews (
 id uuid primary key, org_id uuid not null references public.orgs(id), payroll_import_id uuid not null,
 status text not null default 'draft' check(status in('draft','reviewed','withdrawn')),
 request jsonb not null, evidence jsonb not null, evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
 prepared_by uuid not null references public.app_users(id), prepared_at timestamptz not null default now(), preparation_notes text not null check(length(trim(preparation_notes))>=10),
 reviewed_by uuid references public.app_users(id), reviewed_at timestamptz, review_notes text,
 withdrawn_by uuid references public.app_users(id), withdrawn_at timestamptz, withdrawal_reason text,
 idempotency_key text not null, unique(org_id,id), unique(org_id,idempotency_key),
 foreign key(org_id,payroll_import_id) references public.books_payroll_imports(org_id,id),
 check(jsonb_typeof(request)='object' and jsonb_typeof(evidence)='object'),
 check((reviewed_by is null and reviewed_at is null and review_notes is null and status<>'reviewed') or (reviewed_by is not null and reviewed_by<>prepared_by and reviewed_at is not null and length(trim(review_notes))>=10)),
 check((status<>'withdrawn' and withdrawn_by is null and withdrawn_at is null and withdrawal_reason is null) or (status='withdrawn' and withdrawn_by is not null and withdrawn_at is not null and length(trim(withdrawal_reason))>=10))
);
create unique index books_payroll_payment_review_active_idx on public.books_payroll_payment_reviews(org_id,payroll_import_id) where status<>'withdrawn';
create index books_payroll_payment_claims_idx on public.books_payroll_payment_reviews using gin((evidence->'source_line_claims') jsonb_path_ops);
alter table public.books_payroll_payment_reviews enable row level security;
revoke all on public.books_payroll_payment_reviews from public,anon,authenticated;
grant select,insert,update on public.books_payroll_payment_reviews to service_role;

-- Independent exact largest-remainder withholding allocation. A caller cannot
-- invent a per-project payment allowance from a different journal plan.
create function public.books_payroll_payment_component_limit(p_run jsonb,p_allocation uuid,p_component text)
returns numeric language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare worker jsonb; result numeric; matches integer;
begin
 select count(*) into matches from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a where a.value->>'id'=p_allocation::text;
 if matches<>1 then raise exception 'Payroll payment allocation is missing or ambiguous'; end if;
 select w.value into worker from jsonb_array_elements(p_run->'employees') w where exists(select 1 from jsonb_array_elements(w.value->'allocations') a where a.value->>'id'=p_allocation::text);
 with amounts as(select value a,(value->>'gross_cents')::numeric gross from jsonb_array_elements(worker->'allocations')),
 tax_base as(select *,floor((worker->>'employee_taxes_cents')::numeric*gross/(worker->>'gross_cents')::numeric) tax_base,mod((worker->>'employee_taxes_cents')::numeric*gross,(worker->>'gross_cents')::numeric) remainder from amounts),
 tax_rank as(select *,row_number() over(order by remainder desc,a->>'id') rank,(worker->>'employee_taxes_cents')::numeric-sum(tax_base) over() extra from tax_base),
 taxes as(select *,tax_base+case when rank<=extra then 1 else 0 end tax from tax_rank),
 capacity as(select *,gross-tax cap,sum(gross-tax) over() total from taxes),
 ded_base as(select *,case when total=0 then 0 else floor((worker->>'employee_deductions_cents')::numeric*cap/total) end ded_base,case when total=0 then 0 else mod((worker->>'employee_deductions_cents')::numeric*cap,total) end ded_remainder from capacity),
 ded_rank as(select *,row_number() over(order by ded_remainder desc,a->>'id') ded_rank,(worker->>'employee_deductions_cents')::numeric-sum(ded_base) over() ded_extra from ded_base),
 final as(select *,ded_base+case when ded_rank<=ded_extra then 1 else 0 end deduction from ded_rank)
 select case p_component when 'gross_wages_recognition' then gross when 'net_pay_payment' then gross-tax-deduction when 'employee_taxes_reclassification' then tax when 'employee_taxes_payment' then tax when 'employee_deductions_reclassification' then deduction when 'employee_deductions_payment' then deduction when 'employer_taxes_recognition' then (a->>'employer_taxes_cents')::numeric when 'employer_taxes_payment' then (a->>'employer_taxes_cents')::numeric when 'employer_benefits_recognition' then (a->>'employer_benefits_cents')::numeric when 'employer_benefits_payment' then (a->>'employer_benefits_cents')::numeric end into result from final where a->>'id'=p_allocation::text;
 if result is null then raise exception 'Unsupported payroll payment component'; end if;
 return result;
end $$;
revoke all on function public.books_payroll_payment_component_limit(jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.books_payroll_payment_component_limit(jsonb,uuid,text) to service_role;

create function public.guard_books_payroll_payment_review() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare parent public.books_payroll_imports; sources jsonb; decision jsonb; claim jsonb; proof jsonb; allocation jsonb; liability jsonb; counterpart jsonb; capacity jsonb; summary jsonb;
 seen uuid[]:='{}'; seen_journals uuid[]:='{}'; identifier uuid; component text; amount numeric; normal_sign integer; liability_code text; other_code text; other_type text; other_subtype text; recognition boolean; reclass boolean; available numeric; used numeric; source_line jsonb;
begin
 if tg_op='DELETE' then raise exception 'Payroll payment review history cannot be deleted'; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('payroll-import:'||new.org_id::text,0)) then raise exception 'Payroll payment claims are changing concurrently; retry' using errcode='40001'; end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] then raise exception 'Payroll payment evidence and request are immutable'; end if;
  if not((old.status='draft' and new.status='reviewed') or(old.status in('draft','reviewed') and new.status='withdrawn' and new.reviewed_by is not distinct from old.reviewed_by and new.reviewed_at is not distinct from old.reviewed_at and new.review_notes is not distinct from old.review_notes)) then raise exception 'Invalid payroll payment review transition'; end if;
 else
  if new.status<>'draft' or new.reviewed_by is not null or new.withdrawn_by is not null or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active') then raise exception 'Payment attribution requires an active preparer and draft'; end if;
 end if;
 if new.status='withdrawn' then
  if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.withdrawn_by and status='active') or coalesce(length(trim(new.withdrawal_reason)),0)<10 then raise exception 'Payment withdrawal requires an active actor and reason'; end if;
  return new;
 end if;
 select * into parent from public.books_payroll_imports where org_id=new.org_id and id=new.payroll_import_id for share;
 if not found or parent.status not in('draft','reviewed') or parent.reconciliation->'evidenceVersion' is distinct from '2'::jsonb then raise exception 'Payment review requires an active v2 payroll import'; end if;
 if new.status='reviewed' and(new.reviewed_by=new.prepared_by or new.reviewed_by=parent.prepared_by or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active') or coalesce(length(trim(new.review_notes)),0)<10) then raise exception 'Payroll payment review requires a separate active reviewer'; end if;
 if new.request->>'id' is distinct from new.id::text or new.request->>'payroll_import_id' is distinct from parent.id::text or new.evidence->'version' is distinct from '1'::jsonb or new.evidence->>'org_id' is distinct from new.org_id::text or new.evidence->>'payroll_import_id' is distinct from parent.id::text or new.evidence->>'payroll_reconciliation_digest' is distinct from parent.reconciliation_digest or new.evidence->'decisions' is distinct from new.request->'decisions' or new.evidence->'attributionOnly' is distinct from 'true'::jsonb or new.evidence->'postingImplemented' is distinct from 'false'::jsonb then raise exception 'Payment attribution requires exact parent/request identity and evidence scope'; end if;
 if public.books_payroll_source_revision(public.capture_books_export_snapshot(new.org_id),parent.run) is distinct from parent.source_revision then raise exception 'Parent payroll evidence changed; withdraw and reprepare'; end if;
 sources:=parent.reconciliation#>'{workflowEvidence,sourceTables}';
 if jsonb_typeof(new.evidence->'supporting_documents') is distinct from 'array' or jsonb_array_length(new.evidence->'supporting_documents')=0 then raise exception 'Payment attribution requires retained supporting documents'; end if;
 for proof in select value from jsonb_array_elements(new.evidence->'supporting_documents') order by value->>'file_id',value->>'document_version_id' loop
  identifier:=(proof->>'document_version_id')::uuid;
  if identifier is null or identifier=any(seen) or proof->>'org_id' is distinct from new.org_id::text or (proof->>'size_bytes')::bigint<=0 or not exists(select 1 from jsonb_array_elements(new.request->'decisions') d where d.value->>'document_version_id'=identifier::text) then raise exception 'Invalid or unused payment evidence version'; end if;
  seen:=array_append(seen,identifier);
  perform pg_advisory_xact_lock(hashtextextended('tax-attachment:'||new.org_id::text||':'||(proof->>'file_id'),0));
  perform 1 from public.files where org_id=new.org_id and id=(proof->>'file_id')::uuid for share;
  if not found then raise exception 'Payment evidence file is outside organization'; end if;
  perform 1 from public.doc_versions where org_id=new.org_id and id=identifier and file_id=(proof->>'file_id')::uuid and storage_path=proof->>'storage_path' and checksum=proof->>'checksum' and size_bytes=(proof->>'size_bytes')::bigint and file_name=proof->>'file_name' and mime_type is not distinct from proof->>'mime_type' for share;
  if not found then raise exception 'Payment evidence original document version changed'; end if;
 end loop;
 seen:='{}';
 if jsonb_typeof(new.request->'decisions') is distinct from 'array' or jsonb_array_length(new.request->'decisions') is distinct from jsonb_array_length(sources->'journal_entries') or jsonb_array_length(new.request->'decisions')=0 then raise exception 'Review every retained payroll liability movement exactly once'; end if;
 for decision in select value from jsonb_array_elements(new.request->'decisions') loop
  identifier:=(decision->>'journal_id')::uuid;
  if identifier is null or identifier=any(seen_journals) or not exists(select 1 from jsonb_array_elements(sources->'journal_entries') e where e.value->>'id'=identifier::text) or coalesce(length(trim(decision->>'explanation')),0)<10 or not exists(select 1 from jsonb_array_elements(new.evidence->'supporting_documents') p where p.value->>'document_version_id'=decision->>'document_version_id') then raise exception 'Payment decision is missing, duplicate or unsupported'; end if;
  seen_journals:=array_append(seen_journals,identifier);
  if jsonb_typeof(decision->'claims') is distinct from 'array' or coalesce(decision->>'disposition','') not in('allocated','unrelated') or (decision->>'disposition'='allocated' and jsonb_array_length(decision->'claims')=0) or(decision->>'disposition'='unrelated' and jsonb_array_length(decision->'claims')<>0) then raise exception 'Payment decision disposition differs from claims'; end if;
  if jsonb_array_length(decision->'claims')>0 and decision->>'document_version_id'=parent.source_proof->>'document_version_id' then raise exception 'Intended payroll register alone cannot prove payment or recognition'; end if;
  for claim in select value from jsonb_array_elements(decision->'claims') loop
   identifier:=(claim->>'id')::uuid;
   if identifier is null or identifier=any(seen) or jsonb_typeof(claim->'signed_cents') is distinct from 'number' then raise exception 'Payroll payment claims require unique identities and integer cents'; end if;
   seen:=array_append(seen,identifier);amount:=(claim->>'signed_cents')::numeric;
   if amount=0 or abs(amount)>9007199254740991 or amount<>trunc(amount) then raise exception 'Payroll claim requires nonzero safe signed integer cents'; end if;
   select a.value into allocation from jsonb_array_elements(parent.run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a where w.value->>'worker_id'=claim->>'worker_id' and a.value->>'id'=claim->>'allocation_id';
   if allocation is null then raise exception 'Payroll claim worker/allocation differs from parent'; end if;
   select value into liability from jsonb_array_elements(sources->'journal_lines') l where l.value->>'id'=claim->>'liability_line_id' and l.value->>'entry_id'=decision->>'journal_id';
   select value into counterpart from jsonb_array_elements(sources->'journal_lines') l where l.value->>'id'=claim->>'counterpart_line_id' and l.value->>'entry_id'=decision->>'journal_id';
   if liability is null or counterpart is null or liability->>'id'=counterpart->>'id' then raise exception 'Payroll claim requires two distinct original lines'; end if;
   component:=claim->>'component';perform public.books_payroll_payment_component_limit(parent.run,(claim->>'allocation_id')::uuid,component);
   recognition:=component like '%_recognition';reclass:=component like '%_reclassification';normal_sign:=case when recognition then 1 else -1 end;
   liability_code:=case when component in('gross_wages_recognition','net_pay_payment') or reclass then '2200' else '2230' end;
   if coalesce(liability#>>'{dimensions,books_account_classification,code}',(select value->>'code' from jsonb_array_elements(sources->'gl_accounts') a where a.value->>'id'=liability->>'account_id')) is distinct from liability_code or sign((liability->>'credit_cents')::numeric-(liability->>'debit_cents')::numeric)<>normal_sign*sign(amount) or sign((counterpart->>'credit_cents')::numeric-(counterpart->>'debit_cents')::numeric)<>-normal_sign*sign(amount) then raise exception 'Payroll claim original liability/direction differs'; end if;
   select coalesce(counterpart#>>'{dimensions,books_account_classification,code}',a.value->>'code'),coalesce(counterpart#>>'{dimensions,books_account_classification,account_type}',a.value->>'account_type'),coalesce(counterpart#>>'{dimensions,books_account_classification,subtype}',a.value->>'subtype') into other_code,other_type,other_subtype from jsonb_array_elements(sources->'gl_accounts') a where a.value->>'id'=counterpart->>'account_id';
   if (reclass and other_code is distinct from '2230') or(recognition and other_code is distinct from allocation->>'cost_account_code') or(not reclass and not recognition and(other_type is distinct from 'asset' or other_subtype is distinct from 'cash')) then raise exception 'Payroll claim cost/deductions/cash counterpart differs'; end if;
   if liability->>'project_id' is not null and liability->>'project_id' is distinct from allocation->>'project_id' or counterpart->>'project_id' is not null and counterpart->>'project_id' is distinct from allocation->>'project_id' or recognition and(counterpart->>'project_id' is distinct from allocation->>'project_id' or counterpart#>>'{dimensions,cost_code_id}' is distinct from allocation->>'cost_code_id') then raise exception 'Payroll claim original construction dimensions differ'; end if;
   for source_line in select value from jsonb_array_elements(jsonb_build_array(liability,counterpart)) loop
    if source_line#>>'{dimensions,payroll_run_id}' is not null and source_line#>>'{dimensions,payroll_run_id}' is distinct from parent.id::text or source_line#>>'{dimensions,payroll_worker_id}' is not null and source_line#>>'{dimensions,payroll_worker_id}' is distinct from claim->>'worker_id' or source_line#>>'{dimensions,labor_worker_id}' is not null and source_line#>>'{dimensions,labor_worker_id}' is distinct from claim->>'worker_id' or source_line#>>'{dimensions,payroll_allocation_id}' is not null and source_line#>>'{dimensions,payroll_allocation_id}' is distinct from claim->>'allocation_id' then raise exception 'Payroll claim contradicts original run/worker/allocation ownership';end if;
   end loop;
  end loop;
 end loop;
 with claims as(select c.value from jsonb_array_elements(new.request->'decisions') d cross join lateral jsonb_array_elements(d.value->'claims') c),
 grouped as(select value->>'worker_id' worker,value->>'allocation_id' allocation,value->>'component' component,sum((value->>'signed_cents')::numeric) amount from claims group by 1,2,3)
 select coalesce(jsonb_agg(jsonb_build_object('worker_id',g.worker,'allocation_id',g.allocation,'component',g.component,'signed_cents',g.amount,'limit_cents',public.books_payroll_payment_component_limit(parent.run,g.allocation::uuid,g.component)) order by g.allocation||':'||g.component),'[]') into summary from grouped g;
 if new.evidence->'allocation_components' is distinct from summary or exists(select 1 from jsonb_array_elements(summary) r where (r.value->>'signed_cents')::numeric<0 or (r.value->>'signed_cents')::numeric>(r.value->>'limit_cents')::numeric) then raise exception 'Payroll prior payment/recognition totals exceed provider controls or have unpaired refunds'; end if;
 with claims as(select c.value,d.value->>'journal_id' journal from jsonb_array_elements(new.request->'decisions') d cross join lateral jsonb_array_elements(d.value->'claims') c),
 used as(select value->>'liability_line_id' id,journal,abs((value->>'signed_cents')::numeric) amount from claims union all select value->>'counterpart_line_id',journal,abs((value->>'signed_cents')::numeric) from claims),
 grouped as(select u.id,u.journal,sum(u.amount) amount from used u group by 1,2)
 select coalesce(jsonb_agg(jsonb_build_object('line_id',g.id,'journal_id',g.journal,'available_cents',(l.value->>'debit_cents')::numeric+(l.value->>'credit_cents')::numeric,'claimed_cents',g.amount) order by g.id),'[]') into capacity from grouped g join jsonb_array_elements(sources->'journal_lines') l on l.value->>'id'=g.id;
 if new.evidence->'source_line_claims' is distinct from capacity then raise exception 'Payroll source-line claim summary differs'; end if;
 for proof in select value from jsonb_array_elements(capacity) loop
  select coalesce(sum((c.value->>'claimed_cents')::numeric),0) into used from public.books_payroll_payment_reviews p cross join lateral jsonb_array_elements(p.evidence->'source_line_claims') c where p.org_id=new.org_id and p.id<>new.id and p.status<>'withdrawn' and p.evidence->'source_line_claims' @> jsonb_build_array(jsonb_build_object('line_id',proof->>'line_id')) and c.value->>'line_id'=proof->>'line_id';
  if used+(proof->>'claimed_cents')::numeric>(proof->>'available_cents')::numeric then raise exception 'Payroll claims exceed original journal-line capacity across active reviews'; end if;
 end loop;
 return new;
end $$;
create trigger books_payroll_payment_review_guard before insert or update or delete on public.books_payroll_payment_reviews for each row execute function public.guard_books_payroll_payment_review();
revoke all on function public.guard_books_payroll_payment_review() from public,anon,authenticated;

create function public.prepare_books_payroll_payment_review(p_org_id uuid,p_actor_id uuid,p_request jsonb,p_evidence jsonb,p_digest text,p_notes text,p_key text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_payroll_payment_reviews; result uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_notes)),0)<10 or coalesce(length(trim(p_key)),0)<10 then raise exception 'Payment preparation requires an active actor, substantive notes and retry identity'; end if;
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into previous from public.books_payroll_payment_reviews where org_id=p_org_id and idempotency_key=p_key;
 if found then
  if previous.prepared_by<>p_actor_id or previous.request is distinct from p_request or previous.evidence is distinct from p_evidence or previous.evidence_digest is distinct from p_digest or previous.preparation_notes is distinct from p_notes then raise exception 'Payroll payment retry key has different evidence'; end if;
  return previous.id;
 end if;
 perform 1 from public.books_payroll_imports where org_id=p_org_id and id=(p_request->>'payroll_import_id')::uuid for share;
 insert into public.books_payroll_payment_reviews(id,org_id,payroll_import_id,request,evidence,evidence_digest,prepared_by,preparation_notes,idempotency_key) values((p_request->>'id')::uuid,p_org_id,(p_request->>'payroll_import_id')::uuid,p_request,p_evidence,p_digest,p_actor_id,p_notes,p_key) returning id into result;
 return result;
end $$;
revoke all on function public.prepare_books_payroll_payment_review(uuid,uuid,jsonb,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.prepare_books_payroll_payment_review(uuid,uuid,jsonb,jsonb,text,text,text) to service_role;

create function public.review_books_payroll_payment_review(p_org_id uuid,p_id uuid,p_actor_id uuid,p_evidence jsonb,p_digest text,p_notes text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_payment_reviews; parent public.books_payroll_imports;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select p.* into parent from public.books_payroll_imports p join public.books_payroll_payment_reviews r on r.org_id=p.org_id and r.payroll_import_id=p.id where r.org_id=p_org_id and r.id=p_id for share of p;
 select * into item from public.books_payroll_payment_reviews where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Payroll payment review not found'; end if;
 if p_actor_id=item.prepared_by or p_actor_id=parent.prepared_by or not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_notes)),0)<10 then raise exception 'Payroll payment review requires a separate active reviewer'; end if;
 if parent.status not in('draft','reviewed') or public.books_payroll_source_revision(public.capture_books_export_snapshot(p_org_id),parent.run) is distinct from parent.source_revision then raise exception 'Parent payroll evidence changed before payment review'; end if;
 if item.evidence is distinct from p_evidence or item.evidence_digest is distinct from p_digest then raise exception 'Payroll payment evidence changed before review'; end if;
 if item.status='reviewed' and item.reviewed_by=p_actor_id and item.review_notes=p_notes then return item.id; end if;
 if item.status<>'draft' then raise exception 'Payment review requires a draft'; end if;
 update public.books_payroll_payment_reviews set status='reviewed',reviewed_by=p_actor_id,reviewed_at=now(),review_notes=p_notes where org_id=p_org_id and id=p_id;
 return item.id;
end $$;
revoke all on function public.review_books_payroll_payment_review(uuid,uuid,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.review_books_payroll_payment_review(uuid,uuid,uuid,jsonb,text,text) to service_role;

create function public.withdraw_books_payroll_payment_review(p_org_id uuid,p_id uuid,p_actor_id uuid,p_reason text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_payment_reviews;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_reason)),0)<10 then raise exception 'Payment withdrawal requires an active actor and reason'; end if;
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into item from public.books_payroll_payment_reviews where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Payroll payment review not found'; end if;
 if item.status='withdrawn' and item.withdrawn_by=p_actor_id and item.withdrawal_reason=p_reason then return item.id; end if;
 if item.status not in('draft','reviewed') then raise exception 'Payment review cannot be withdrawn'; end if;
 update public.books_payroll_payment_reviews set status='withdrawn',withdrawn_by=p_actor_id,withdrawn_at=now(),withdrawal_reason=p_reason where org_id=p_org_id and id=p_id;
 return item.id;
end $$;
revoke all on function public.withdraw_books_payroll_payment_review(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.withdraw_books_payroll_payment_review(uuid,uuid,uuid,text) to service_role;

create function public.withdraw_payroll_payment_reviews_with_parent() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.status='withdrawn' and old.status<>'withdrawn' then
  update public.books_payroll_payment_reviews set status='withdrawn',withdrawn_by=new.withdrawn_by,withdrawn_at=new.withdrawn_at,withdrawal_reason='Parent payroll import withdrawn: '||new.withdrawal_reason where org_id=new.org_id and payroll_import_id=new.id and status<>'withdrawn';
 end if;
 return new;
end $$;
create trigger books_payroll_payment_parent_withdrawal before update of status on public.books_payroll_imports for each row execute function public.withdraw_payroll_payment_reviews_with_parent();
revoke all on function public.withdraw_payroll_payment_reviews_with_parent() from public,anon,authenticated;

-- Private history lookup only, for ordinary document writers. All statuses
-- retain original supporting versions; browser callers cannot read the table.
create function public.protect_payroll_payment_documents() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare file_id uuid;
begin
 if tg_table_name='files' then file_id:=old.id; else file_id:=old.file_id; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||old.org_id::text||':'||file_id::text,0)) then raise exception 'Payroll payment document evidence is changing concurrently; retry' using errcode='40001'; end if;
 if tg_table_name='files' then
  if exists(select 1 from public.books_payroll_payment_reviews r cross join lateral jsonb_array_elements(r.evidence->'supporting_documents') p where r.org_id=old.org_id and p.value->>'file_id'=old.id::text) then
   if tg_op='DELETE' then raise exception 'Payroll payment supporting file history cannot be deleted'; end if;
   if new.id is distinct from old.id or new.org_id is distinct from old.org_id then raise exception 'Payroll payment supporting file identity is immutable'; end if;
   if new.storage_path is not distinct from old.storage_path and(new.checksum is distinct from old.checksum or new.size_bytes is distinct from old.size_bytes) and exists(select 1 from public.books_payroll_payment_reviews r cross join lateral jsonb_array_elements(r.evidence->'supporting_documents') p where r.org_id=old.org_id and p.value->>'file_id'=old.id::text and p.value->>'storage_path'=old.storage_path) then raise exception 'Payroll payment original object metadata is immutable'; end if;
   if new.storage_path is distinct from old.storage_path and not exists(select 1 from public.doc_versions v where v.org_id=old.org_id and v.file_id=old.id and v.storage_path=old.storage_path and v.checksum=old.checksum and v.size_bytes=old.size_bytes) then raise exception 'Missing retained original payroll payment evidence'; end if;
  end if;
 else
  if tg_op='UPDATE' and to_jsonb(new)-array['label','notes'] is not distinct from to_jsonb(old)-array['label','notes'] then return new; end if;
  if exists(select 1 from public.books_payroll_payment_reviews r cross join lateral jsonb_array_elements(r.evidence->'supporting_documents') p where r.org_id=old.org_id and p.value->>'document_version_id'=old.id::text) then raise exception 'Payroll payment original document version is immutable'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger payroll_payment_file_history_guard before update or delete on public.files for each row execute function public.protect_payroll_payment_documents();
create trigger payroll_payment_version_history_guard before update or delete on public.doc_versions for each row execute function public.protect_payroll_payment_documents();
revoke all on function public.protect_payroll_payment_documents() from public,anon,authenticated;

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

-- ==== 20261003231822_books_payroll_posting_verification ====
-- Independent arithmetic verification only. No journal, cash or construction
-- write and no posting authority is introduced by these service-only helpers.
create function public.books_payroll_posting_plan_math(p_parent jsonb,p_payment jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare
 run jsonb:=p_parent->'run'; worker jsonb; allocation jsonb; original jsonb; operational jsonb; decision jsonb; claim jsonb; source_journal jsonb; line jsonb; component jsonb;
 allocation_rows jsonb:='[]'; components jsonb; outstanding jsonb; liability_bridge jsonb; dated jsonb:='{}'; journals jsonb:='[]'; retained jsonb:='[]'; dimensions jsonb; common jsonb; rows jsonb; claims jsonb;
 parent_id text:=p_parent->>'id'; org_id text:=p_parent->>'org_id'; payment_id text:=p_payment->>'id'; date_key text; debit_code text; credit_code text; account_code text;
 gross numeric; burden numeric; native_cost numeric; actual_cost numeric; tax numeric; deduction numeric; prior_gross numeric; prior_tax_cost numeric; prior_benefit_cost numeric; prior_cost numeric;
 net_paid numeric; tax_reclass numeric; deduction_reclass numeric; tax_paid numeric; deduction_paid numeric; employer_tax_paid numeric; employer_benefit_paid numeric;
 wage_original numeric; wage_delta numeric; deductions_original numeric; deductions_delta numeric; ledger_delta numeric; operational_delta numeric; amount numeric; attribution numeric; code text;
begin
 if p_parent->>'status' is distinct from 'reviewed' or run->>'id' is distinct from parent_id or run->>'org_id' is distinct from org_id or p_parent#>'{reconciliation,evidenceVersion}' is distinct from '2'::jsonb or p_parent->>'reviewed_by' is null or p_parent->>'reviewed_by'=p_parent->>'prepared_by' then raise exception 'Payroll posting requires independently reviewed v2 parent'; end if;
 if p_payment is not null and (p_payment->>'status' is distinct from 'reviewed' or p_payment->>'org_id' is distinct from org_id or p_payment->>'payroll_import_id' is distinct from parent_id or p_payment->>'reviewed_by' is null or p_payment->>'reviewed_by'=p_payment->>'prepared_by' or p_payment->>'reviewed_by'=p_parent->>'prepared_by' or p_payment#>>'{evidence,payroll_reconciliation_digest}' is distinct from p_parent->>'reconciliation_digest') then raise exception 'Payroll posting requires separate reviewed payment ownership'; end if;
 if p_payment is null and jsonb_array_length(p_parent#>'{reconciliation,workflowEvidence,sourceTables,journal_entries}')<>0 then raise exception 'Payroll posting requires reviewed payment decisions'; end if;
 select coalesce(jsonb_agg(c.value),'[]') into claims from jsonb_array_elements(coalesce(p_payment#>'{request,decisions}','[]')) d cross join lateral jsonb_array_elements(d.value->'claims') c;
 for worker in select value from jsonb_array_elements(run->'employees') order by value->>'worker_id' loop
  for allocation in select value from jsonb_array_elements(worker->'allocations') order by value->>'id' loop
   select coalesce(sum((e.value->>'gross_cents')::numeric),0),coalesce(sum((e.value->>'estimated_burden_cents')::numeric),0) into gross,burden from jsonb_array_elements(p_parent->'labor_evidence') e where allocation->'labor_evidence_ids' @> jsonb_build_array(e.value->>'id');
   native_cost:=gross+burden; actual_cost:=(allocation->>'gross_cents')::numeric+(allocation->>'employer_taxes_cents')::numeric+(allocation->>'employer_benefits_cents')::numeric;
   tax:=public.books_payroll_payment_component_limit(run,(allocation->>'id')::uuid,'employee_taxes_payment');deduction:=public.books_payroll_payment_component_limit(run,(allocation->>'id')::uuid,'employee_deductions_payment');
   select coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='gross_wages_recognition'),0),
    coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employer_taxes_recognition'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employer_benefits_recognition'),0),
    coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='net_pay_payment'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employee_taxes_reclassification'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employee_deductions_reclassification'),0),
    coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employee_taxes_payment'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employee_deductions_payment'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employer_taxes_payment'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employer_benefits_payment'),0)
   into prior_gross,prior_tax_cost,prior_benefit_cost,net_paid,tax_reclass,deduction_reclass,tax_paid,deduction_paid,employer_tax_paid,employer_benefit_paid from jsonb_array_elements(claims) c where c.value->>'allocation_id'=allocation->>'id' and c.value->>'worker_id'=worker->>'worker_id';
   prior_cost:=prior_gross+prior_tax_cost+prior_benefit_cost;operational_delta:=actual_cost-native_cost;ledger_delta:=operational_delta-prior_cost;
   select value into operational from jsonb_array_elements(p_parent#>'{reconciliation,workflowEvidence,constructionImpact,allocations}') a where a.value->>'allocationId'=allocation->>'id';
   if operational is null or operational->'originalCostCents' is distinct from to_jsonb(native_cost) or operational->'costDeltaCents' is distinct from to_jsonb(operational_delta) or operational->'actualCostCents' is distinct from to_jsonb(actual_cost) then raise exception 'Payroll native/project cost bridge differs'; end if;
   dimensions:=jsonb_build_object('payroll_run_id',parent_id,'payroll_worker_id',worker->>'worker_id','payroll_allocation_id',allocation->>'id');
   if allocation->>'cost_code_id' is not null then dimensions:=dimensions||jsonb_build_object('cost_code_id',allocation->>'cost_code_id');end if;
   if payment_id is not null then dimensions:=dimensions||jsonb_build_object('payroll_payment_review_id',payment_id);end if;
   account_code:=allocation->>'cost_account_code';
   -- Accrual pairs are recomputed from provider amounts and native basis, not
   -- copied from the application journal or stored reconciliation draft.
   components:=jsonb_build_array(
    jsonb_build_object('component','gross_variance','debit',account_code,'credit','2200','amount',(allocation->>'gross_cents')::numeric-gross),
    jsonb_build_object('component','estimated_burden_release','debit','2200','credit',account_code,'amount',burden),
    jsonb_build_object('component','employee_taxes','debit','2200','credit','2230','amount',tax),jsonb_build_object('component','employee_deductions','debit','2200','credit','2230','amount',deduction),
    jsonb_build_object('component','employer_taxes','debit',account_code,'credit','2230','amount',(allocation->>'employer_taxes_cents')::numeric),jsonb_build_object('component','employer_benefits','debit',account_code,'credit','2230','amount',(allocation->>'employer_benefits_cents')::numeric));
   date_key:=run->>'accrual_date';rows:=coalesce(dated->date_key,'[]');
   for component in select value from jsonb_array_elements(components) loop
    amount:=(component->>'amount')::numeric;if amount=0 then continue;end if;
    common:=jsonb_build_object('dimensions',dimensions||jsonb_build_object('payroll_component',component->>'component'),'description','Payroll '||(component->>'component'));
    if allocation->>'project_id' is not null then common:=common||jsonb_build_object('projectId',allocation->>'project_id');end if;
    rows:=rows||jsonb_build_array(common||jsonb_build_object('accountCode',component->>'debit','debitCents',greatest(amount,0),'creditCents',greatest(-amount,0)),common||jsonb_build_object('accountCode',component->>'credit','debitCents',greatest(-amount,0),'creditCents',greatest(amount,0)));
   end loop;
   if jsonb_array_length(rows)>0 then dated:=dated||jsonb_build_object(date_key,rows);end if;
   components:=jsonb_build_array(jsonb_build_object('component','gross_variance','signedCents',(allocation->>'gross_cents')::numeric-gross-prior_gross),jsonb_build_object('component','estimated_burden_release','signedCents',burden),jsonb_build_object('component','employee_taxes','signedCents',tax-tax_reclass),jsonb_build_object('component','employee_deductions','signedCents',deduction-deduction_reclass),jsonb_build_object('component','employer_taxes','signedCents',(allocation->>'employer_taxes_cents')::numeric-prior_tax_cost),jsonb_build_object('component','employer_benefits','signedCents',(allocation->>'employer_benefits_cents')::numeric-prior_benefit_cost));
   outstanding:=jsonb_build_object('netPayCents',(allocation->>'gross_cents')::numeric-tax-deduction-net_paid,'employeeTaxesCents',tax-tax_paid,'employeeDeductionsCents',deduction-deduction_paid,'employerTaxesCents',(allocation->>'employer_taxes_cents')::numeric-employer_tax_paid,'employerBenefitsCents',(allocation->>'employer_benefits_cents')::numeric-employer_benefit_paid);
   if exists(select 1 from jsonb_each_text(outstanding) o where o.value::numeric<0) then raise exception 'Payroll recorded claims exceed remaining obligations';end if;
   wage_original:=native_cost+prior_gross-net_paid-tax_reclass-deduction_reclass;wage_delta:=(allocation->>'gross_cents')::numeric-gross-prior_gross-burden-tax+tax_reclass-deduction+deduction_reclass;
   deductions_original:=tax_reclass+deduction_reclass+prior_tax_cost+prior_benefit_cost-tax_paid-deduction_paid-employer_tax_paid-employer_benefit_paid;
   deductions_delta:=tax-tax_reclass+deduction-deduction_reclass+(allocation->>'employer_taxes_cents')::numeric-prior_tax_cost+(allocation->>'employer_benefits_cents')::numeric-prior_benefit_cost;
   if wage_original+wage_delta<>(outstanding->>'netPayCents')::numeric or deductions_original+deductions_delta<>(outstanding->>'employeeTaxesCents')::numeric+(outstanding->>'employeeDeductionsCents')::numeric+(outstanding->>'employerTaxesCents')::numeric+(outstanding->>'employerBenefitsCents')::numeric then raise exception 'Payroll owned liability bridge differs';end if;
   liability_bridge:=jsonb_build_object('wages',jsonb_build_object('originalCents',wage_original,'deltaCents',wage_delta,'remainingCents',wage_original+wage_delta),'deductions',jsonb_build_object('originalCents',deductions_original,'deltaCents',deductions_delta,'remainingCents',deductions_original+deductions_delta));
   allocation_rows:=allocation_rows||jsonb_build_array(jsonb_build_object('workerId',worker->>'worker_id','allocationId',allocation->>'id','projectId',allocation->'project_id','costCodeId',allocation->'cost_code_id','accountCode',account_code,'originalLedgerCostCents',native_cost+prior_cost,'priorNonNativeLedgerCostCents',prior_cost,'ledgerCostDeltaCents',ledger_delta,'originalOperationalCostCents',native_cost,'operationalCostDeltaCents',operational_delta,'actualCostCents',actual_cost,'ledgerOperationalBridgeCents',prior_cost,'components',components,'outstanding',outstanding,'liabilityBridge',liability_bridge,'construction',operational));
  end loop;
 end loop;
 for decision in select value from jsonb_array_elements(coalesce(p_payment#>'{request,decisions}','[]')) order by value->>'journal_id' loop
  select value into source_journal from jsonb_array_elements(p_parent#>'{reconciliation,workflowEvidence,sourceTables,journal_entries}') j where j.value->>'id'=decision->>'journal_id';
  if source_journal is null then raise exception 'Payroll prior claim original journal is missing';end if;
  for claim in select value from jsonb_array_elements(decision->'claims') order by value->>'id' loop
   if claim->>'component' not like '%_recognition' and claim->>'component' not like '%_reclassification' then continue;end if;
   select a.value into allocation from jsonb_array_elements(run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a where w.value->>'worker_id'=claim->>'worker_id' and a.value->>'id'=claim->>'allocation_id';
   if allocation is null then raise exception 'Payroll prior claim allocation is missing';end if;
   date_key:=greatest((run->>'accrual_date')::date,(source_journal->>'entry_date')::date)::text;
   debit_code:=case when claim->>'component'='gross_wages_recognition' then '2200' else '2230' end;
   credit_code:=case when claim->>'component' like '%_reclassification' then '2200' else allocation->>'cost_account_code' end;
   amount:=(claim->>'signed_cents')::numeric;
   dimensions:=jsonb_build_object('payroll_run_id',parent_id,'payroll_worker_id',claim->>'worker_id','payroll_allocation_id',allocation->>'id','payroll_payment_review_id',payment_id,'payroll_prior_claim_id',claim->>'id','payroll_original_journal_id',decision->>'journal_id','payroll_component','prior_'||(claim->>'component')||'_offset');
   if allocation->>'cost_code_id' is not null then dimensions:=dimensions||jsonb_build_object('cost_code_id',allocation->>'cost_code_id');end if;
   common:=jsonb_build_object('dimensions',dimensions,'description','Offset recorded payroll '||(claim->>'component'));
   if allocation->>'project_id' is not null then common:=common||jsonb_build_object('projectId',allocation->>'project_id');end if;
   rows:=coalesce(dated->date_key,'[]')||jsonb_build_array(common||jsonb_build_object('accountCode',debit_code,'debitCents',greatest(amount,0),'creditCents',greatest(-amount,0)),common||jsonb_build_object('accountCode',credit_code,'debitCents',greatest(-amount,0),'creditCents',greatest(amount,0)));
   dated:=dated||jsonb_build_object(date_key,rows);
  end loop;
 end loop;
 for date_key,rows in select key,value from jsonb_each(dated) order by key loop
  if exists(select 1 from jsonb_array_elements(rows) l where jsonb_typeof(l.value->'debitCents') is distinct from 'number' or jsonb_typeof(l.value->'creditCents') is distinct from 'number' or greatest((l.value->>'debitCents')::numeric,(l.value->>'creditCents')::numeric)>9007199254740991) or (select sum((l.value->>'debitCents')::numeric-(l.value->>'creditCents')::numeric) from jsonb_array_elements(rows) l)<>0 then raise exception 'Payroll dated journal is unbalanced or unsafe';end if;
  journals:=journals||jsonb_build_array(jsonb_build_object('entryDate',date_key,'entryKind','adjusting','memo','Reviewed payroll reconciliation '||(run->>'provider')||' '||(run->>'provider_run_id'),'postingKey','payroll_import:'||parent_id||':'||date_key||':s1:v2','projectionVersion',2,'policyVersion',1,'sourceType','payroll_import','sourceId',parent_id,'lines',rows));
 end loop;
 -- Preserve movement/line order from the independently retained history.
 for original in select value from jsonb_array_elements(p_parent#>'{reconciliation,workflowEvidence,liabilityHistory,movements}') loop
  for line in select value from jsonb_array_elements(original->'lines') loop
   code:=line->>'accountCode';if code not in('2200','2230') then continue;end if;
   select coalesce(sum((c.value->>'claimed_cents')::numeric),0) into attribution from jsonb_array_elements(coalesce(p_payment#>'{evidence,source_line_claims}','[]')) c where c.value->>'line_id'=line->>'id';
   select value into decision from jsonb_array_elements(coalesce(p_payment#>'{request,decisions}','[]')) d where d.value->>'journal_id'=original#>>'{journal,id}';
   retained:=retained||jsonb_build_array(jsonb_build_object('lineId',line->>'id','journalId',original#>>'{journal,id}','accountCode',code,'recordedDebitCents',line->'debit_cents','recordedCreditCents',line->'credit_cents','attributedCents',attribution,'unclaimedCents',(line->>'debit_cents')::numeric+(line->>'credit_cents')::numeric-attribution,'disposition',decision->>'disposition'));
  end loop;
 end loop;
 select jsonb_build_object('netPayCents',coalesce(sum((a.value#>>'{outstanding,netPayCents}')::numeric),0),'employeeTaxesCents',coalesce(sum((a.value#>>'{outstanding,employeeTaxesCents}')::numeric),0),'employeeDeductionsCents',coalesce(sum((a.value#>>'{outstanding,employeeDeductionsCents}')::numeric),0),'employerTaxesCents',coalesce(sum((a.value#>>'{outstanding,employerTaxesCents}')::numeric),0),'employerBenefitsCents',coalesce(sum((a.value#>>'{outstanding,employerBenefitsCents}')::numeric),0)) into outstanding from jsonb_array_elements(allocation_rows) a;
 return jsonb_build_object('version',1,'runId',parent_id,'orgId',org_id,'parentReconciliationDigest',p_parent->>'reconciliation_digest','sourceRevision',p_parent->>'source_revision','paymentReviewId',payment_id,'paymentEvidenceDigest',p_payment->>'evidence_digest','allocations',allocation_rows,'journalDrafts',journals,'retainedLiabilityLines',retained,
 'ledgerCostDeltaCents',(select coalesce(sum((a.value->>'ledgerCostDeltaCents')::numeric),0) from jsonb_array_elements(allocation_rows) a),'operationalCostDeltaCents',(select coalesce(sum((a.value->>'operationalCostDeltaCents')::numeric),0) from jsonb_array_elements(allocation_rows) a),'priorNonNativeLedgerCostCents',(select coalesce(sum((a.value->>'priorNonNativeLedgerCostCents')::numeric),0) from jsonb_array_elements(allocation_rows) a),'outstanding',outstanding,
 'requiresAllocationReview',p_parent#>'{reconciliation,workflowEvidence,constructionImpact,requiresAllocationReview}','requiresBillingReview',p_parent#>'{reconciliation,workflowEvidence,constructionImpact,requiresBillingReview}','runOwnedBalancesOnly',true,'organizationBalancesProven',false,'requiresCommitRevalidation',true,'previewOnly',true,'postingImplemented',false);
end $$;
revoke all on function public.books_payroll_posting_plan_math(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_posting_plan_math(jsonb,jsonb) to service_role;

create function public.verify_books_payroll_posting_plan(p_org_id uuid,p_parent_id uuid,p_plan jsonb)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare parent public.books_payroll_imports; payment public.books_payroll_payment_reviews; expected jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into parent from public.books_payroll_imports where org_id=p_org_id and id=p_parent_id for share;
 if not found then raise exception 'Payroll posting parent is unavailable in organization';end if;
 select * into payment from public.books_payroll_payment_reviews where org_id=p_org_id and payroll_import_id=p_parent_id and status<>'withdrawn' for share;
 if public.books_payroll_source_revision(public.capture_books_export_snapshot(p_org_id),parent.run) is distinct from parent.source_revision then raise exception 'Payroll posting source revision changed';end if;
 expected:=public.books_payroll_posting_plan_math(to_jsonb(parent),case when payment.id is null then null else to_jsonb(payment) end);
 if jsonb_typeof(p_plan) is distinct from 'object' or p_plan-'digest' is distinct from expected then raise exception 'Payroll posting proposal differs from independently reconstructed dated journals and allocation balances';end if;
 return true;
end $$;
revoke all on function public.verify_books_payroll_posting_plan(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.verify_books_payroll_posting_plan(uuid,uuid,jsonb) to service_role;

-- ==== 20261003233012_books_payroll_posting_proposals ====
-- Immutable full payroll posting proposals. Reviewed does not mean posted:
-- construction approvals, period locks and atomic posting are still required.
create table public.books_payroll_posting_proposals(
 id uuid primary key,org_id uuid not null references public.orgs(id),payroll_import_id uuid not null,payment_review_id uuid,
 status text not null default 'draft' check(status in('draft','reviewed','withdrawn')),
 plan jsonb not null check(jsonb_typeof(plan)='object'),plan_digest text not null check(plan_digest~'^[a-f0-9]{64}$'),
 prepared_by uuid not null references public.app_users(id),prepared_at timestamptz not null default now(),preparation_notes text not null check(length(trim(preparation_notes))>=10),
 reviewed_by uuid references public.app_users(id),reviewed_at timestamptz,review_notes text,
 withdrawn_by uuid references public.app_users(id),withdrawn_at timestamptz,withdrawal_reason text,
 idempotency_key text not null,unique(org_id,id),unique(org_id,idempotency_key),
 foreign key(org_id,payroll_import_id) references public.books_payroll_imports(org_id,id),foreign key(org_id,payment_review_id) references public.books_payroll_payment_reviews(org_id,id),
 check((reviewed_by is null and reviewed_at is null and review_notes is null and status<>'reviewed') or(reviewed_by is not null and reviewed_by<>prepared_by and reviewed_at is not null and length(trim(review_notes))>=10)),
 check((status<>'withdrawn' and withdrawn_by is null and withdrawn_at is null and withdrawal_reason is null) or(status='withdrawn' and withdrawn_by is not null and withdrawn_at is not null and length(trim(withdrawal_reason))>=10))
);
create unique index books_payroll_posting_proposal_active_idx on public.books_payroll_posting_proposals(org_id,payroll_import_id) where status<>'withdrawn';
alter table public.books_payroll_posting_proposals enable row level security;
revoke all on public.books_payroll_posting_proposals from public,anon,authenticated;
grant select,insert,update on public.books_payroll_posting_proposals to service_role;

create function public.guard_books_payroll_posting_proposal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare parent public.books_payroll_imports; payment public.books_payroll_payment_reviews;
begin
 if tg_op='DELETE' then raise exception 'Payroll posting proposal history cannot be deleted';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('payroll-import:'||new.org_id::text,0)) then raise exception 'Payroll posting proposal is changing concurrently; retry' using errcode='40001';end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] then raise exception 'Payroll posting proposal and original evidence are immutable';end if;
  if not((old.status='draft' and new.status='reviewed') or(old.status in('draft','reviewed') and new.status='withdrawn' and new.reviewed_by is not distinct from old.reviewed_by and new.reviewed_at is not distinct from old.reviewed_at and new.review_notes is not distinct from old.review_notes)) then raise exception 'Invalid payroll posting proposal transition';end if;
 else
  if new.status<>'draft' or new.reviewed_by is not null or new.withdrawn_by is not null or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active') then raise exception 'Payroll posting proposal requires active preparer and draft';end if;
 end if;
 if new.status='withdrawn' then
  if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.withdrawn_by and status='active') or coalesce(length(trim(new.withdrawal_reason)),0)<10 then raise exception 'Payroll posting withdrawal requires active actor and reason';end if;
  return new;
 end if;
 select * into parent from public.books_payroll_imports where org_id=new.org_id and id=new.payroll_import_id for share;
 if not found then raise exception 'Payroll posting parent is unavailable in organization';end if;
 if new.payment_review_id is not null then
  select * into payment from public.books_payroll_payment_reviews where org_id=new.org_id and id=new.payment_review_id and payroll_import_id=parent.id for share;
  if not found or payment.status<>'reviewed' then raise exception 'Payroll posting payment ownership is unavailable or not reviewed';end if;
 end if;
 if new.plan->>'runId' is distinct from new.payroll_import_id::text or new.plan->>'orgId' is distinct from new.org_id::text or new.plan->>'paymentReviewId' is distinct from new.payment_review_id::text or new.plan->>'digest' is distinct from new.plan_digest then raise exception 'Payroll posting proposal identity or digest differs';end if;
 perform public.verify_books_payroll_posting_plan(new.org_id,new.payroll_import_id,new.plan);
 if new.status='reviewed' and(new.reviewed_by=new.prepared_by or new.reviewed_by=parent.prepared_by or new.reviewed_by=payment.prepared_by or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active') or coalesce(length(trim(new.review_notes)),0)<10) then raise exception 'Payroll posting proposal requires separate active reviewer';end if;
 return new;
end $$;
create trigger books_payroll_posting_proposal_guard before insert or update or delete on public.books_payroll_posting_proposals for each row execute function public.guard_books_payroll_posting_proposal();
revoke all on function public.guard_books_payroll_posting_proposal() from public,anon,authenticated;

create function public.prepare_books_payroll_posting_proposal(p_org_id uuid,p_id uuid,p_parent_id uuid,p_actor_id uuid,p_plan jsonb,p_digest text,p_notes text,p_key text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_payroll_posting_proposals; result uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_notes)),0)<10 or coalesce(length(trim(p_key)),0)<10 then raise exception 'Payroll posting proposal requires active actor, substantive notes and retry identity';end if;
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into previous from public.books_payroll_posting_proposals where org_id=p_org_id and idempotency_key=p_key;
 if found then
  if previous.id<>p_id or previous.payroll_import_id<>p_parent_id or previous.prepared_by<>p_actor_id or previous.plan is distinct from p_plan or previous.plan_digest is distinct from p_digest or previous.preparation_notes is distinct from p_notes then raise exception 'Payroll posting retry key has different intent or evidence';end if;
  return previous.id;
 end if;
 insert into public.books_payroll_posting_proposals(id,org_id,payroll_import_id,payment_review_id,plan,plan_digest,prepared_by,preparation_notes,idempotency_key) values(p_id,p_org_id,p_parent_id,(p_plan->>'paymentReviewId')::uuid,p_plan,p_digest,p_actor_id,p_notes,p_key) returning id into result;
 return result;
end $$;
revoke all on function public.prepare_books_payroll_posting_proposal(uuid,uuid,uuid,uuid,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.prepare_books_payroll_posting_proposal(uuid,uuid,uuid,uuid,jsonb,text,text,text) to service_role;

create function public.review_books_payroll_posting_proposal(p_org_id uuid,p_id uuid,p_actor_id uuid,p_plan jsonb,p_digest text,p_notes text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_posting_proposals; parent public.books_payroll_imports; payment public.books_payroll_payment_reviews;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select p.* into parent from public.books_payroll_imports p join public.books_payroll_posting_proposals r on r.org_id=p.org_id and r.payroll_import_id=p.id where r.org_id=p_org_id and r.id=p_id for share of p;
 select * into item from public.books_payroll_posting_proposals where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Payroll posting proposal is unavailable in organization';end if;
 select * into payment from public.books_payroll_payment_reviews where org_id=p_org_id and id=item.payment_review_id for share;
 if p_actor_id=item.prepared_by or p_actor_id=parent.prepared_by or p_actor_id=payment.prepared_by or not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_notes)),0)<10 then raise exception 'Payroll posting proposal requires separate active reviewer';end if;
 if item.plan is distinct from p_plan or item.plan_digest is distinct from p_digest then raise exception 'Payroll posting proposal changed before review';end if;
 perform public.verify_books_payroll_posting_plan(p_org_id,item.payroll_import_id,p_plan);
 if item.status='reviewed' and item.reviewed_by=p_actor_id and item.review_notes=p_notes then return item.id;end if;
 if item.status<>'draft' then raise exception 'Payroll posting review requires draft';end if;
 update public.books_payroll_posting_proposals set status='reviewed',reviewed_by=p_actor_id,reviewed_at=now(),review_notes=p_notes where org_id=p_org_id and id=p_id;
 return item.id;
end $$;
revoke all on function public.review_books_payroll_posting_proposal(uuid,uuid,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.review_books_payroll_posting_proposal(uuid,uuid,uuid,jsonb,text,text) to service_role;

create function public.withdraw_books_payroll_posting_proposal(p_org_id uuid,p_id uuid,p_actor_id uuid,p_reason text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_posting_proposals;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_reason)),0)<10 then raise exception 'Payroll posting withdrawal requires active actor and reason';end if;
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into item from public.books_payroll_posting_proposals where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Payroll posting proposal is unavailable in organization';end if;
 if item.status='withdrawn' and item.withdrawn_by=p_actor_id and item.withdrawal_reason=p_reason then return item.id;end if;
 if item.status not in('draft','reviewed') then raise exception 'Payroll posting proposal cannot be withdrawn';end if;
 update public.books_payroll_posting_proposals set status='withdrawn',withdrawn_by=p_actor_id,withdrawn_at=now(),withdrawal_reason=p_reason where org_id=p_org_id and id=p_id;
 return item.id;
end $$;
revoke all on function public.withdraw_books_payroll_posting_proposal(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.withdraw_books_payroll_posting_proposal(uuid,uuid,uuid,text) to service_role;

create function public.withdraw_payroll_proposals_with_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.status='withdrawn' and old.status<>'withdrawn' then
  if tg_table_name='books_payroll_imports' then
   update public.books_payroll_posting_proposals set status='withdrawn',withdrawn_by=new.withdrawn_by,withdrawn_at=new.withdrawn_at,withdrawal_reason='Payroll parent withdrawn: '||new.withdrawal_reason where org_id=new.org_id and payroll_import_id=new.id and status<>'withdrawn';
  else
   update public.books_payroll_posting_proposals set status='withdrawn',withdrawn_by=new.withdrawn_by,withdrawn_at=new.withdrawn_at,withdrawal_reason='Payroll payment ownership withdrawn: '||new.withdrawal_reason where org_id=new.org_id and payment_review_id=new.id and status<>'withdrawn';
  end if;
 end if;
 return new;
end $$;
create trigger payroll_posting_parent_withdrawal before update of status on public.books_payroll_imports for each row execute function public.withdraw_payroll_proposals_with_source();
create trigger payroll_posting_payment_withdrawal before update of status on public.books_payroll_payment_reviews for each row execute function public.withdraw_payroll_proposals_with_source();
revoke all on function public.withdraw_payroll_proposals_with_source() from public,anon,authenticated;

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
    'books_payroll_posting_proposals',
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

-- ==== 20261003235436_books_period_and_payroll_fences ====
-- Shared calendar locks preserve concurrent posting; period writers take the
-- exclusive side without waiting after acquiring a row lock. Lock inversion
-- causes a retryable failure, never an unprotected close/post.
create function public.books_lock_period_calendar_write() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare org uuid; organizations uuid[];
begin
 if tg_op='INSERT' then organizations:=array[new.org_id];elsif tg_op='DELETE' then organizations:=array[old.org_id];else organizations:=array[old.org_id,new.org_id];end if;
 for org in select distinct value from unnest(organizations) value order by value loop
  if not pg_try_advisory_xact_lock(hashtextextended('books-period-calendar:'||org::text,0)) then raise exception 'Accounting calendar is in use; retry period change' using errcode='40001';end if;
 end loop;
 if tg_op='DELETE' or tg_op='UPDATE' and(new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.period_start is distinct from old.period_start or new.period_end is distinct from old.period_end) then
  if exists(select 1 from public.journal_entries j where j.org_id=old.org_id and j.status in('posted','reversed') and(j.period_id=old.id or j.entry_date between old.period_start and old.period_end)) then raise exception 'Accounting calendar with recorded journals cannot be deleted or moved';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger accounting_periods_calendar_guard before insert or delete or update of id,org_id,period_start,period_end,status on public.accounting_periods for each row execute function public.books_lock_period_calendar_write();
revoke all on function public.books_lock_period_calendar_write() from public,anon,authenticated;

create or replace function public.books_guard_period_posting() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare period_row public.accounting_periods; close_owned boolean;
begin
 -- A reversal changes the original's lifecycle in its historical period, while
 -- its new reversing journal must pass its own target-date posting guard.
 if tg_op='UPDATE' and old.status='posted' and new.status='reversed' then return new;end if;
 if not pg_try_advisory_xact_lock_shared(hashtextextended('books-period-calendar:'||new.org_id::text,0)) then raise exception 'Accounting calendar is changing; retry journal operation' using errcode='40001';end if;
 if new.period_id is null then
  select * into period_row from public.accounting_periods where org_id=new.org_id and new.entry_date between period_start and period_end order by period_start,id for share;
  if not found then return new;end if;
  new.period_id:=period_row.id;
 else
  select * into period_row from public.accounting_periods where org_id=new.org_id and id=new.period_id for share;
  if not found or new.entry_date not between period_row.period_start and period_row.period_end then raise exception 'Journal entry must belong to its organization and accounting period';end if;
 end if;
 if (select count(*) from public.accounting_periods where org_id=new.org_id and new.entry_date between period_start and period_end)>1 then raise exception 'Accounting periods overlap; reconcile calendar before posting';end if;
 if period_row.status is null or period_row.status not in('open','reopened','reviewing','closed') then raise exception 'Accounting period has invalid status';end if;
 if period_row.status='closed' then raise exception 'Accounting period is closed and cannot accept postings';end if;
 close_owned:=(new.source_type in('revenue_recognition','expected_loss_provision') and new.entry_kind='poc' and new.entry_date=period_row.period_end) or(new.source_type='year_end_close' and new.entry_kind='closing' and new.source_id=period_row.id and new.entry_date=period_row.period_end and period_row.fiscal_period in(12,13));
 if period_row.status='reviewing' and close_owned is not true then raise exception 'Accounting period is reviewing and cannot accept operational postings';end if;
 return new;
end $$;
drop trigger if exists journal_entries_guard_period_posting on public.journal_entries;
create trigger journal_entries_guard_period_posting before insert or update of status,entry_date,period_id,org_id,source_type,source_id,entry_kind on public.journal_entries for each row execute function public.books_guard_period_posting();
revoke all on function public.books_guard_period_posting() from public,anon,authenticated;

-- Ordinary source writers share this fence and remain concurrent. Payroll
-- commit takes its exclusive side before inspecting current native/accounting/
-- construction sources. No salary table read or elevated trigger privileges.
create function public.books_lock_payroll_source_write() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare org uuid; organizations uuid[];
begin
 if tg_op='INSERT' then organizations:=array[new.org_id];elsif tg_op='DELETE' then organizations:=array[old.org_id];else organizations:=array[old.org_id,new.org_id];end if;
 for org in select distinct value from unnest(organizations) value order by value loop
  if not pg_try_advisory_xact_lock_shared(hashtextextended('books-payroll-source:'||org::text,0)) then raise exception 'Payroll source evidence is frozen by a transaction; retry source change' using errcode='40001';end if;
 end loop;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function public.books_lock_payroll_source_write() from public,anon,authenticated;
do $$declare table_name text;begin
 foreach table_name in array array['time_entries','job_cost_entries','accounting_facts','journal_entries','journal_lines','books_projection_receipts','budgets','budget_lines','billable_costs','gl_accounts'] loop
  execute format('create trigger books_payroll_source_fence before insert or update or delete on public.%I for each row execute function public.books_lock_payroll_source_write()',table_name);
 end loop;
end $$;

-- PAYROLL CONTEXT: callers must keep this transaction open through all posting
-- writes. Calling it as a standalone preflight releases locks on RPC completion.
create function public.lock_books_payroll_posting_context(p_org_id uuid,p_proposal_id uuid)
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
 return jsonb_build_object('version',1,'orgId',p_org_id,'proposalId',proposal.id,'payrollImportId',parent_id,'planDigest',proposal.plan_digest,'accountingDates',date_rows,'calendarBlockers',calendar_blockers,'constructionBlockers',allocation_blockers,'controlsSatisfied',jsonb_array_length(calendar_blockers)=0 and jsonb_array_length(allocation_blockers)=0,'postingImplemented',false,'locksHeldUntilTransactionEnd',true);
end $$;
revoke all on function public.lock_books_payroll_posting_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.lock_books_payroll_posting_context(uuid,uuid) to service_role;

-- ==== 20261004001339_books_payroll_atomic_posting ====
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

-- ==== 20261004004909_books_payroll_native_ownership ====
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

-- ==== 20261004014207_books_payroll_correction_sources ====
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

-- ==== 20261004021236_books_payroll_correction_math ====
-- Independent provider-only correction arithmetic. These helpers authorize no
-- money writes. A reviewed source is documentary evidence, not a posting review.
create function public.books_payroll_apportion_cents(p_amount jsonb,p_capacities jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare amount numeric:=public.books_payroll_exact_amount(p_amount); total numeric; result jsonb;
begin
 if jsonb_typeof(p_capacities) is distinct from 'array' or jsonb_array_length(p_capacities)=0
 or exists(select 1 from jsonb_array_elements(p_capacities) x where jsonb_typeof(x.value) is distinct from 'object' or x.value-array['id','cents']<>'{}'::jsonb or (x.value->>'id')::uuid is null)
 or (select count(*) from jsonb_array_elements(p_capacities))<>(select count(distinct (value->>'id')::uuid) from jsonb_array_elements(p_capacities)) then raise exception 'Payroll capacities require unique allocation identities';end if;
 select sum(public.books_payroll_exact_amount(value->'cents')) into total from jsonb_array_elements(p_capacities);
 if total>9007199254740991 or amount>total then raise exception 'Payroll deductions exceed exact gross capacity';end if;
 with shares as (
  select (value->>'id')::uuid::text id,case when total=0 then 0 else div(amount*public.books_payroll_exact_amount(value->'cents'),total) end base,
  case when total=0 then 0 else mod(amount*public.books_payroll_exact_amount(value->'cents'),total) end remainder from jsonb_array_elements(p_capacities)
 ), ranked as(select *,row_number() over(order by remainder desc,id collate "C") rank,sum(base) over() assigned from shares)
 select jsonb_object_agg(id,base+case when rank<=amount-assigned then 1 else 0 end) into result from ranked;
 return result;
end $$;

create function public.books_payroll_provider_components(p_run jsonb,p_accounts jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare w jsonb;a jsonb;ac jsonb;taxes jsonb;deductions jsonb; capacities jsonb;key text;v numeric; component text;debit_code text;credit_code text;code text;sign integer;rows jsonb:='[]';
begin
 if jsonb_typeof(p_run) is distinct from 'object' or (p_run->>'org_id')::uuid is null or jsonb_typeof(p_run->'employees') is distinct from 'array' or jsonb_array_length(p_run->'employees')=0 or jsonb_typeof(p_accounts) is distinct from 'array' then raise exception 'Provider component register/chart is required';end if;
 if exists(select 1 from jsonb_array_elements(p_accounts) ac where ac.value->>'org_id' is distinct from p_run->>'org_id' or (ac.value->>'id')::uuid is null or ac.value->'active' is distinct from 'true'::jsonb)
 or (select count(*) from jsonb_array_elements(p_accounts))<>(select count(distinct (value->>'id')::uuid) from jsonb_array_elements(p_accounts))
 or (select count(*) from jsonb_array_elements(p_accounts))<>(select count(distinct value->>'code') from jsonb_array_elements(p_accounts)) then raise exception 'Provider component account identity/scope differs';end if;
 foreach code in array array['2200','2230'] loop
  if (select count(*) from jsonb_array_elements(p_accounts) ac where ac.value->>'code'=code and ac.value->>'account_type'='liability')<>1 then raise exception 'Provider liability account differs';end if;
 end loop;
 if (select count(*) from jsonb_array_elements(p_run->'employees'))<>(select count(distinct (value->>'worker_id')::uuid) from jsonb_array_elements(p_run->'employees'))
 or (select count(*) from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations'))<>(select count(distinct (a.value->>'id')::uuid) from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a) then raise exception 'Provider worker/allocation identity is duplicated';end if;
 foreach key in array array['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents'] loop
  select sum(public.books_payroll_exact_amount(value->key)) into v from jsonb_array_elements(p_run->'employees');
  if v is distinct from public.books_payroll_exact_amount(p_run->'controls'->key) then raise exception 'Provider component controls differ';end if;
 end loop;
 v:=public.books_payroll_exact_amount(p_run#>'{controls,gross_cents}')+public.books_payroll_exact_amount(p_run#>'{controls,employer_taxes_cents}')+public.books_payroll_exact_amount(p_run#>'{controls,employer_benefits_cents}');
 if v>9007199254740991 or v is distinct from public.books_payroll_exact_amount(p_run#>'{controls,funding_cents}') then raise exception 'Provider component funding differs';end if;
 for w in select value from jsonb_array_elements(p_run->'employees') loop
  if (w->>'worker_id')::uuid is null or public.books_payroll_exact_amount(w->'gross_cents')=0 or public.books_payroll_exact_amount(w->'gross_cents')<>public.books_payroll_exact_amount(w->'net_cents')+public.books_payroll_exact_amount(w->'employee_taxes_cents')+public.books_payroll_exact_amount(w->'employee_deductions_cents') or jsonb_typeof(w->'allocations') is distinct from 'array' or jsonb_array_length(w->'allocations')=0 then raise exception 'Provider component employee amounts differ';end if;
  foreach key in array array['gross_cents','employer_taxes_cents','employer_benefits_cents'] loop
   select sum(public.books_payroll_exact_amount(value->key)) into v from jsonb_array_elements(w->'allocations');
   if v is distinct from public.books_payroll_exact_amount(w->key) then raise exception 'Provider component allocation amounts differ';end if;
  end loop;
  select jsonb_agg(jsonb_build_object('id',value->>'id','cents',value->'gross_cents')) into capacities from jsonb_array_elements(w->'allocations');
  taxes:=public.books_payroll_apportion_cents(w->'employee_taxes_cents',capacities);
  select jsonb_agg(jsonb_build_object('id',value->>'id','cents',public.books_payroll_exact_amount(value->'gross_cents')-(taxes->>((value->>'id')::uuid::text))::numeric)) into capacities from jsonb_array_elements(w->'allocations');
  deductions:=public.books_payroll_apportion_cents(w->'employee_deductions_cents',capacities);
  for a in select value from jsonb_array_elements(w->'allocations') loop
   select value into ac from jsonb_array_elements(p_accounts) where value->>'code'=a->>'cost_account_code';
   if ac is null or not(ac->>'account_type' in('expense','cogs') or(ac->>'account_type'='asset' and ac->>'subtype'='work_in_progress' and a->>'project_id' is not null)) then raise exception 'Provider component requires cost/construction inventory account';end if;
   foreach component in array array['gross_variance','employee_taxes','employee_deductions','employer_taxes','employer_benefits'] loop
    v:=case component when 'gross_variance' then public.books_payroll_exact_amount(a->'gross_cents') when 'employee_taxes' then (taxes->>((a->>'id')::uuid::text))::numeric when 'employee_deductions' then (deductions->>((a->>'id')::uuid::text))::numeric when 'employer_taxes' then public.books_payroll_exact_amount(a->'employer_taxes_cents') else public.books_payroll_exact_amount(a->'employer_benefits_cents') end;
    if v=0 then continue;end if;
    debit_code:=case when component in('employee_taxes','employee_deductions') then '2200' else a->>'cost_account_code' end;
    credit_code:=case when component='gross_variance' then '2200' else '2230' end;
    foreach sign in array array[1,-1] loop
     code:=case when sign=1 then debit_code else credit_code end;
     select value into ac from jsonb_array_elements(p_accounts) where value->>'code'=code;
     rows:=rows||jsonb_build_array(jsonb_build_object('key',jsonb_build_array(w->>'worker_id',a->>'id',a->>'project_id',a->>'cost_code_id',ac->>'id',component),'accountCode',code,'amountCents',v*sign));
    end loop;
   end loop;
  end loop;
 end loop;
 return rows;
end $$;

create function public.books_payroll_provider_delta(p_before jsonb,p_before_accounts jsonb,p_after jsonb,p_after_accounts jsonb,p_request jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare before_components jsonb;after_components jsonb;components jsonb;lines jsonb;entry jsonb;v numeric;cost numeric;project_cost numeric;liability_delta jsonb;
begin
 if p_before->>'org_id' is distinct from p_after->>'org_id' or p_request->>'id' is distinct from p_after->>'id' or (p_request->>'postingId')::uuid is null then raise exception 'Provider correction identity differs';end if;
 before_components:=public.books_payroll_provider_components(p_before,p_before_accounts);
 after_components:=public.books_payroll_provider_components(p_after,p_after_accounts);
 components:=before_components||after_components;
 if exists(select 1 from jsonb_array_elements(components) group by value->'key' having count(distinct value->>'accountCode')<>1) then raise exception 'Provider correction account classification differs';end if;
 with movements as (
  select value,-1 sign from jsonb_array_elements(before_components)
  union all select value,1 from jsonb_array_elements(after_components)
 ), buckets as(select value->'key' key,min(value->>'accountCode') code,sum((value->>'amountCents')::numeric*sign) amount from movements group by value->'key'), drafts as(
  select key,amount,code,jsonb_build_object('accountCode',code,'debitCents',greatest(amount,0),'creditCents',greatest(-amount,0),'description','Payroll correction '||(key->>5),'dimensions',jsonb_build_object('payroll_run_id',p_before->>'id','payroll_worker_id',key->>0,'payroll_allocation_id',key->>1,'payroll_component',key->>5,'payroll_correction_id',p_request->>'id','payroll_original_posting_id',p_request->>'postingId','books_correction_account_id',key->>4)||case when key->>3 is null then '{}'::jsonb else jsonb_build_object('cost_code_id',key->>3) end)||case when key->>2 is null then '{}'::jsonb else jsonb_build_object('projectId',key->>2) end line from buckets where amount<>0
 ) select coalesce(jsonb_agg(line order by key::text collate "C"),'[]'::jsonb),coalesce(sum(amount),0),coalesce(sum(amount) filter(where code not in('2200','2230')),0),coalesce(sum(amount) filter(where code not in('2200','2230') and key->>2 is not null),0) into lines,v,cost,project_cost from drafts;
 if v<>0 or abs(cost)>9007199254740991 or abs(project_cost)>9007199254740991 or abs(cost-project_cost)>9007199254740991 or exists(select 1 from jsonb_array_elements(lines) where greatest((value->>'debitCents')::numeric,(value->>'creditCents')::numeric)>9007199254740991) then raise exception 'Provider correction delta is unbalanced or exceeds exact cents';end if;
 if jsonb_array_length(lines)>0 then
  entry:=jsonb_build_object('entryDate',p_request->>'accountingDate','entryKind','adjusting','memo','Correct payroll '||(p_after->>'provider')||' '||(p_after->>'provider_run_id')||': '||(p_request->>'reason'),'postingKey','payroll_correction:'||(p_request->>'id')||':s1:v1','projectionVersion',1,'policyVersion',1,'sourceType','payroll_correction','sourceId',p_request->>'id','lines',lines);
 end if;
 select jsonb_object_agg(label,public.books_payroll_exact_amount(p_after->'controls'->field)-public.books_payroll_exact_amount(p_before->'controls'->field)) into liability_delta
 from(values('netPayCents','net_cents'),('employeeTaxesCents','employee_taxes_cents'),('employeeDeductionsCents','employee_deductions_cents'),('employerTaxesCents','employer_taxes_cents'),('employerBenefitsCents','employer_benefits_cents')) amounts(label,field);
 return jsonb_build_object('journalDraft',entry,'costDeltaCents',cost,'projectCostDeltaCents',project_cost,'overheadCostDeltaCents',cost-project_cost,'liabilityDelta',liability_delta,'cashDeltaCents',0,'customerAmountDeltaCents',0,'nativeLaborReconciledAgain',false);
end $$;

-- First correction baseline only: this proves provider arithmetic against the
-- original posted receipt. A future money transaction must also resolve the
-- latest actual posted correction and independently reviewed business decisions,
-- hold source/calendar fences, and atomically own every GL/fact/job-cost row.
create function public.reviewed_books_payroll_correction_delta(p_org uuid,p_source uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source public.books_payroll_correction_sources;posting public.books_payroll_postings;parent public.books_payroll_imports;
begin
 select * into source from public.books_payroll_correction_sources where org_id=p_org and id=p_source for share;
 if source.id is null or source.status<>'reviewed' or source.evidence_hash is distinct from public.books_payroll_correction_source_hash(to_jsonb(source)) then raise exception 'Provider correction requires immutable reviewed source';end if;
 perform public.validate_books_payroll_correction_source(p_org,p_source,source.posting_id,to_jsonb(source));
 select * into posting from public.books_payroll_postings where org_id=p_org and id=source.posting_id for share;
 select * into parent from public.books_payroll_imports where org_id=p_org and id=posting.payroll_import_id for share;
 return public.books_payroll_provider_delta(parent.run,parent.reconciliation->'postingAccounts',source.run,source.account_snapshot,source.request);
end $$;

revoke all on function public.books_payroll_apportion_cents(jsonb,jsonb),public.books_payroll_provider_components(jsonb,jsonb),public.books_payroll_provider_delta(jsonb,jsonb,jsonb,jsonb,jsonb),public.reviewed_books_payroll_correction_delta(uuid,uuid) from public,anon,authenticated;
grant execute on function public.books_payroll_apportion_cents(jsonb,jsonb),public.books_payroll_provider_components(jsonb,jsonb),public.books_payroll_provider_delta(jsonb,jsonb,jsonb,jsonb,jsonb),public.reviewed_books_payroll_correction_delta(uuid,uuid) to service_role;

-- ==== 20261004022226_books_payroll_correction_context ====
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

-- ==== 20261004024219_books_payroll_correction_proposals ====
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

-- ==== 20261004031113_books_payroll_correction_atomic_posting ====
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

-- ==== 20261004033518_books_payroll_correction_lineage ====
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

-- ==== 20261004041617_books_payroll_correction_construction_policy ====
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

-- ==== 20261004042836_books_payroll_correction_construction_decisions ====
-- Explicit placement decisions live in the immutable monetary proposal. The
-- independent monetary reviewer approves all choices with the exact source,
-- signed leg amounts, baseline and current construction/commercial evidence.
create function public.books_payroll_correction_commercial_context(p_org_id uuid,p_source_id uuid)
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
revoke all on function public.books_payroll_correction_commercial_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.books_payroll_correction_commercial_context(uuid,uuid) to service_role;

create function public.lock_books_payroll_correction_decisions(p_org_id uuid,p_source_id uuid,p_decisions jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare result jsonb;context jsonb;choice jsonb;leg jsonb;costs jsonb:='[]';chosen jsonb;selected uuid[];budget_line public.budget_lines;budget public.budgets;needed integer;matches integer;key text;
begin
 result:=public.books_payroll_correction_commercial_context(p_org_id,p_source_id);
 if p_decisions is null then return result;end if;
 if jsonb_typeof(p_decisions)<>'array' or jsonb_array_length(p_decisions)=0 then raise exception 'Construction decisions require nonempty complete leg choices';end if;
 select count(*) into needed from jsonb_array_elements(result->'projectCosts') where value->'blockers' ? 'review_new_or_reallocated_budget_and_gmp';
 if needed<>jsonb_array_length(p_decisions) then raise exception 'Construction decisions must cover each new or reallocated cost leg exactly once';end if;
 for choice in select value from jsonb_array_elements(p_decisions) loop
  if jsonb_typeof(choice)<>'object' or (select count(*) from jsonb_object_keys(choice))<>10 or not(choice ?& array['workerId','allocationId','projectId','costCodeId','accountId','component','budgetLineId','gmpClassification','billingTreatment','reason']) then raise exception 'Construction decision fields differ';end if;
  foreach key in array array['workerId','allocationId','projectId','accountId'] loop
   if jsonb_typeof(choice->key)<>'string' or choice->>key is distinct from (choice->>key)::uuid::text then raise exception 'Construction decision identity differs';end if;
  end loop;
  foreach key in array array['costCodeId','budgetLineId'] loop
   if choice->key<>'null'::jsonb and (jsonb_typeof(choice->key)<>'string' or choice->>key is distinct from (choice->>key)::uuid::text) then raise exception 'Construction decision nullable identity differs';end if;
  end loop;
  foreach key in array array['component','gmpClassification','billingTreatment','reason'] loop
   if jsonb_typeof(choice->key) is distinct from 'string' then raise exception 'Construction decision requires explicit GMP, billing and explanation';end if;
  end loop;
  if choice->>'component' not in('gross_variance','employer_taxes','employer_benefits') or choice->>'gmpClassification' not in('inside_gmp','outside_gmp') or choice->>'billingTreatment'<>'preserve_time_and_materials_rates' or jsonb_typeof(choice->'reason')<>'string' or length(btrim(choice->>'reason')) not between 20 and 4000 or choice->>'reason'<>btrim(choice->>'reason') then raise exception 'Construction decision requires explicit GMP, billing and explanation';end if;
  select count(*) into matches from jsonb_array_elements(result->'projectCosts') where value->'blockers' ? 'review_new_or_reallocated_budget_and_gmp' and value->>'workerId'=choice->>'workerId' and value->>'allocationId'=choice->>'allocationId' and value->>'projectId'=choice->>'projectId' and value->>'costCodeId' is not distinct from choice->>'costCodeId' and value->>'accountId'=choice->>'accountId' and value->>'component'=choice->>'component';
  if matches<>1 or (select count(*) from jsonb_array_elements(p_decisions) where value-array['budgetLineId','gmpClassification','billingTreatment','reason']=choice-array['budgetLineId','gmpClassification','billingTreatment','reason'])<>1 then raise exception 'Construction decisions must cover each new or reallocated cost leg exactly once';end if;
 end loop;
 select array_agg(distinct (value->>'budgetLineId')::uuid order by (value->>'budgetLineId')::uuid) into selected from jsonb_array_elements(p_decisions) where value->>'budgetLineId' is not null;
 perform 1 from public.budget_lines where org_id=p_org_id and id=any(selected) order by id for share;
 context:=result->'context';
 context:=context||jsonb_build_object('budget_lines',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.budget_lines r where org_id=p_org_id and (id=any(selected) or exists(select 1 from jsonb_array_elements(context->'budget_lines') where value->>'id'=r.id::text))));
 context:=public.books_payroll_context_canonical(context);
 for leg in select value from jsonb_array_elements(result->'projectCosts') loop
  select value into chosen from jsonb_array_elements(p_decisions) where value->>'workerId'=leg->>'workerId' and value->>'allocationId'=leg->>'allocationId' and value->>'projectId'=leg->>'projectId' and value->>'costCodeId' is not distinct from leg->>'costCodeId' and value->>'accountId'=leg->>'accountId' and value->>'component'=leg->>'component';
  if chosen is not null then
   if chosen->>'budgetLineId' is not null then
    select * into budget_line from public.budget_lines where org_id=p_org_id and id=(chosen->>'budgetLineId')::uuid;
    select * into budget from public.budgets where org_id=p_org_id and id=budget_line.budget_id;
    if budget_line.id is null or budget.id is null or budget.project_id::text is distinct from chosen->>'projectId' or budget_line.cost_code_id::text is distinct from chosen->>'costCodeId' then raise exception 'Construction decision budget is outside the corrective project and cost code';end if;
   end if;
   leg:=leg||jsonb_build_object('budgetLineId',chosen->'budgetLineId','gmpClassification',chosen->'gmpClassification','blockers',(select coalesce(jsonb_agg(value order by ordinal),'[]') from jsonb_array_elements(leg->'blockers') with ordinality a(value,ordinal) where value#>>'{}' not in('review_new_or_reallocated_budget_and_gmp','review_customer_billing_basis')));
  end if;
  costs:=costs||jsonb_build_array(leg);
 end loop;
 return result||jsonb_build_object('version',3,'constructionDecisions',p_decisions,'projectCosts',costs,'context',context,'contextHash',encode(sha256(convert_to(context::text,'UTF8')),'hex'),'requiresConstructionReview',exists(select 1 from jsonb_array_elements(costs) where jsonb_array_length(value->'blockers')>0));
end $$;
revoke all on function public.lock_books_payroll_correction_decisions(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.lock_books_payroll_correction_decisions(uuid,uuid,jsonb) to service_role;

create or replace function public.lock_books_payroll_correction_context(p_org_id uuid,p_source_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare chosen jsonb;
begin
 -- Acquire the same org/source/calendar fences before selecting the active
 -- proposal; a reviewed choice is never a session-local setting or bypass flag.
 perform public.books_payroll_correction_commercial_context(p_org_id,p_source_id);
 select plan->'constructionDecisions' into chosen from public.books_payroll_correction_proposals where org_id=p_org_id and source_id=p_source_id and status<>'withdrawn' and (posted_receipt_id is null or not exists(select 1 from public.books_payroll_correction_postings r where r.org_id=p_org_id and r.id=posted_receipt_id));
 return public.lock_books_payroll_correction_decisions(p_org_id,p_source_id,chosen);
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
 expected:=public.lock_books_payroll_correction_decisions(new.org_id,new.source_id,new.plan->'constructionDecisions')-'locksHeldUntilTransactionEnd';
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
create or replace function public.prepare_books_payroll_correction_proposal(p_org_id uuid,p_id uuid,p_source_id uuid,p_actor_id uuid,p_plan jsonb,p_notes text,p_key text)
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
 expected:=public.lock_books_payroll_correction_decisions(p_org_id,p_source_id,p_plan->'constructionDecisions')-'locksHeldUntilTransactionEnd';
 if expected is distinct from p_plan then raise exception 'Correction context changed before preparation';end if;
 insert into public.books_payroll_correction_proposals(id,org_id,source_id,posting_id,plan,plan_text,context_text,plan_digest,prepared_by,preparation_notes,idempotency_key)
 values(p_id,p_org_id,p_source_id,(expected->>'originalPostingId')::uuid,expected,expected::text,(expected->'context')::text,encode(sha256(convert_to(expected::text,'UTF8')),'hex'),p_actor_id,p_notes,p_key);
 return p_id;
end $$;

-- ==== 20261004053644_books_payroll_workspace_reads ====
-- Private project review reads: bounded source pages and complete selected-root proof.
-- No export snapshot, no temporary tables, no caller-supplied table names.
create index books_payroll_workspace_source_page_idx on public.books_payroll_correction_sources(org_id, prepared_at desc, id desc);
create index books_payroll_workspace_source_run_idx on public.books_payroll_correction_sources using gin(run jsonb_path_ops);
create index books_payroll_workspace_import_run_idx on public.books_payroll_imports using gin(run jsonb_path_ops);
create index books_payroll_workspace_job_root_idx on public.job_cost_entries(org_id, (metadata->>'payroll_original_posting_id')) where source_type='payroll_correction';
create index books_payroll_workspace_job_receipt_idx on public.job_cost_entries(org_id, (metadata->>'payroll_correction_posting_id')) where source_type='payroll_correction';
create index books_payroll_workspace_job_original_idx on public.job_cost_entries(org_id, (metadata->>'payroll_posting_id')) where source_type='payroll_import';
create index books_payroll_workspace_liability_code_idx on public.journal_lines(org_id, ((dimensions->'books_account_classification')->>'code'), entry_id);

create function public.capture_books_payroll_workspace_snapshot(
 p_org_id uuid, p_project_id uuid, p_source_id uuid default null,
 p_before_time timestamptz default null, p_before_id uuid default null, p_limit integer default 50
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
 v_page jsonb; v_ids uuid[]; v_roots uuid[]; v_imports uuid[]; v_projects uuid[];
 v_jobs uuid[]; v_native_journals uuid[]; v_native_facts uuid[]; v_times uuid[];
 v_liability_journals uuid[]; v_journals uuid[]; v_facts uuid[]; v_codes uuid[];
 v_table text; v_predicate text; v_rows jsonb; v_tables jsonb := '{}'::jsonb;
 v_more boolean; v_next jsonb; v_project jsonb;
begin
 if p_org_id is null or p_project_id is null or p_limit is null or p_limit not between 1 and 50
   or (p_before_time is null) <> (p_before_id is null)
   or (p_source_id is not null and p_before_time is not null) then
  raise exception 'Invalid payroll workspace scope or pagination';
 end if;
 select to_jsonb(p) into v_project from public.projects p where p.org_id=p_org_id and p.id=p_project_id;
 if v_project is null then raise exception 'Project is unavailable in this organization'; end if;
 with affected_roots as (
  select p.id from public.books_payroll_postings p
  join public.books_payroll_imports i on i.org_id=p.org_id and i.id=p.payroll_import_id
  where p.org_id=p_org_id and i.run @> jsonb_build_object('employees',jsonb_build_array(jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('project_id',p_project_id)))))
  union
  select s.posting_id from public.books_payroll_correction_sources s where s.org_id=p_org_id
  and s.run @> jsonb_build_object('employees',jsonb_build_array(jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('project_id',p_project_id)))))
 ), page as (
  select s.id,s.posting_id,s.prepared_at from public.books_payroll_correction_sources s
  where s.org_id=p_org_id and s.posting_id in(select id from affected_roots)
  and (p_source_id is null or s.id=p_source_id)
  and (p_before_time is null or (s.prepared_at,s.id)<(p_before_time,p_before_id))
  order by s.prepared_at desc,s.id desc limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by prepared_at desc,id desc),'[]'::jsonb) into v_page from page;
 if p_source_id is not null and jsonb_array_length(v_page)<>1 then raise exception 'Payroll correction does not affect this project or is unavailable';end if;
 v_more := jsonb_array_length(v_page)>p_limit;
 if v_more then v_page := v_page - p_limit; end if;
 select coalesce(array_agg((r->>'id')::uuid order by ordinal),'{}'::uuid[]),coalesce(array_agg(distinct (r->>'posting_id')::uuid),'{}'::uuid[])
 into v_ids,v_roots from jsonb_array_elements(v_page) with ordinality x(r,ordinal);
 if cardinality(v_ids)=0 then
  return jsonb_build_object('orgId',p_org_id,'projectId',p_project_id,'projectName',coalesce(v_project->>'name','Project'),
   'sourceIds','[]'::jsonb,'nextCursor',null,'capturedAt',statement_timestamp(),'databaseSnapshot',pg_current_snapshot()::text,
   'tables',jsonb_build_object('projects',jsonb_build_array(v_project),'books_payroll_correction_sources','[]'::jsonb));
 end if;
 if v_more then v_next:=jsonb_build_object('preparedAt',v_page->(p_limit-1)->'prepared_at','id',v_page->(p_limit-1)->'id');end if;
 select coalesce(array_agg(p.payroll_import_id),'{}'::uuid[]) into v_imports from public.books_payroll_postings p where p.org_id=p_org_id and p.id=any(v_roots);
 select coalesce(array_agg(distinct (a->>'project_id')::uuid) filter(where a->>'project_id' is not null),'{}'::uuid[]),
        coalesce(array_agg(distinct (a->>'cost_code_id')::uuid) filter(where a->>'cost_code_id' is not null),'{}'::uuid[])
 into v_projects,v_codes from (
  select i.run from public.books_payroll_imports i where i.org_id=p_org_id and i.id=any(v_imports)
  union all select s.run from public.books_payroll_correction_sources s where s.org_id=p_org_id and s.posting_id=any(v_roots)
 ) runs cross join lateral jsonb_array_elements(runs.run->'employees') w cross join lateral jsonb_array_elements(w->'allocations') a;
 v_projects:=array_append(v_projects,p_project_id);
 select coalesce(array_agg(distinct o.job_cost_entry_id),'{}'::uuid[]),coalesce(array_agg(distinct o.journal_id),'{}'::uuid[]),
 coalesce(array_agg(distinct o.fact_id),'{}'::uuid[]),coalesce(array_agg(distinct o.time_entry_id),'{}'::uuid[])
 into v_jobs,v_native_journals,v_native_facts,v_times from public.books_payroll_labor_ownership o where o.org_id=p_org_id and o.posting_id=any(v_roots);
 -- Preserve original IDs even if native ownership has been damaged: proof must fail.
 select v_jobs || coalesce(array_agg((e->>'id')::uuid),'{}'::uuid[]),
 v_native_journals || coalesce(array_agg((e->>'journal_id')::uuid),'{}'::uuid[]),
 v_native_facts || coalesce(array_agg((e->>'fact_id')::uuid),'{}'::uuid[])
 into v_jobs,v_native_journals,v_native_facts
 from public.books_payroll_imports i cross join lateral jsonb_array_elements(i.labor_evidence) e where i.org_id=p_org_id and i.id=any(v_imports);
 -- Full organization liability attribution remains required; both current chart and
 -- frozen original classification select movements. Fetch every balancing line.
 select coalesce(array_agg(distinct l.entry_id),'{}'::uuid[]) into v_liability_journals
 from public.journal_lines l left join public.gl_accounts a on a.org_id=l.org_id and a.id=l.account_id
 left join public.journal_entries j on j.org_id=l.org_id and j.id=l.entry_id
 where l.org_id=p_org_id and j.source_type is distinct from 'labor_cost' and (a.code in('2200','2230') or l.dimensions->'books_account_classification'->>'code' in('2200','2230'));
 select coalesce(array_agg(j.id),'{}'::uuid[]) into v_journals from public.journal_entries j where j.org_id=p_org_id and (
 j.id=any(v_native_journals) or j.id=any(v_liability_journals)
 or (j.source_type='payroll_import' and j.source_id=any(v_imports))
 or (j.source_type='payroll_correction' and j.source_id in(select s.id from public.books_payroll_correction_sources s where s.org_id=p_org_id and s.posting_id=any(v_roots)))
 or j.id in(select (r.result->>'journalId')::uuid from public.books_payroll_correction_postings r where r.org_id=p_org_id and r.posting_id=any(v_roots))
 or j.id in(select (r->>'journalId')::uuid from public.books_payroll_postings p cross join lateral jsonb_array_elements(p.result->'journals') r where p.org_id=p_org_id and p.id=any(v_roots)));
 select coalesce(array_agg(f.id),'{}'::uuid[]) into v_facts from public.accounting_facts f where f.org_id=p_org_id and (
 f.id=any(v_native_facts) or f.id in(select j.fact_id from public.journal_entries j where j.org_id=p_org_id and j.id=any(v_journals))
 or (f.source_type='payroll_import' and f.source_id=any(v_imports))
 or (f.source_type='payroll_correction' and f.source_id in(select s.id from public.books_payroll_correction_sources s where s.org_id=p_org_id and s.posting_id=any(v_roots)))
 or f.id in(select (r.result->>'factId')::uuid from public.books_payroll_correction_postings r where r.org_id=p_org_id and r.posting_id=any(v_roots))
 or f.id in(select (r->>'factId')::uuid from public.books_payroll_postings p cross join lateral jsonb_array_elements(p.result->'journals') r where p.org_id=p_org_id and p.id=any(v_roots)));
  foreach v_table in array array['books_payroll_imports','books_payroll_postings','books_payroll_posting_proposals','books_payroll_payment_reviews','books_payroll_labor_ownership','books_payroll_correction_sources','books_payroll_correction_proposals','books_payroll_correction_postings','projects','cost_codes','gl_accounts','accounting_periods','project_financial_settings','contracts','closings','budgets','budget_lines','billable_costs','job_cost_entries','journal_entries','journal_lines','accounting_facts','books_projection_receipts','time_entries'] loop
  v_predicate:=case v_table
   when 'books_payroll_imports' then 't.id=any($3)'
   when 'books_payroll_postings' then 't.id=any($2)'
   when 'books_payroll_posting_proposals' then 't.payroll_import_id=any($3)'
   when 'books_payroll_payment_reviews' then 't.payroll_import_id=any($3)'
   when 'books_payroll_labor_ownership' then 't.posting_id=any($2)'
   when 'books_payroll_correction_sources' then 't.posting_id=any($2)'
   when 'books_payroll_correction_proposals' then 't.posting_id=any($2)'
   when 'books_payroll_correction_postings' then 't.posting_id=any($2)'
   when 'projects' then 't.id=any($4)'
   when 'cost_codes' then 't.id=any($10)'
   when 'gl_accounts' then 'true'
   when 'accounting_periods' then 'true'
   when 'project_financial_settings' then 't.project_id=any($4)'
   when 'contracts' then 't.project_id=any($4)'
   when 'closings' then 't.project_id=any($4)'
   when 'budgets' then 't.project_id=any($4)'
   when 'budget_lines' then 't.budget_id in(select b.id from public.budgets b where b.org_id=$1 and b.project_id=any($4))
 or t.id::text in(select x->>''id'' from public.books_payroll_imports i cross join lateral jsonb_array_elements(i.reconciliation->''workflowEvidence''->''sourceTables''->''budget_lines'') x where i.org_id=$1 and i.id=any($3))
 or t.id::text in(select x->>''id'' from public.books_payroll_correction_proposals p cross join lateral jsonb_array_elements(p.plan->''context''->''budget_lines'') x where p.org_id=$1 and p.posting_id=any($2))'
   when 'billable_costs' then 't.id::text in(select x #>> ''{}'' from public.books_payroll_postings p cross join lateral jsonb_array_elements(p.result->''billingPreserved'') x where p.org_id=$1 and p.id=any($2))
 or t.id::text in(select x #>> ''{}'' from public.books_payroll_correction_postings p cross join lateral jsonb_array_elements(p.result->''billingPreserved'') x where p.org_id=$1 and p.posting_id=any($2))'
   when 'job_cost_entries' then 't.id=any($5) or (t.source_type=''payroll_import'' and t.metadata->>''payroll_posting_id''=any(select r::text from unnest($2) r))
 or (t.source_type=''payroll_correction'' and (t.metadata->>''payroll_original_posting_id''=any(select r::text from unnest($2) r)
 or t.metadata->>''payroll_correction_posting_id'' in(select r.id::text from public.books_payroll_correction_postings r where r.org_id=$1 and r.posting_id=any($2))))
 or t.id::text in(select x->>''jobCostId'' from public.books_payroll_postings p cross join lateral jsonb_array_elements(p.result->''jobCostCorrections'') x where p.org_id=$1 and p.id=any($2))
 or t.id::text in(select x->>''jobCostId'' from public.books_payroll_correction_postings p cross join lateral jsonb_array_elements(p.result->''jobCosts'') x where p.org_id=$1 and p.posting_id=any($2))'
   when 'journal_entries' then 't.id=any($6)'
   when 'journal_lines' then 't.entry_id=any($6) or t.entry_id=any($11)'
   when 'accounting_facts' then 't.id=any($7)'
   when 'books_projection_receipts' then 't.source_id=any($5) or t.journal_id=any($8)'
   when 'time_entries' then 't.id=any($9) or t.id::text in(select j.source_id from public.job_cost_entries j where j.org_id=$1 and j.id=any($5))'
   else null end;
  execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id=$1 and (%s)',v_table,v_predicate)
  into v_rows using p_org_id,v_roots,v_imports,v_projects,v_jobs,v_journals,v_facts,v_native_journals,v_times,v_codes,v_liability_journals;
  v_tables:=v_tables || jsonb_build_object(v_table,v_rows);
 end loop;
 return jsonb_build_object('orgId',p_org_id,'projectId',p_project_id,'projectName',coalesce(v_project->>'name','Project'),
  'sourceIds',to_jsonb(v_ids),'nextCursor',v_next,'capturedAt',statement_timestamp(),'databaseSnapshot',pg_current_snapshot()::text,'tables',v_tables);
end;
$$;
revoke all on function public.capture_books_payroll_workspace_snapshot(uuid,uuid,uuid,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.capture_books_payroll_workspace_snapshot(uuid,uuid,uuid,timestamptz,uuid,integer) to service_role;

-- ==== 20261004055553_books_private_payroll_documents ====
-- Salary documents remain in the existing versioned archive, but outside general
-- project document access. The discriminator lives in exported file metadata.
create index books_private_payroll_file_path_idx on public.files(org_id,storage_path) where metadata->>'books_private_kind'='payroll_register';
create index books_private_payroll_version_path_idx on public.doc_versions(org_id,storage_path,file_id);
create index books_private_payroll_import_path_idx on public.books_payroll_imports(org_id,(source_proof->>'storage_path'));
create index books_private_payroll_correction_path_idx on public.books_payroll_correction_sources(org_id,(source_proof->>'storage_path'));

update public.files f set metadata=f.metadata || '{"books_private_kind":"payroll_register"}'::jsonb,visibility='private',share_with_subs=false,share_with_clients=false
where exists(select 1 from public.books_payroll_imports p where p.org_id=f.org_id and p.source_proof->>'file_id'=f.id::text)
 or exists(select 1 from public.books_payroll_correction_sources p where p.org_id=f.org_id and p.source_proof->>'file_id'=f.id::text);

create policy books_private_payroll_files on public.files as restrictive for all to anon,authenticated
 using (metadata->>'books_private_kind' is distinct from 'payroll_register')
 with check (metadata->>'books_private_kind' is distinct from 'payroll_register');
create policy books_private_payroll_versions on public.doc_versions as restrictive for all to anon,authenticated
 using (exists(select 1 from public.files f where f.org_id=doc_versions.org_id and f.id=doc_versions.file_id))
 with check (exists(select 1 from public.files f where f.org_id=doc_versions.org_id and f.id=doc_versions.file_id));
create policy books_private_payroll_links on public.file_links as restrictive for all to anon,authenticated
 using (exists(select 1 from public.files f where f.org_id=file_links.org_id and f.id=file_links.file_id))
 with check (exists(select 1 from public.files f where f.org_id=file_links.org_id and f.id=file_links.file_id));

create function public.guard_books_private_payroll_file() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and old.metadata->>'books_private_kind'='payroll_register' then
  if new.metadata->>'books_private_kind' is distinct from 'payroll_register' or
     row(new.id,new.org_id,new.storage_path,new.file_name,new.mime_type,new.size_bytes,new.checksum,new.uploaded_by)
     is distinct from row(old.id,old.org_id,old.storage_path,old.file_name,old.mime_type,old.size_bytes,old.checksum,old.uploaded_by)
     or new.project_id is distinct from old.project_id or
     (old.current_version_id is not null and new.current_version_id is distinct from old.current_version_id) then
   raise exception 'Private payroll document identity and original bytes are immutable';
  end if;
 end if;
 if new.metadata->>'books_private_kind'='payroll_register' then
  if current_user not in('postgres','service_role','supabase_admin') then raise exception 'Private payroll documents require accounting service access';end if;
  if new.visibility is distinct from 'private' or new.share_with_subs or new.share_with_clients then raise exception 'Private payroll documents cannot be shared';end if;
 end if;
 return new;
end;
$$;
create trigger books_private_payroll_file_guard before insert or update on public.files for each row execute function public.guard_books_private_payroll_file();
revoke all on function public.guard_books_private_payroll_file() from public,anon,authenticated;

create function public.mark_books_private_payroll_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 update public.files set metadata=metadata || '{"books_private_kind":"payroll_register"}'::jsonb,visibility='private',share_with_subs=false,share_with_clients=false
 where org_id=new.org_id and id=(new.source_proof->>'file_id')::uuid;
 if not found then raise exception 'Private payroll source file is unavailable';end if;
 return new;
end;
$$;
create trigger books_private_payroll_import_source after insert on public.books_payroll_imports for each row execute function public.mark_books_private_payroll_source();
create trigger books_private_payroll_correction_source after insert on public.books_payroll_correction_sources for each row execute function public.mark_books_private_payroll_source();
revoke all on function public.mark_books_private_payroll_source() from public,anon,authenticated;

create function public.is_books_private_payroll_object(p_org_id uuid,p_path text) returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from public.files f where f.org_id=p_org_id and f.storage_path=p_path and f.metadata->>'books_private_kind'='payroll_register')
 or exists(select 1 from public.doc_versions v join public.files f on f.org_id=v.org_id and f.id=v.file_id where v.org_id=p_org_id and v.storage_path=p_path and f.metadata->>'books_private_kind'='payroll_register')
 or exists(select 1 from public.books_payroll_imports p where p.org_id=p_org_id and p.source_proof->>'storage_path'=p_path)
 or exists(select 1 from public.books_payroll_correction_sources p where p.org_id=p_org_id and p.source_proof->>'storage_path'=p_path);
$$;
revoke all on function public.is_books_private_payroll_object(uuid,text) from public,anon,authenticated;
grant execute on function public.is_books_private_payroll_object(uuid,text) to service_role;

create function public.commit_books_private_payroll_document(p_org_id uuid,p_file_id uuid,p_version_id uuid,p_actor_id uuid,p_name text,p_size bigint,p_checksum text,p_path text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare f public.files;v public.doc_versions;
begin
 if p_org_id is null or p_file_id is null or p_version_id is null or p_actor_id is null or p_size is null or p_size not between 1 and 16777216
 or p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$' or p_name is null or length(p_name) not between 1 and 200 or p_name !~* '\.csv$'
 or p_path is distinct from p_org_id::text||'/books/payroll-private/'||p_file_id::text||'/source.csv' then raise exception 'Invalid private payroll document';end if;
 if not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_actor_id and m.status='active') then raise exception 'Private payroll upload requires active organization actor';end if;
 perform pg_advisory_xact_lock(hashtextextended('private-payroll-file:'||p_org_id::text||':'||p_file_id::text,0));
 select * into f from public.files where org_id=p_org_id and id=p_file_id;
 if found then
  select * into v from public.doc_versions where org_id=p_org_id and id=p_version_id and file_id=p_file_id;
  if not found or f.current_version_id is distinct from p_version_id or f.metadata->>'books_private_kind' is distinct from 'payroll_register'
   or row(f.uploaded_by,f.storage_path,f.file_name,f.size_bytes,f.checksum) is distinct from row(p_actor_id,p_path,p_name,p_size,p_checksum)
   or row(v.storage_path,v.file_name,v.size_bytes,v.checksum) is distinct from row(p_path,p_name,p_size,p_checksum) then raise exception 'Private payroll upload identity belongs to different original bytes or actor';end if;
 else
  insert into public.files(id,org_id,project_id,file_name,storage_path,mime_type,size_bytes,checksum,visibility,uploaded_by,category,source,metadata)
  values(p_file_id,p_org_id,null,p_name,p_path,'text/csv',p_size,p_checksum,'private',p_actor_id,'financials','import','{"books_private_kind":"payroll_register"}');
  insert into public.doc_versions(id,org_id,file_id,version_number,storage_path,file_name,mime_type,size_bytes,checksum,created_by)
  values(p_version_id,p_org_id,p_file_id,1,p_path,p_name,'text/csv',p_size,p_checksum,p_actor_id);
  update public.files set current_version_id=p_version_id where org_id=p_org_id and id=p_file_id;
 end if;
 return jsonb_build_object('fileId',p_file_id,'documentVersionId',p_version_id,'fileName',p_name,'sizeBytes',p_size,'checksum',p_checksum);
end;
$$;
revoke all on function public.commit_books_private_payroll_document(uuid,uuid,uuid,uuid,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.commit_books_private_payroll_document(uuid,uuid,uuid,uuid,text,bigint,text,text) to service_role;

-- ==== 20261004064206_books_payroll_worker_directory ====
-- Private, deduplicated native worker choices. Historical memberships remain
-- available for historical payroll; no profile wage/rate values are returned.
create function public.read_books_payroll_workers(p_org_id uuid,p_after uuid default null,p_search text default '',p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_org_id is null or p_limit is null or p_limit not between 1 and 50 or p_search is null or length(p_search)>200 then raise exception 'Invalid payroll worker directory request';end if;
 with native as (
  select u.id,coalesce(nullif(u.full_name,''),u.email::text) as name,u.email::text as email,
   array_agg(distinct m.status::text order by m.status::text) as statuses
  from public.memberships m join public.app_users u on u.id=m.user_id
  where m.org_id=p_org_id and (p_after is null or u.id>p_after)
   and (p_search='' or strpos(lower(coalesce(u.full_name,'')||' '||u.email::text),lower(p_search))>0)
  group by u.id,u.full_name,u.email order by u.id limit p_limit+1
 ), page as (select * from native order by id limit p_limit)
 select jsonb_build_object('workers',coalesce((select jsonb_agg(to_jsonb(page) order by id) from page),'[]'::jsonb),
  'nextCursor',case when (select count(*) from native)>p_limit then (select id from page order by id desc limit 1) else null end)
 into result;
 return result;
end;
$$;
revoke all on function public.read_books_payroll_workers(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.read_books_payroll_workers(uuid,uuid,text,integer) to service_role;

-- ==== 20261004073018_books_payroll_draft_workspace ====
-- Unposted payroll review in project workflows. Organization overhead is shared
-- across projects only after whole-organization accounting authorization.
create index books_payroll_draft_page_idx on public.books_payroll_imports(org_id,prepared_at desc,id desc);
create function public.read_books_project_payroll_drafts(
 p_org_id uuid,p_project_id uuid,p_import_id uuid default null,
 p_before_time timestamptz default null,p_before_id uuid default null,p_limit integer default 50
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_project jsonb;v_rows jsonb;v_more boolean;v_next jsonb;v_projects jsonb;v_codes jsonb;
begin
 if p_org_id is null or p_project_id is null or p_limit is null or p_limit not between 1 and 50
 or (p_before_time is null)<>(p_before_id is null) or (p_import_id is not null and p_before_time is not null) then
  raise exception 'Invalid payroll draft scope or pagination';
 end if;
 select to_jsonb(p) into v_project from public.projects p where p.org_id=p_org_id and p.id=p_project_id;
 if v_project is null then raise exception 'Project is unavailable in this organization';end if;
 with page as (
  select i.* from public.books_payroll_imports i
  where i.org_id=p_org_id and (p_import_id is null or i.id=p_import_id)
  and not exists(select 1 from public.books_payroll_postings p where p.org_id=p_org_id and p.payroll_import_id=i.id)
  and (i.run @> jsonb_build_object('employees',jsonb_build_array(jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('project_id',p_project_id)))))
   or not exists(select 1 from jsonb_array_elements(i.run->'employees') w cross join lateral jsonb_array_elements(w->'allocations') a where a->>'project_id' is not null))
  and (p_before_time is null or (i.prepared_at,i.id)<(p_before_time,p_before_id))
  order by i.prepared_at desc,i.id desc limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by prepared_at desc,id desc),'[]') into v_rows from page;
 if p_import_id is not null and jsonb_array_length(v_rows)<>1 then raise exception 'Unposted payroll draft is unavailable for this project';end if;
 v_more:=jsonb_array_length(v_rows)>p_limit;
 if v_more then v_rows:=v_rows-p_limit;v_next:=jsonb_build_object('preparedAt',v_rows->(p_limit-1)->'prepared_at','id',v_rows->(p_limit-1)->'id');end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'org_id',p.org_id,'name',coalesce(to_jsonb(p)->>'name','Project')) order by p.id),'[]') into v_projects
 from public.projects p where p.org_id=p_org_id and p.id in(select (a->>'project_id')::uuid from jsonb_array_elements(v_rows) i cross join lateral jsonb_array_elements(i->'run'->'employees') w cross join lateral jsonb_array_elements(w->'allocations') a);
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'org_id',c.org_id,'name',coalesce(to_jsonb(c)->>'name',to_jsonb(c)->>'code','Cost code')) order by c.id),'[]') into v_codes
 from public.cost_codes c where c.org_id=p_org_id and c.id in(select (a->>'cost_code_id')::uuid from jsonb_array_elements(v_rows) i cross join lateral jsonb_array_elements(i->'run'->'employees') w cross join lateral jsonb_array_elements(w->'allocations') a);
 return jsonb_build_object('orgId',p_org_id,'projectId',p_project_id,'projectName',coalesce(v_project->>'name','Project'),'imports',v_rows,'nextCursor',v_next,'projects',v_projects,'costCodes',v_codes);
end $$;
revoke all on function public.read_books_project_payroll_drafts(uuid,uuid,uuid,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_books_project_payroll_drafts(uuid,uuid,uuid,timestamptz,uuid,integer) to service_role;

-- ==== 20261004074806_books_private_payroll_payment_documents ====
-- Payment/recognition attribution proofs contain payroll details just like the
-- provider source. Preserve every original byte/version while restricting access.
create index books_private_payroll_payment_proofs_idx on public.books_payroll_payment_reviews using gin((evidence->'supporting_documents') jsonb_path_ops);
update public.files f set metadata=f.metadata||'{"books_private_kind":"payroll_register"}'::jsonb,
 visibility='private',share_with_subs=false,share_with_clients=false
where exists(select 1 from public.books_payroll_payment_reviews r where r.org_id=f.org_id
 and r.evidence->'supporting_documents' @> jsonb_build_array(jsonb_build_object('file_id',f.id)));
create function public.mark_books_private_payroll_payment_documents() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proof jsonb;
begin
 for proof in select value from jsonb_array_elements(new.evidence->'supporting_documents') loop
  update public.files f set metadata=f.metadata||'{"books_private_kind":"payroll_register"}'::jsonb,
   visibility='private',share_with_subs=false,share_with_clients=false
  where f.org_id=new.org_id and f.id=(proof->>'file_id')::uuid
  and exists(select 1 from public.doc_versions v where v.org_id=new.org_id and v.file_id=f.id and v.id=(proof->>'document_version_id')::uuid
   and v.storage_path=proof->>'storage_path');
  if not found then raise exception 'Private payroll payment supporting file/version is unavailable';end if;
 end loop;
 return new;
end $$;
create trigger books_private_payroll_payment_documents after insert on public.books_payroll_payment_reviews for each row execute function public.mark_books_private_payroll_payment_documents();
revoke all on function public.mark_books_private_payroll_payment_documents() from public,anon,authenticated;
create or replace function public.is_books_private_payroll_object(p_org_id uuid,p_path text) returns boolean
language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from public.files f where f.org_id=p_org_id and f.storage_path=p_path and f.metadata->>'books_private_kind'='payroll_register')
 or exists(select 1 from public.doc_versions v join public.files f on f.org_id=v.org_id and f.id=v.file_id where v.org_id=p_org_id and v.storage_path=p_path and f.metadata->>'books_private_kind'='payroll_register')
 or exists(select 1 from public.books_payroll_imports p where p.org_id=p_org_id and p.source_proof->>'storage_path'=p_path)
 or exists(select 1 from public.books_payroll_correction_sources p where p.org_id=p_org_id and p.source_proof->>'storage_path'=p_path)
 or exists(select 1 from public.books_payroll_payment_reviews p where p.org_id=p_org_id
  and p.evidence->'supporting_documents' @> jsonb_build_array(jsonb_build_object('storage_path',p_path)));
$$;
revoke all on function public.is_books_private_payroll_object(uuid,text) from public,anon,authenticated;
grant execute on function public.is_books_private_payroll_object(uuid,text) to service_role;

-- ==== 20261004080920_books_payroll_support_versions ====
-- Retained private supporting versions; ordinary project document queries do
-- not participate. Caller applies whole-org accounting and project authorization.
create index books_payroll_support_version_page_idx on public.doc_versions(org_id,id);
create function public.read_books_payroll_support_versions(p_org_id uuid,p_after uuid default null,p_search text default '',p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_rows jsonb;v_more boolean;v_next uuid;
begin
 if p_org_id is null or p_search is null or length(p_search)>200 or p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid private payroll supporting-version page';end if;
 with page as (
 select v.id,v.org_id,v.file_id,v.file_name,v.mime_type,v.size_bytes,v.checksum
 from public.doc_versions v join public.files f on f.org_id=v.org_id and f.id=v.file_id
 where v.org_id=p_org_id and f.metadata->>'books_private_kind'='payroll_register'
 and v.size_bytes>0 and v.checksum ~ '^[a-f0-9]{64}$' and (p_after is null or v.id>p_after)
 and strpos(lower(v.file_name),lower(trim(p_search)))>0 order by v.id limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]') into v_rows from page;
 v_more:=jsonb_array_length(v_rows)>p_limit;
 if v_more then v_rows:=v_rows-p_limit;v_next:=(v_rows->(p_limit-1)->>'id')::uuid;end if;
 return jsonb_build_object('orgId',p_org_id,'versions',v_rows,'nextCursor',v_next);
end $$;
revoke all on function public.read_books_payroll_support_versions(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.read_books_payroll_support_versions(uuid,uuid,text,integer) to service_role;

-- ==== 20261004082928_books_payroll_payment_workspace ====
-- Bounded private history for one proven payroll import. Frozen evidence stays
-- available after withdrawal; callers must authorize the project relationship.
create index books_payroll_payment_workspace_page_idx on public.books_payroll_payment_reviews(org_id,payroll_import_id,prepared_at desc,id desc);
create function public.read_books_payroll_payment_workspace(
 p_org_id uuid,p_import_id uuid,p_review_id uuid default null,
 p_before_time timestamptz default null,p_before_id uuid default null,p_limit integer default 50
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_rows jsonb;v_next jsonb;
begin
 if p_org_id is null or p_import_id is null or p_limit is null or p_limit not between 1 and 50
 or (p_before_time is null)<>(p_before_id is null) or (p_review_id is not null and p_before_time is not null) then
  raise exception 'Invalid payroll attribution scope or pagination';
 end if;
 if not exists(select 1 from public.books_payroll_imports where org_id=p_org_id and id=p_import_id) then raise exception 'Payroll import is unavailable in organization';end if;
 with page as (
  select r.* from public.books_payroll_payment_reviews r where r.org_id=p_org_id and r.payroll_import_id=p_import_id
  and (p_review_id is null or r.id=p_review_id)
  and (p_before_time is null or (r.prepared_at,r.id)<(p_before_time,p_before_id))
  order by r.prepared_at desc,r.id desc limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by prepared_at desc,id desc),'[]') into v_rows from page;
 if p_review_id is not null and jsonb_array_length(v_rows)<>1 then raise exception 'Payroll attribution is unavailable for this import';end if;
 if jsonb_array_length(v_rows)>p_limit then
  v_rows:=v_rows-p_limit;v_next:=jsonb_build_object('preparedAt',v_rows->(p_limit-1)->'prepared_at','id',v_rows->(p_limit-1)->'id');
 end if;
 return jsonb_build_object('orgId',p_org_id,'importId',p_import_id,'reviews',v_rows,'nextCursor',v_next,
 'activeReviewId',(select id from public.books_payroll_payment_reviews where org_id=p_org_id and payroll_import_id=p_import_id and status<>'withdrawn'),
 'posted',exists(select 1 from public.books_payroll_postings where org_id=p_org_id and payroll_import_id=p_import_id));
end $$;
revoke all on function public.read_books_payroll_payment_workspace(uuid,uuid,uuid,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_books_payroll_payment_workspace(uuid,uuid,uuid,timestamptz,uuid,integer) to service_role;
