-- Pending: separate immutable review of explicit replacement proposals.
-- Approval is a retained decision only; no ledger or source transition here.
begin;
create table public.books_native_invoice_correction_reviews(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,project_id uuid not null,
 proposal_id uuid not null unique,
 decision text not null check(decision in('approve','reject')),
 request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 derivation_sha256 text not null check(derivation_sha256 ~ '^[a-f0-9]{64}$'),
 reviewer_context_text text not null check(octet_length(reviewer_context_text)<=4194304),reviewer_context_sha256 text not null check(reviewer_context_sha256 ~ '^[a-f0-9]{64}$'),
 rechecked_derivation_text text check(octet_length(rechecked_derivation_text)<=84000000),rechecked_derivation_sha256 text check(rechecked_derivation_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_by uuid not null references public.app_users(id),reviewed_access_event_id uuid not null,reviewed_at timestamptz not null,
 notes text not null check(length(notes) between 10 and 2000 and notes=btrim(notes)),
 unique(org_id,legal_entity_id,id),
 foreign key(org_id,project_id) references public.projects(org_id,id),
 foreign key(org_id,legal_entity_id,proposal_id) references public.books_native_invoice_correction_proposals(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,reviewed_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id),
 check((decision='approve' and rechecked_derivation_text is not null and rechecked_derivation_sha256 is not null) or(decision='reject' and rechecked_derivation_text is null and rechecked_derivation_sha256 is null))
);
create function public.books_native_invoice_correction_review_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare p public.books_native_invoice_correction_proposals;q jsonb;c jsonb;d jsonb;
begin
 select * into p from public.books_native_invoice_correction_proposals where org_id=new.org_id and legal_entity_id=new.legal_entity_id and project_id=new.project_id and id=new.proposal_id;
 if p.id is null or new.reviewed_by=p.prepared_by then raise exception 'Original scoped proposal and independent correction reviewer are required';end if;
 if new.decision not in('approve','reject') or new.notes is null or length(new.notes) not between 10 and 2000 or new.notes<>btrim(new.notes) then raise exception 'Explicit correction decision and explanation are required';end if;
 if (new.request_sha256,new.derivation_sha256) is distinct from(p.request_sha256,p.derivation_sha256) or encode(sha256(convert_to(p.request_text,'UTF8')),'hex') is distinct from p.request_sha256 or encode(sha256(convert_to(p.derivation_text,'UTF8')),'hex') is distinct from p.derivation_sha256 then raise exception 'Correction review differs from exact saved proposal';end if;
 q:=p.request_text::jsonb;
 if q->'protocolVersion' is distinct from '2'::jsonb or q->>'intent' is distinct from 'replace' then raise exception 'Review requires explicit replacement intent; original reversal preparation is not a void authorization';end if;
 perform public.books_lock_native_adjustment_scope(new.org_id,new.legal_entity_id,new.project_id,new.reviewed_by,'review','invoice',p.invoice_id);
 c:=public.read_books_native_project_posting_context(new.org_id,new.project_id,'invoice',p.invoice_id,new.reviewed_by,p.entry_date,'review');
 new.reviewer_context_text:=c::text;new.reviewer_context_sha256:=encode(sha256(convert_to(new.reviewer_context_text,'UTF8')),'hex');
 new.rechecked_derivation_text:=null;new.rechecked_derivation_sha256:=null;
 if new.decision='approve' then
  d:=public.books_derive_native_invoice_correction_pair(new.org_id,new.legal_entity_id,new.project_id,p.prepared_by,p.id,p.original_posting_id,q->'baseEconomic',q->'patch',q->>'notes');
  if d->'reversal'->'draft' is distinct from p.derivation_text::jsonb->'reversal'->'draft' or d->'replacementDraft' is distinct from p.derivation_text::jsonb->'replacementDraft' or d->'patch' is distinct from q->'patch' then raise exception 'Correction review economics differ from saved complete pair';end if;
  new.rechecked_derivation_text:=d::text;new.rechecked_derivation_sha256:=encode(sha256(convert_to(new.rechecked_derivation_text,'UTF8')),'hex');
 end if;
 select id into new.reviewed_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.reviewed_by order by sequence_no desc limit 1;
 new.reviewed_at:=clock_timestamp();return new;
end $$;
create trigger books_native_invoice_correction_review_guard before insert on public.books_native_invoice_correction_reviews for each row execute function public.books_native_invoice_correction_review_guard();
create trigger books_native_invoice_correction_review_immutable before update or delete on public.books_native_invoice_correction_reviews for each row execute function public.books_entity_immutable();
create function public.review_books_native_invoice_correction(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,p_proposal uuid,p_decision text,p_notes text,p_request_sha text,p_derivation_sha text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare p public.books_native_invoice_correction_proposals;r public.books_native_invoice_correction_reviews;created boolean:=false;
begin
 if p_id is null or p_proposal is null then raise exception 'Correction review and proposal identities are required';end if;
 select * into p from public.books_native_invoice_correction_proposals where org_id=p_org and legal_entity_id=p_entity and project_id=p_project and id=p_proposal;
 if p.id is null then raise exception 'Original scoped correction proposal is required';end if;
 perform public.books_lock_native_adjustment_scope(p_org,p_entity,p_project,p_actor,'review','invoice',p.invoice_id);
 select * into r from public.books_native_invoice_correction_reviews where id=p_id;
 if found then
  if(r.org_id,r.legal_entity_id,r.project_id,r.reviewed_by,r.proposal_id,r.decision,r.notes,r.request_sha256,r.derivation_sha256) is distinct from(p_org,p_entity,p_project,p_actor,p_proposal,p_decision,p_notes,p_request_sha,p_derivation_sha) then raise exception 'Correction review retry differs from exact original intent';end if;
 else
  insert into public.books_native_invoice_correction_reviews(id,org_id,legal_entity_id,project_id,proposal_id,decision,reviewed_by,notes,request_sha256,derivation_sha256) values(p_id,p_org,p_entity,p_project,p_proposal,p_decision,p_actor,p_notes,p_request_sha,p_derivation_sha) returning * into r;created:=true;
 end if;
 return jsonb_build_object('review',to_jsonb(r),'created',created,'posted',false,'sourceChanged',false,'ledgerActivated',false);
end $$;
alter table public.books_native_invoice_correction_reviews enable row level security;
revoke all on public.books_native_invoice_correction_reviews from public,anon,authenticated,service_role;
grant select,insert on public.books_native_invoice_correction_reviews to service_role;
create index books_native_invoice_correction_reviews_project on public.books_native_invoice_correction_reviews(org_id,project_id);
create index books_native_invoice_correction_reviews_actor on public.books_native_invoice_correction_reviews(reviewed_by);
create index books_native_invoice_correction_reviews_access on public.books_native_invoice_correction_reviews(org_id,legal_entity_id,reviewed_access_event_id);
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_invoice_correction_reviews;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;rows jsonb;
begin s:=public.capture_books_export_snapshot_before_invoice_correction_reviews(p_org_id);select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into rows from public.books_native_invoice_correction_reviews r where org_id=p_org_id;return jsonb_set(s,'{tables}',s->'tables'||jsonb_build_object('books_native_invoice_correction_reviews',rows));end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
alter function public.capture_books_legacy_ownership_evidence(uuid,uuid) rename to capture_books_ownership_before_invoice_correction_reviews;
create function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;
begin s:=public.capture_books_ownership_before_invoice_correction_reviews(p_org,p_actor);return jsonb_set(s,'{populationText}',to_jsonb(((s->>'populationText')::jsonb-'books_native_invoice_correction_reviews')::text));end $$;
do $$declare r record;begin
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_native_invoice_correction_review_guard','review_books_native_invoice_correction','capture_books_export_snapshot_before_invoice_correction_reviews','capture_books_legacy_ownership_evidence','capture_books_ownership_before_invoice_correction_reviews') loop execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);end loop;
end $$;
commit;
