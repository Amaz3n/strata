-- Append-only recovery decisions. Cancellation fences use the same lock as the
-- original writer, so an absent receipt cannot subsequently arrive unnoticed.
begin;
alter table public.books_journal_proposals add constraint books_journal_proposal_org_identity unique(org_id,id);
create table public.books_journal_request_resolutions(
 id uuid primary key,org_id uuid not null references public.orgs(id),actor_id uuid not null references public.app_users(id),
 kind text not null check(kind in('prepare','review')),request_key text not null,
 request_text text not null check(octet_length(request_text)<=4194304),request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 resolution text not null check(resolution in('cancelled_preparation','cancelled_review','acknowledged_original_review','acknowledged_superseded_review')),
 observed_proposal_id uuid,observed_review jsonb,reason text not null check(length(btrim(reason)) between 4 and 1000),resolved_at timestamptz not null,
 unique(org_id,actor_id,kind,request_key),unique(org_id,id),
 foreign key(org_id,observed_proposal_id) references public.books_journal_proposals(org_id,id)
);
-- The existing proposal key is organization-wide; its receipt identity also
-- needs a composite reference for a retained recovery observation.
-- Operational coordination only: generations carry no accounting meaning and
-- can be rebuilt after restore. Updating a common tuple makes a stale higher-
-- isolation writer serialize/fail instead of reading an old cancellation view.
create table public.books_journal_request_fences(
 org_id uuid not null references public.orgs(id),actor_id uuid not null references public.app_users(id),kind text not null check(kind in('prepare','review')),request_key text not null,generation bigint not null check(generation>0),primary key(org_id,actor_id,kind,request_key)
);
alter table public.books_journal_request_fences enable row level security;
revoke all on table public.books_journal_request_fences from public,anon,authenticated;
grant all on table public.books_journal_request_fences to service_role;
create function public.books_lock_journal_request_fence(p_org uuid,p_actor uuid,p_kind text,p_key text)
returns void language sql volatile security invoker set search_path=pg_catalog,public as $$
 insert into public.books_journal_request_fences(org_id,actor_id,kind,request_key,generation) values(p_org,p_actor,p_kind,p_key,1) on conflict(org_id,actor_id,kind,request_key) do update set generation=public.books_journal_request_fences.generation+1;
$$;
revoke all on function public.books_lock_journal_request_fence(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.books_lock_journal_request_fence(uuid,uuid,text,text) to service_role;
create function public.books_journal_review_request_sha(p_org uuid,p_actor uuid,p_proposal uuid,p_decision text,p_note text)
returns text language sql immutable security invoker set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(jsonb_build_object('expectedOrgId',p_org,'expectedActorId',p_actor,'proposalId',p_proposal,'decision',p_decision,'note',btrim(coalesce(p_note,'')))::text,'UTF8')),'hex');
$$;
create function public.books_journal_resolution_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r jsonb;target uuid;p public.books_journal_proposals;wanted text;
begin
 r:=new.request_text::jsonb;
 if jsonb_typeof(r) is distinct from 'object' or r->>'expectedOrgId' is distinct from new.org_id::text or r->>'expectedActorId' is distinct from new.actor_id::text then raise exception 'Resolution request belongs to another organization or actor';end if;
 perform 1 from public.memberships where org_id=new.org_id and user_id=new.actor_id and status='active' for share;
 if not found then raise exception 'Active resolution actor membership is required';end if;
 new.request_text:=r::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');
 new.observed_proposal_id:=null;new.observed_review:=null;
 if new.kind='prepare' then
  target:=(r->>'intentId')::uuid;
  if target is null or target::text is distinct from r->>'intentId' then raise exception 'Canonical preparation intent is required';end if;
  new.request_key:=target::text;
  perform pg_advisory_xact_lock(hashtextextended('books-journal-preparation:'||new.org_id::text||':'||target::text,0));
  perform public.books_lock_journal_request_fence(new.org_id,new.actor_id,'prepare',new.request_key);
  if exists(select 1 from public.books_journal_proposals where org_id=new.org_id and posting_key='adjustment-intent:'||target::text) then raise exception 'Original preparation already committed; recover its receipt';end if;
  new.resolution:='cancelled_preparation';
 elsif new.kind='review' then
  target:=(r->>'proposalId')::uuid;
  if target is null or target::text is distinct from r->>'proposalId' or r-array['expectedOrgId','expectedActorId','proposalId','decision','note']<>'{}' or r->>'decision' is null or r->>'decision' not in('approve','reject') or jsonb_typeof(r->'note') is distinct from 'string' or r->>'note' is distinct from btrim(r->>'note') or new.request_sha256 is distinct from public.books_journal_review_request_sha(new.org_id,new.actor_id,target,r->>'decision',r->>'note') then raise exception 'Canonical independent review request is required';end if;
  new.request_key:=target::text||':'||new.request_sha256;
  -- Serialize two absent-row cancellations as well as a concurrent review of
  -- an existing row. The normal writer itself locks that same proposal row.
  perform pg_advisory_xact_lock(hashtextextended('books-journal-review-resolution:'||new.org_id::text||':'||target::text,0));
  perform public.books_lock_journal_request_fence(new.org_id,new.actor_id,'review',new.request_key);
  select * into p from public.books_journal_proposals where org_id=new.org_id and id=target for update;
  new.observed_proposal_id:=p.id;
  if p.id is null or p.status='pending' then new.resolution:='cancelled_review';
  else
   perform public.books_validate_proposal_receipt(p);
   wanted:=case when r->>'decision'='approve' then 'posted' else 'rejected' end;
   new.resolution:=case when p.status=wanted and p.reviewed_by=new.actor_id and btrim(coalesce(p.review_note,''))=r->>'note' then 'acknowledged_original_review' else 'acknowledged_superseded_review' end;
   new.observed_review:=jsonb_build_object('status',p.status,'reviewedBy',p.reviewed_by,'reviewedAt',p.reviewed_at,'note',p.review_note,'journalEntryId',p.journal_entry_id,'reversalEntryId',p.reversal_entry_id);
  end if;
 else raise exception 'Unknown journal recovery kind';end if;
 new.reason:=btrim(new.reason);new.resolved_at:=clock_timestamp();return new;
