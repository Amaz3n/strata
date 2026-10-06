-- Pending: atomic unknown-outcome resolution, retained cancellation and nonce fences.
begin;
create table public.books_native_invoice_request_fences(
 request_id uuid primary key,generation bigint not null check(generation>0)
);
create table public.books_native_invoice_request_resolutions(
 id uuid primary key,org_id uuid not null references public.orgs(id),legal_entity_id uuid not null,
 project_id uuid not null,invoice_id uuid not null,actor_id uuid not null references public.app_users(id),
 request_id uuid not null unique,entry_id uuid not null,
 request_text text not null check(octet_length(request_text)<=4198400),request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 reason text not null check(length(reason) between 10 and 2000 and reason=btrim(reason)),resolved_at timestamptz not null,resolved_access_event_id uuid not null,
 unique(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id) references public.books_legal_entities(org_id,id),
 foreign key(org_id,project_id) references public.projects(org_id,id),foreign key(org_id,invoice_id) references public.invoices(org_id,id),
 foreign key(org_id,legal_entity_id,resolved_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create index books_native_invoice_resolution_scope on public.books_native_invoice_request_resolutions(org_id,legal_entity_id,project_id,invoice_id);
create index books_native_invoice_resolution_actor on public.books_native_invoice_request_resolutions(actor_id);
create index books_native_invoice_resolution_access on public.books_native_invoice_request_resolutions(org_id,legal_entity_id,resolved_access_event_id);
create function public.books_validate_native_invoice_resolution(p_request jsonb,p_org uuid,p_entity uuid,p_project uuid,p_actor uuid)
returns uuid language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare k text;v text;c jsonb;allowed text[]:=array['expectedOrgId','expectedActorId','id','entryId','economic','notes'];
begin
 if jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>4198400 or p_request-allowed<>'{}' or (select count(*) from jsonb_object_keys(p_request))<>6 then raise exception 'Canonical native invoice resolution request is required';end if;
 foreach k in array array['expectedOrgId','expectedActorId','id','entryId'] loop v:=p_request->>k;if jsonb_typeof(p_request->k) is distinct from 'string' or v::uuid::text is distinct from v then raise exception 'Canonical native invoice request UUID is required';end if;end loop;
 c:=p_request->'economic'->'native';
 if jsonb_typeof(p_request->'economic') is distinct from 'object' or jsonb_typeof(c) is distinct from 'object' or (p_request->>'expectedOrgId',p_request->>'expectedActorId',c->>'orgId',c->>'actorId',c->>'projectId',c->'owner'->>'legal_entity_id',c->>'sourceType') is distinct from(p_org::text,p_actor::text,p_org::text,p_actor::text,p_project::text,p_entity::text,'invoice') then raise exception 'Native invoice resolution request belongs to another scope or actor';end if;
 v:=c->>'sourceId';if jsonb_typeof(c->'sourceId') is distinct from 'string' or v::uuid::text is distinct from v then raise exception 'Canonical native invoice source is required';end if;
 v:=p_request->>'notes';if jsonb_typeof(p_request->'notes') is distinct from 'string' or v is distinct from btrim(v) or length(v) not between 10 and 2000 then raise exception 'Canonical native invoice request notes are required';end if;
 return(p_request->>'id')::uuid;
end $$;
create function public.books_lock_native_invoice_request(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_invoice uuid,p_request uuid)
returns void language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
begin
 if p_request is null then raise exception 'Native invoice request identity is required';end if;
 perform public.books_lock_native_adjustment_scope(p_org,p_entity,p_project,p_actor,'prepare','invoice',p_invoice);
 if not exists(select 1 from public.books_project_entity_reviews where org_id=p_org and legal_entity_id=p_entity and project_id=p_project) then raise exception 'Native invoice request project belongs to another entity';end if;
 -- Tuple mutation, not merely a row/advisory lock, fences stale higher-isolation snapshots.
 insert into public.books_native_invoice_request_fences(request_id,generation) values(p_request,1) on conflict(request_id) do update set generation=public.books_native_invoice_request_fences.generation+1;
end $$;
create function public.books_native_invoice_resolution_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare request jsonb;target uuid;
begin
 request:=new.request_text::jsonb;target:=public.books_validate_native_invoice_resolution(request,new.org_id,new.legal_entity_id,new.project_id,new.actor_id);
 if target is distinct from new.request_id or (request->>'entryId')::uuid is distinct from new.entry_id or (request->'economic'->'native'->>'sourceId')::uuid is distinct from new.invoice_id then raise exception 'Native invoice resolution nonce/header/source differs';end if;
 perform public.books_lock_native_invoice_request(new.org_id,new.legal_entity_id,new.project_id,new.actor_id,new.invoice_id,target);
 if exists(select 1 from public.books_native_invoice_postings where id=target) then raise exception 'Original native invoice request already committed; recover its receipt';end if;
 new.request_text:=request::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');new.reason:=btrim(new.reason);new.resolved_at:=clock_timestamp();
 select id into new.resolved_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id order by sequence_no desc limit 1;
 return new;
end $$;
create trigger books_native_invoice_resolution_guard before insert on public.books_native_invoice_request_resolutions for each row execute function public.books_native_invoice_resolution_guard();
create trigger books_native_invoice_resolution_immutable before update or delete on public.books_native_invoice_request_resolutions for each row execute function public.books_entity_immutable();
create function public.books_native_invoice_request_writer_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform public.books_lock_native_invoice_request(new.org_id,new.legal_entity_id,new.project_id,new.posted_by,new.invoice_id,new.id);
 if exists(select 1 from public.books_native_invoice_request_resolutions where request_id=new.id) then raise exception 'Original native invoice request was cancelled; use a new request identity';end if;return new;
end $$;
create trigger zz_books_native_invoice_request_guard before insert on public.books_native_invoice_postings for each row execute function public.books_native_invoice_request_writer_guard();
create function public.resolve_books_native_invoice_request(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,p_request jsonb,p_reason text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare target uuid;previous public.books_native_invoice_request_resolutions;s public.books_native_invoice_postings;e public.books_native_journal_entries;lines jsonb;invoice uuid;
begin
 if p_id is null or length(btrim(coalesce(p_reason,''))) not between 10 and 2000 then raise exception 'Native resolution identity and explanation are required';end if;
 target:=public.books_validate_native_invoice_resolution(p_request,p_org,p_entity,p_project,p_actor);invoice:=(p_request->'economic'->'native'->>'sourceId')::uuid;
 perform public.books_lock_native_invoice_request(p_org,p_entity,p_project,p_actor,invoice,target);
 select * into previous from public.books_native_invoice_request_resolutions where request_id=target;
 if found then
  if(previous.id,previous.org_id,previous.legal_entity_id,previous.project_id,previous.invoice_id,previous.actor_id,previous.entry_id,previous.request_text::jsonb,previous.reason) is distinct from(p_id,p_org,p_entity,p_project,invoice,p_actor,(p_request->>'entryId')::uuid,p_request,btrim(p_reason)) then raise exception 'Native invoice resolution retry differs from retained original decision';end if;
 else
  if exists(select 1 from public.books_native_invoice_request_resolutions where id=p_id) then raise exception 'Native invoice resolution identity already used';end if;
  select * into s from public.books_native_invoice_postings where id=target;
  if found then
   if(s.org_id,s.legal_entity_id,s.project_id,s.invoice_id,s.posted_by,s.entry_id,s.request_text::jsonb,s.notes) is distinct from(p_org,p_entity,p_project,invoice,p_actor,(p_request->>'entryId')::uuid,p_request->'economic',p_request->>'notes') then raise exception 'Committed native invoice posting differs from saved request';end if;
   perform public.books_assert_native_invoice_complete(p_org,p_entity,target);
   select * into e from public.books_native_journal_entries where org_id=p_org and legal_entity_id=p_entity and source_posting_id=target;
   select coalesce(jsonb_agg(to_jsonb(l) order by position),'[]') into lines from public.books_native_journal_lines l where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id;
   return jsonb_build_object('outcome','committed_original','resolution',null,'posting',to_jsonb(s),'entry',to_jsonb(e),'lines',lines,'posted',true,'ledgerActivated',false);
  end if;
  insert into public.books_native_invoice_request_resolutions(id,org_id,legal_entity_id,project_id,invoice_id,actor_id,request_id,entry_id,request_text,request_sha256,reason,resolved_at,resolved_access_event_id)
  values(p_id,p_org,p_entity,p_project,invoice,p_actor,target,(p_request->>'entryId')::uuid,p_request::text,repeat('0',64),btrim(p_reason),clock_timestamp(),p_id) returning * into previous;
 end if;
 return jsonb_build_object('outcome','cancelled','resolution',to_jsonb(previous),'posting',null,'entry',null,'lines','[]'::jsonb,'posted',false,'ledgerActivated',false);
end $$;
create or replace function public.post_books_native_invoice(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,p_entry uuid,p_economic jsonb,p_notes text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare s public.books_native_invoice_postings;e public.books_native_journal_entries;lines jsonb;created boolean:=false;
begin
 perform public.books_lock_native_invoice_request(p_org,p_entity,p_project,p_actor,(p_economic->'native'->>'sourceId')::uuid,p_id);
 if exists(select 1 from public.books_native_invoice_request_resolutions where request_id=p_id) then raise exception 'Original native invoice request was cancelled; use a new request identity';end if;
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;
 if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') then raise exception 'Current native invoice preparation access is required';end if;
 select * into s from public.books_native_invoice_postings where id=p_id;
 if found then
  if(s.org_id,s.legal_entity_id,s.project_id,s.posted_by,s.entry_id,s.request_text::jsonb,s.notes) is distinct from(p_org,p_entity,p_project,p_actor,p_entry,p_economic,btrim(p_notes)) then raise exception 'Native invoice posting retry differs from original request';end if;
 else
  insert into public.books_native_invoice_postings(id,org_id,legal_entity_id,project_id,invoice_id,entry_id,owner_review_id,chart_id,period_id,entry_date,request_text,request_sha256,validated_economic_text,validated_economic_sha256,draft_text,draft_sha256,posted_by,access_event_id,posted_at,notes)
  values(p_id,p_org,p_entity,p_project,(p_economic->'native'->>'sourceId')::uuid,p_entry,p_id,p_id,p_id,current_date,p_economic::text,repeat('0',64),'{}',repeat('0',64),'{}',repeat('0',64),p_actor,p_id,clock_timestamp(),p_notes) returning * into s;
  insert into public.books_native_journal_entries(id,org_id,legal_entity_id,source_posting_id,chart_id,period_id,project_id,entry_date,memo,total_cents,posted_at)
  values(p_entry,p_org,p_entity,p_id,s.chart_id,s.period_id,s.project_id,s.entry_date,'pending',1,clock_timestamp()) returning * into e;
  insert into public.books_native_journal_lines(org_id,legal_entity_id,entry_id,chart_id,project_id,position,account_id,debit_cents,credit_cents,description,company_id,cost_code_id,dimensions)
  select p_org,p_entity,p_entry,s.chart_id,s.project_id,l.position::integer,a.id,(l.body->>'debitCents')::bigint,(l.body->>'creditCents')::bigint,null,null,(l.body->'dimensions'->>'cost_code_id')::uuid,coalesce(l.body->'dimensions','{}'::jsonb)
  from jsonb_array_elements(s.draft_text::jsonb->'lines') with ordinality l(body,position)
  join public.books_entity_accounts a on a.org_id=p_org and a.legal_entity_id=p_entity and a.code=l.body->>'accountCode';created:=true;
 end if;
 perform public.books_assert_native_invoice_complete(p_org,p_entity,p_id);
 select * into e from public.books_native_journal_entries where org_id=p_org and legal_entity_id=p_entity and source_posting_id=p_id;
 select coalesce(jsonb_agg(to_jsonb(l) order by position),'[]') into lines from public.books_native_journal_lines l where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id;
 return jsonb_build_object('posting',to_jsonb(s),'entry',to_jsonb(e),'lines',lines,'created',created,'posted',true,'ledgerActivated',false);
end $$;
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_native_invoice_resolutions;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;rows jsonb;
begin s:=public.capture_books_export_snapshot_before_native_invoice_resolutions(p_org_id);select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into rows from public.books_native_invoice_request_resolutions r where org_id=p_org_id;return jsonb_set(s,'{tables}',s->'tables'||jsonb_build_object('books_native_invoice_request_resolutions',rows));end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions'-'books_project_owner_request_resolutions'-'books_native_period_holds'-'books_native_invoice_request_resolutions'-'books_native_invoice_postings'-'books_native_adjustment_facts'-'books_native_adjustment_reviews'-'books_native_journal_entries'-'books_native_journal_lines'-'books_entity_calendar_years'-'books_entity_fiscal_periods'-'books_entity_calendar_reviews'-'books_entity_chart_versions'-'books_entity_accounts'-'books_entity_account_definitions'-'books_entity_control_accounts'-'books_entity_chart_reviews';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;

do $$declare t text;r record;begin
 foreach t in array array['books_native_invoice_request_fences','books_native_invoice_request_resolutions'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);end loop;
 grant select,insert,update on public.books_native_invoice_request_fences to service_role;
 grant select,insert on public.books_native_invoice_request_resolutions to service_role;
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_validate_native_invoice_resolution','books_lock_native_invoice_request','books_native_invoice_resolution_guard','books_native_invoice_request_writer_guard','resolve_books_native_invoice_request','post_books_native_invoice','capture_books_export_snapshot_before_native_invoice_resolutions') loop execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);end loop;
end $$;
commit;
