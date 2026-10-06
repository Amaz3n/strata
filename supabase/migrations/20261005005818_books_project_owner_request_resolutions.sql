-- Pending migration: immutable cancellation receipts, never ownership activation.
-- Operational generation tuples force stale higher-isolation writers to fail.
begin;
create table public.books_project_owner_request_fences(
 kind text not null check(kind in('prepare','review')),request_id uuid not null,
 generation bigint not null check(generation>0),primary key(kind,request_id)
);
create table public.books_project_owner_request_resolutions(
 id uuid primary key,org_id uuid not null references public.orgs(id),
 legal_entity_id uuid not null,project_id uuid not null,actor_id uuid not null references public.app_users(id),
 kind text not null check(kind in('prepare','review')),request_id uuid not null,
 request_text text not null check(octet_length(request_text)<=65536),
 request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 reason text not null check(length(reason) between 10 and 2000 and reason=btrim(reason)),
 resolved_at timestamptz not null,resolved_access_event_id uuid not null,
 observed_proposal_id uuid,unique(kind,request_id),unique(org_id,id),
 foreign key(org_id,legal_entity_id) references public.books_legal_entities(org_id,id),
 foreign key(org_id,project_id) references public.projects(org_id,id),
 foreign key(org_id,legal_entity_id,resolved_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,project_id,observed_proposal_id) references public.books_project_entity_proposals(org_id,legal_entity_id,project_id,id)
);
create index books_project_owner_resolution_scope on public.books_project_owner_request_resolutions(org_id,project_id,legal_entity_id);
create index books_project_owner_resolution_entity on public.books_project_owner_request_resolutions(org_id,legal_entity_id);
create index books_project_owner_resolution_actor on public.books_project_owner_request_resolutions(actor_id);
create index books_project_owner_resolution_authority on public.books_project_owner_request_resolutions(org_id,legal_entity_id,resolved_access_event_id);
create index books_project_owner_resolution_observed on public.books_project_owner_request_resolutions(org_id,legal_entity_id,project_id,observed_proposal_id);
create function public.books_validate_project_owner_request(p_kind text,p_request jsonb,p_org uuid,p_entity uuid,p_project uuid,p_actor uuid)
returns uuid language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare key text;v text;allowed text[];e jsonb;d date;
begin
 if p_kind is null or p_kind not in('prepare','review') or p_request is null or jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>65536 then raise exception 'Canonical ownership resolution request is required';end if;
 allowed:=array['expectedOrgId','expectedActorId','entityId','projectId','id','notes'];
 if p_kind='prepare' then allowed:=allowed||array['profileId','effectiveOn','evidence'];else allowed:=allowed||array['proposalId'];end if;
 if p_request-allowed<>'{}' or (select count(*) from jsonb_object_keys(p_request))<>cardinality(allowed) then raise exception 'Ownership resolution request shape differs';end if;
 foreach key in array array['expectedOrgId','expectedActorId','entityId','projectId','id',case when p_kind='prepare' then 'profileId' else 'proposalId' end] loop
  v:=p_request->>key;
  if jsonb_typeof(p_request->key) is distinct from 'string' or v::uuid::text is distinct from v then raise exception 'Canonical ownership request UUID is required';end if;
 end loop;
 if (p_request->>'expectedOrgId',p_request->>'expectedActorId',p_request->>'entityId',p_request->>'projectId') is distinct from(p_org::text,p_actor::text,p_entity::text,p_project::text) then raise exception 'Ownership resolution request belongs to another scope or actor';end if;
 v:=p_request->>'notes';
 if jsonb_typeof(p_request->'notes') is distinct from 'string' or v is distinct from btrim(v) or length(v) not between 10 and 2000 then raise exception 'Canonical ownership request notes are required';end if;
 if p_kind='prepare' then
  v:=p_request->>'effectiveOn';d:=v::date;
  if jsonb_typeof(p_request->'effectiveOn') is distinct from 'string' or to_char(d,'YYYY-MM-DD') is distinct from v or d<date '1900-01-01' or d>date '9997-12-31' then raise exception 'Canonical ownership date is required';end if;
  e:=p_request->'evidence';
  if jsonb_typeof(e) is distinct from 'object' or e-array['single_entity_project_confirmed','rationale','document_version_ids']<>'{}' or (select count(*) from jsonb_object_keys(e))<>3 or e->'single_entity_project_confirmed' is distinct from 'true'::jsonb or jsonb_typeof(e->'rationale') is distinct from 'string' or length(e->>'rationale') not between 10 and 2000 or e->>'rationale' is distinct from btrim(e->>'rationale') or jsonb_typeof(e->'document_version_ids') is distinct from 'array' then raise exception 'Canonical ownership decision is required';end if;
  if jsonb_array_length(e->'document_version_ids') not between 1 and 50 or (select count(distinct x) from jsonb_array_elements(e->'document_version_ids') x)<>jsonb_array_length(e->'document_version_ids') then raise exception 'Distinct ownership documents are required';end if;
  for e in select value from jsonb_array_elements(e->'document_version_ids') loop
   if jsonb_typeof(e) is distinct from 'string' or (e#>>'{}')::uuid::text is distinct from e#>>'{}' then raise exception 'Canonical ownership document identity is required';end if;
  end loop;
 end if;
 return (p_request->>'id')::uuid;
end $$;
create function public.books_lock_project_owner_request(p_kind text,p_id uuid)
returns void language sql volatile security invoker set search_path=pg_catalog,public as $$
 insert into public.books_project_owner_request_fences(kind,request_id,generation) values(p_kind,p_id,1)
 on conflict(kind,request_id) do update set generation=public.books_project_owner_request_fences.generation+1;
$$;
create function public.books_lock_project_owner_operation(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_kind text,p_id uuid)
returns void language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
begin
 -- Match the normal writer: entity -> active membership -> project -> nonce.
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;
 if not found or p_kind is null or p_kind not in('prepare','review') or not public.books_entity_has_access(p_org,p_entity,p_actor,p_kind) then raise exception '%',case when p_kind='prepare' then 'Project entity preparation access is required' else 'Project entity review access is required' end;end if;
 perform 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active' for share;
 if not found then raise exception 'Active project ownership membership is required';end if;
 perform 1 from public.projects where org_id=p_org and id=p_project for update;
 if not found then raise exception 'Project is unavailable in organization';end if;
 perform public.books_lock_project_owner_request(p_kind,p_id);
end $$;
create function public.books_project_owner_resolution_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare request jsonb;target uuid;
begin
 request:=new.request_text::jsonb;
 target:=public.books_validate_project_owner_request(new.kind,request,new.org_id,new.legal_entity_id,new.project_id,new.actor_id);
 if target is distinct from new.request_id then raise exception 'Resolution request nonce differs';end if;
 perform public.books_lock_project_owner_operation(new.org_id,new.legal_entity_id,new.project_id,new.actor_id,new.kind,target);
 if (new.kind='prepare' and exists(select 1 from public.books_project_entity_proposals where id=target)) or (new.kind='review' and exists(select 1 from public.books_project_entity_reviews where id=target)) then raise exception 'Original ownership request already committed; recover its receipt';end if;
 new.request_text:=request::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');
 new.observed_proposal_id:=null;
 if new.kind='review' then select id into new.observed_proposal_id from public.books_project_entity_proposals where org_id=new.org_id and legal_entity_id=new.legal_entity_id and project_id=new.project_id and id=(request->>'proposalId')::uuid;end if;
 new.reason:=btrim(new.reason);new.resolved_at:=clock_timestamp();
 select id into new.resolved_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id order by sequence_no desc limit 1;
 return new;
end $$;
create trigger books_project_owner_resolution_guard before insert on public.books_project_owner_request_resolutions for each row execute function public.books_project_owner_resolution_guard();
create trigger books_project_owner_resolution_immutable before update or delete on public.books_project_owner_request_resolutions for each row execute function public.books_entity_immutable();
create function public.books_project_owner_request_writer_fence()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare request_kind text;
begin
 request_kind:=case when tg_table_name='books_project_entity_proposals' then 'prepare' else 'review' end;
 -- Existing guards run first and take the entity/project locks in that order.
 perform public.books_lock_project_owner_request(request_kind,new.id);
 if exists(select 1 from public.books_project_owner_request_resolutions where request_id=new.id and books_project_owner_request_resolutions.kind=request_kind) then raise exception 'Original ownership request was cancelled; use a new request identity';end if;
 return new;
end $$;
create trigger zz_books_project_owner_request_fence before insert on public.books_project_entity_proposals for each row execute function public.books_project_owner_request_writer_fence();
create trigger zz_books_project_owner_request_fence before insert on public.books_project_entity_reviews for each row execute function public.books_project_owner_request_writer_fence();
create function public.resolve_books_project_owner_request(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,p_kind text,p_request jsonb,p_reason text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare target uuid;previous public.books_project_owner_request_resolutions;p public.books_project_entity_proposals;r public.books_project_entity_reviews;
begin
 if p_id is null or length(btrim(coalesce(p_reason,''))) not between 10 and 2000 then raise exception 'Resolution identity and explanation are required';end if;
 target:=public.books_validate_project_owner_request(p_kind,p_request,p_org,p_entity,p_project,p_actor);
 perform public.books_lock_project_owner_operation(p_org,p_entity,p_project,p_actor,p_kind,target);
 select * into previous from public.books_project_owner_request_resolutions where kind=p_kind and request_id=target;
 if found then
  if (previous.id,previous.org_id,previous.legal_entity_id,previous.project_id,previous.actor_id,previous.request_text::jsonb,previous.reason) is distinct from(p_id,p_org,p_entity,p_project,p_actor,p_request,btrim(p_reason)) then raise exception 'Resolution retry differs from retained original decision';end if;
 else
  if exists(select 1 from public.books_project_owner_request_resolutions where id=p_id) then raise exception 'Resolution identity already used';end if;
  if p_kind='prepare' then
   select * into p from public.books_project_entity_proposals where id=target;
   if found then
    if (p.org_id,p.legal_entity_id,p.project_id,p.prepared_by,p.profile_id,p.effective_on,p.decision_evidence,p.preparation_notes) is distinct from(p_org,p_entity,p_project,p_actor,(p_request->>'profileId')::uuid,(p_request->>'effectiveOn')::date,p_request->'evidence',p_request->>'notes') then raise exception 'Committed ownership preparation differs from saved request';end if;
    return jsonb_build_object('outcome','committed_original','proposal',to_jsonb(p),'review',null,'resolution',null,'ledgerActivated',false);
   end if;
  else
   select * into r from public.books_project_entity_reviews where id=target;
   if found then
    if (r.org_id,r.legal_entity_id,r.project_id,r.reviewed_by,r.proposal_id,r.review_notes) is distinct from(p_org,p_entity,p_project,p_actor,(p_request->>'proposalId')::uuid,p_request->>'notes') then raise exception 'Committed ownership review differs from saved request';end if;
    return jsonb_build_object('outcome','committed_original','proposal',null,'review',to_jsonb(r),'resolution',null,'ledgerActivated',false);
   end if;
  end if;
  insert into public.books_project_owner_request_resolutions(id,org_id,legal_entity_id,project_id,actor_id,kind,request_id,request_text,request_sha256,reason,resolved_at,resolved_access_event_id)
  values(p_id,p_org,p_entity,p_project,p_actor,p_kind,target,p_request::text,repeat('0',64),btrim(p_reason),clock_timestamp(),p_id) returning * into previous;
 end if;
 return jsonb_build_object('outcome','cancelled','proposal',null,'review',null,'resolution',to_jsonb(previous),'ledgerActivated',false);
end $$;
create or replace function public.prepare_books_project_entity(p_org uuid,p_entity uuid,p_project uuid,p_id uuid,p_profile uuid,p_actor uuid,p_effective date,p_decision jsonb,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_project_entity_proposals;
begin
 perform public.books_lock_project_owner_operation(p_org,p_entity,p_project,p_actor,'prepare',p_id);
 if exists(select 1 from public.books_project_owner_request_resolutions where kind='prepare' and request_id=p_id) then raise exception 'Original ownership request was cancelled; use a new request identity';end if;
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') then raise exception 'Project entity preparation access is required';end if;
 select * into p from public.books_project_entity_proposals where id=p_id;
 if found then if(p.org_id,p.legal_entity_id,p.project_id,p.profile_id,p.prepared_by,p.effective_on,p.decision_evidence,p.preparation_notes) is distinct from(p_org,p_entity,p_project,p_profile,p_actor,p_effective,p_decision,btrim(p_notes)) then raise exception 'Project ownership retry differs from original preparation';end if;
 else insert into public.books_project_entity_proposals(id,org_id,project_id,legal_entity_id,profile_id,effective_on,project_name,decision_evidence,documents,prepared_by,prepared_at,prepared_access_event_id,preparation_notes) values(p_id,p_org,p_project,p_entity,p_profile,p_effective,'pending',p_decision,'[]',p_actor,clock_timestamp(),p_id,p_notes) returning * into p;end if;
 return jsonb_build_object('proposal',to_jsonb(p),'ledgerActivated',false);
end $$;

create or replace function public.review_books_project_entity(p_org uuid,p_entity uuid,p_project uuid,p_proposal uuid,p_id uuid,p_actor uuid,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.books_project_entity_reviews;
begin
 perform public.books_lock_project_owner_operation(p_org,p_entity,p_project,p_actor,'review',p_id);
 if exists(select 1 from public.books_project_owner_request_resolutions where kind='review' and request_id=p_id) then raise exception 'Original ownership request was cancelled; use a new request identity';end if;
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'review') then raise exception 'Project entity review access is required';end if;
 select * into r from public.books_project_entity_reviews where org_id=p_org and project_id=p_project;
 if found then if(r.id,r.legal_entity_id,r.proposal_id,r.reviewed_by,r.review_notes) is distinct from(p_id,p_entity,p_proposal,p_actor,btrim(p_notes)) then raise exception 'Project ownership retry differs from original reviewed owner';end if;
 else insert into public.books_project_entity_reviews(id,org_id,project_id,legal_entity_id,proposal_id,reviewed_by,reviewed_at,reviewed_access_event_id,review_notes) values(p_id,p_org,p_project,p_entity,p_proposal,p_actor,clock_timestamp(),p_id,p_notes) returning * into r;end if;
 return jsonb_build_object('review',to_jsonb(r),'sourceOwnerEstablished',true,'ledgerActivated',false);
end $$;

alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_project_owner_resolutions;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;rows jsonb;
begin
 snapshot:=public.capture_books_export_snapshot_before_project_owner_resolutions(p_org_id);
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') into rows from public.books_project_owner_request_resolutions r where org_id=p_org_id;
 return jsonb_set(snapshot,'{tables,books_project_owner_request_resolutions}',rows);
end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions'-'books_project_owner_request_resolutions'-'books_entity_calendar_years'-'books_entity_fiscal_periods'-'books_entity_calendar_reviews'-'books_entity_chart_versions'-'books_entity_accounts'-'books_entity_account_definitions'-'books_entity_control_accounts'-'books_entity_chart_reviews';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;
do $$declare t text;r record;begin
 foreach t in array array['books_project_owner_request_fences','books_project_owner_request_resolutions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_validate_project_owner_request','books_lock_project_owner_request','books_lock_project_owner_operation','books_project_owner_resolution_guard','books_project_owner_request_writer_fence','resolve_books_project_owner_request','prepare_books_project_entity','review_books_project_entity','capture_books_export_snapshot','capture_books_export_snapshot_before_project_owner_resolutions','capture_books_legacy_ownership_evidence') loop
  execute format('revoke all on function %s from public,anon,authenticated',r.signature);
  execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