end;
$$;
create trigger books_journal_resolution_guard before insert on public.books_journal_request_resolutions for each row execute function public.books_journal_resolution_guard();
create trigger books_journal_resolutions_immutable before update or delete on public.books_journal_request_resolutions for each row execute function public.books_reject_mutation();
create function public.books_journal_resolution_writer_fence()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare intent uuid;signature text;
begin
 if tg_op='INSERT' and new.posting_key like 'adjustment-intent:%' then
  intent:=substring(new.posting_key from length('adjustment-intent:')+1)::uuid;
  perform pg_advisory_xact_lock(hashtextextended('books-journal-preparation:'||new.org_id::text||':'||intent::text,0));
  perform public.books_lock_journal_request_fence(new.org_id,new.proposed_by,'prepare',intent::text);
  if exists(select 1 from public.books_journal_request_resolutions where org_id=new.org_id and actor_id=new.proposed_by and kind='prepare' and request_key=intent::text and resolution='cancelled_preparation') then raise exception 'Original journal preparation was cancelled; use a new intent';end if;
 elsif tg_op='UPDATE' and old.status='pending' and new.status in('posted','rejected') then
  signature:=public.books_journal_review_request_sha(new.org_id,new.reviewed_by,new.id,case when new.status='posted' then 'approve' else 'reject' end,new.review_note);
  perform public.books_lock_journal_request_fence(new.org_id,new.reviewed_by,'review',new.id::text||':'||signature);
  if exists(select 1 from public.books_journal_request_resolutions where org_id=new.org_id and actor_id=new.reviewed_by and kind='review' and request_key=new.id::text||':'||signature and resolution='cancelled_review') then raise exception 'Original independent journal review was cancelled; submit a new review intent';end if;
 end if;
 return new;
