-- Pending: exact income-selection outcome resolution, permanent nonce cancellation and schema29 capture.
begin;
create table public.books_native_invoice_income_resolutions(
 id uuid primary key,org_id uuid not null references public.orgs(id),legal_entity_id uuid not null,
 project_id uuid not null,invoice_id uuid not null,actor_id uuid not null references public.app_users(id),
 request_id uuid not null unique,request_text text not null check(octet_length(request_text)<=8400000),
 request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 reason text not null check(length(reason) between 10 and 2000 and reason=btrim(reason)),
 resolved_at timestamptz not null,resolved_access_event_id uuid not null,
 unique(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id) references public.books_legal_entities(org_id,id),
 foreign key(org_id,project_id) references public.projects(org_id,id),foreign key(org_id,invoice_id) references public.invoices(org_id,id),
 foreign key(org_id,legal_entity_id,resolved_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create index books_native_income_resolution_scope on public.books_native_invoice_income_resolutions(org_id,legal_entity_id,project_id,invoice_id);
create index books_native_income_resolution_actor on public.books_native_invoice_income_resolutions(actor_id);
create index books_native_income_resolution_access on public.books_native_invoice_income_resolutions(org_id,legal_entity_id,resolved_access_event_id);
create function public.books_native_invoice_income_resolution_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare q jsonb:=new.request_text::jsonb;target uuid;
begin
 target:=public.books_validate_native_invoice_income_request(q,new.org_id,new.legal_entity_id,new.project_id,new.actor_id);
 if target is distinct from new.request_id or (q->'economic'->'native'->>'sourceId')::uuid is distinct from new.invoice_id then raise exception 'Native income cancellation nonce/source differs';end if;
 if (q->'economic'->'native'->'source'->>'id',q->'economic'->'native'->'source'->>'org_id',q->'economic'->'native'->'source'->>'project_id') is distinct from(new.invoice_id::text,new.org_id::text,new.project_id::text) or jsonb_typeof(q->'economic'->'native'->'capturedAt') is distinct from 'string' or (q->'economic'->'native'->>'capturedAt')::timestamptz>clock_timestamp() then raise exception 'Native income cancellation original source witness differs';end if;
 perform public.books_lock_native_invoice_request(new.org_id,new.legal_entity_id,new.project_id,new.actor_id,new.invoice_id,target);
 if exists(select 1 from public.books_native_invoice_income_selections where id=target) then raise exception 'Original native income request already committed; recover its receipt';end if;
 new.request_text:=q::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');new.resolved_at:=clock_timestamp();
 select id into new.resolved_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id order by sequence_no desc limit 1;
 return new;
end $$;
create trigger books_native_invoice_income_resolution_guard before insert on public.books_native_invoice_income_resolutions for each row execute function public.books_native_invoice_income_resolution_guard();
create trigger books_native_invoice_income_resolution_immutable before update or delete on public.books_native_invoice_income_resolutions for each row execute function public.books_entity_immutable();
create function public.books_native_invoice_income_cancellation_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform public.books_lock_native_invoice_request(new.org_id,new.legal_entity_id,new.project_id,new.actor_id,new.invoice_id,new.id);
 if exists(select 1 from public.books_native_invoice_income_resolutions where request_id=new.id) then raise exception 'Original native income request was cancelled; use a new request identity';end if;
 return new;
end $$;
-- Alphabetically precedes the existing guard that applies source edits.
create trigger aa_books_native_invoice_income_cancellation_guard before insert on public.books_native_invoice_income_selections for each row execute function public.books_native_invoice_income_cancellation_guard();
create function public.resolve_books_native_invoice_income(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,p_request jsonb,p_reason text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare target uuid;invoice uuid;r public.books_native_invoice_income_resolutions;s public.books_native_invoice_income_selections;
begin
 if p_id is null or p_reason is distinct from btrim(p_reason) or length(coalesce(p_reason,'')) not between 10 and 2000 then raise exception 'Canonical native income resolution identity and explanation are required';end if;
 target:=public.books_validate_native_invoice_income_request(p_request,p_org,p_entity,p_project,p_actor);invoice:=(p_request->'economic'->'native'->>'sourceId')::uuid;
 perform public.books_lock_native_invoice_request(p_org,p_entity,p_project,p_actor,invoice,target);
 select * into r from public.books_native_invoice_income_resolutions where request_id=target;
 if found then
  if(r.id,r.org_id,r.legal_entity_id,r.project_id,r.invoice_id,r.actor_id,r.request_text::jsonb,r.reason) is distinct from(p_id,p_org,p_entity,p_project,invoice,p_actor,p_request,p_reason) then raise exception 'Native income resolution retry differs from retained original decision';end if;
 else
  if exists(select 1 from public.books_native_invoice_income_resolutions where id=p_id) then raise exception 'Native income resolution identity already used';end if;
  select * into s from public.books_native_invoice_income_selections where id=target;
  if found then
   if(s.org_id,s.legal_entity_id,s.project_id,s.invoice_id,s.actor_id,s.request_text::jsonb) is distinct from(p_org,p_entity,p_project,invoice,p_actor,p_request) then raise exception 'Committed native income selection differs from saved request';end if;
   return jsonb_build_object('outcome','committed_original','resolution',null,'selection',to_jsonb(s),'coded',true,'posted',false,'ledgerActivated',false);
  end if;
  insert into public.books_native_invoice_income_resolutions(id,org_id,legal_entity_id,project_id,invoice_id,actor_id,request_id,request_text,request_sha256,reason,resolved_at,resolved_access_event_id)
  values(p_id,p_org,p_entity,p_project,invoice,p_actor,target,p_request::text,repeat('0',64),p_reason,clock_timestamp(),p_id) returning * into r;
 end if;
 return jsonb_build_object('outcome','cancelled','resolution',to_jsonb(r),'selection',null,'coded',false,'posted',false,'ledgerActivated',false);
end $$;
alter table public.books_native_invoice_income_resolutions enable row level security;
revoke all on public.books_native_invoice_income_resolutions from public,anon,authenticated,service_role;
grant select,insert on public.books_native_invoice_income_resolutions to service_role;
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_native_income_resolutions;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;rows jsonb;
begin s:=public.capture_books_export_snapshot_before_native_income_resolutions(p_org_id);select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into rows from public.books_native_invoice_income_resolutions r where org_id=p_org_id;return jsonb_set(s,'{tables}',s->'tables'||jsonb_build_object('books_native_invoice_income_resolutions',rows));end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions'-'books_project_owner_request_resolutions'-'books_native_period_holds'-'books_native_invoice_income_selections'-'books_native_invoice_income_resolutions'-'books_native_invoice_request_resolutions'-'books_native_invoice_postings'-'books_native_adjustment_facts'-'books_native_adjustment_reviews'-'books_native_journal_entries'-'books_native_journal_lines'-'books_entity_calendar_years'-'books_entity_fiscal_periods'-'books_entity_calendar_reviews'-'books_entity_chart_versions'-'books_entity_accounts'-'books_entity_account_definitions'-'books_entity_control_accounts'-'books_entity_chart_reviews';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;

do $$declare r record;begin
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_native_invoice_income_resolution_guard','books_native_invoice_income_cancellation_guard','resolve_books_native_invoice_income','capture_books_export_snapshot_before_native_income_resolutions') loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
