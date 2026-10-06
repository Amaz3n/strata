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