end;
$$;
create trigger books_journal_resolution_writer_fence before insert or update on public.books_journal_proposals for each row execute function public.books_journal_resolution_writer_fence();
create function public.resolve_books_journal_request_atomic(p_org uuid,p_actor uuid,p_id uuid,p_kind text,p_request jsonb,p_reason text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_journal_request_resolutions;key text;signature text;created boolean:=false;
begin
 if p_id is null or p_request is null or jsonb_typeof(p_request) is distinct from 'object' or length(btrim(coalesce(p_reason,''))) not between 4 and 1000 then raise exception 'Resolution identity, original request and explanation are required';end if;
 perform 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active' for share;
 if not found then raise exception 'Active resolution actor membership is required';end if;
 signature:=encode(sha256(convert_to(p_request::text,'UTF8')),'hex');
 if p_kind='prepare' then key:=(p_request->>'intentId')::uuid::text;
 elsif p_kind='review' then key:=(p_request->>'proposalId')::uuid::text||':'||signature;
 else raise exception 'Unknown journal recovery kind';end if;
 perform pg_advisory_xact_lock(hashtextextended('books-journal-resolution-receipt:'||p_org::text||':'||p_actor::text||':'||p_kind||':'||key,0));
 select * into previous from public.books_journal_request_resolutions where org_id=p_org and actor_id=p_actor and kind=p_kind and request_key=key for update;
 if previous.id is not null then
  if previous.id is distinct from p_id or previous.request_text::jsonb is distinct from p_request or previous.reason is distinct from btrim(p_reason) then raise exception 'Resolution retry differs from retained decision';end if;
 else
  insert into public.books_journal_request_resolutions(id,org_id,actor_id,kind,request_key,request_text,request_sha256,resolution,reason,resolved_at) values(p_id,p_org,p_actor,p_kind,key,p_request::text,signature,'cancelled_review',btrim(p_reason),clock_timestamp()) returning * into previous;
  created:=true;
 end if;
 return jsonb_build_object('orgId',previous.org_id,'actorId',previous.actor_id,'id',previous.id,'kind',previous.kind,'requestText',previous.request_text,'requestSha256',previous.request_sha256,'resolution',previous.resolution,'observedProposalId',previous.observed_proposal_id,'observedReview',previous.observed_review,'created',created);
end;
$$;
alter table public.books_journal_request_resolutions enable row level security;
revoke all on table public.books_journal_request_resolutions from public,anon,authenticated;
grant all on table public.books_journal_request_resolutions to service_role;
revoke all on function public.books_journal_review_request_sha(uuid,uuid,uuid,text,text),public.books_journal_resolution_guard(),public.books_journal_resolution_writer_fence(),public.resolve_books_journal_request_atomic(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.books_journal_review_request_sha(uuid,uuid,uuid,text,text),public.books_journal_resolution_guard(),public.books_journal_resolution_writer_fence(),public.resolve_books_journal_request_atomic(uuid,uuid,uuid,text,jsonb,text) to service_role;
create or replace function public.review_books_journal_proposal_atomic(p_org_id uuid,p_proposal_id uuid,p_reviewer_id uuid,p_decision text,p_note text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_journal_proposals; j uuid; r uuid; created boolean:=false; note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
 if p_decision is null or p_decision not in('approve','reject') or length(coalesce(note,''))>1000 then raise exception 'Invalid review decision or note';end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_reviewer_id and status='active' for share;
 if not found then raise exception 'Active reviewer membership is required';end if;
 perform public.books_lock_journal_request_fence(p_org_id,p_reviewer_id,'review',p_proposal_id::text||':'||public.books_journal_review_request_sha(p_org_id,p_reviewer_id,p_proposal_id,p_decision,p_note));
 select * into p from public.books_journal_proposals where org_id=p_org_id and id=p_proposal_id for update;
 if not found then raise exception 'Journal proposal not found';end if;
 if p.proposed_by=p_reviewer_id then raise exception 'The proposal maker cannot review their own entry';end if;
 if p.status<>'pending' then
  if p.status is distinct from (case when p_decision='approve' then 'posted' else 'rejected' end) or p.reviewed_by is distinct from p_reviewer_id or nullif(btrim(coalesce(p.review_note,'')),'') is distinct from note then raise exception 'Review retry differs from retained approval or rejection';end if;
  perform public.books_validate_proposal_receipt(p);
 else
  if p_decision='reject' then
   if length(coalesce(note,''))<4 then raise exception 'A rejection note is required';end if;
  else
   perform 1 from public.memberships where org_id=p_org_id and user_id=p.proposed_by and status='active' for share;
   if not found then raise exception 'Active maker membership is required for new approval';end if;
   perform 1 from public.gl_accounts a where org_id=p_org_id and a.id in(select l.account_id from jsonb_to_recordset(p.lines) l(account_id uuid)) for share;
   if exists(select 1 from jsonb_to_recordset(p.lines) l(account_id uuid) where not exists(select 1 from public.gl_accounts a where a.org_id=p_org_id and a.id=l.account_id and a.active)) then raise exception 'New approval accounts must be active and scoped';end if;
   if exists(select 1 from public.journal_entries where org_id=p_org_id and posting_key=p.posting_key) then raise exception 'Pending proposal posting key is already occupied; reviewed recovery is required';end if;
   j:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p.entry_date,'entry_kind','adjusting','memo',p.memo,'posting_key',p.posting_key,'projection_version',1,'policy_version',p.policy_version,'created_by',p.proposed_by),p.lines);
   if p.reversing_on is not null then
    r:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p.reversing_on,'entry_kind','reversal','memo','Automatic reversal: '||p.memo,'posting_key','scheduled_reversal:'||j::text||':'||p.reversing_on::text,'projection_version',1,'policy_version',p.policy_version,'reversal_of_entry_id',j,'created_by',p.proposed_by),(select jsonb_agg(item||jsonb_build_object('debit_cents',item->'credit_cents','credit_cents',item->'debit_cents') order by(item->>'line_no')::integer) from jsonb_array_elements(p.lines) item));
   end if;
  end if;
  update public.books_journal_proposals set status=case when p_decision='approve' then 'posted' else 'rejected' end,reviewed_by=p_reviewer_id,reviewed_at=now(),review_note=note,journal_entry_id=j,reversal_entry_id=r where id=p.id returning * into p;
  created:=true;
 end if;
 return jsonb_build_object('orgId',p.org_id,'proposalId',p.id,'reviewerId',p.reviewed_by,'status',p.status,'journal_entry_id',p.journal_entry_id,'reversal_entry_id',p.reversal_entry_id,'created',created);
end;
$$;
-- Keep the complete export capture in one stable database snapshot. Recovery
-- decisions are not source ownership changes and do not invalidate historical
-- legacy-entity ownership populations merely by recording acknowledgement.
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_journal_resolutions;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;rows jsonb;
begin
 snapshot:=public.capture_books_export_snapshot_before_journal_resolutions(p_org_id);
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') into rows from public.books_journal_request_resolutions r where org_id=p_org_id;
 return jsonb_set(snapshot,'{tables,books_journal_request_resolutions}',rows);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;
commit;
