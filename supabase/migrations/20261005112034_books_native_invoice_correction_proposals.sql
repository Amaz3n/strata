-- Pending: immutable native invoice correction preparation. No approval or money.
begin;
create table public.books_native_invoice_correction_proposals(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,project_id uuid not null,invoice_id uuid not null,
 original_posting_id uuid not null,original_entry_id uuid not null,
 owner_review_id uuid not null,chart_id uuid not null,period_id uuid not null,entry_date date not null,
 request_text text not null check(octet_length(request_text)<=8400000),request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 derivation_text text not null check(octet_length(derivation_text)<=84000000),derivation_sha256 text not null check(derivation_sha256 ~ '^[a-f0-9]{64}$'),
 prepared_by uuid not null references public.app_users(id),prepared_access_event_id uuid not null,prepared_at timestamptz not null,
 unique(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,original_posting_id) references public.books_native_invoice_postings(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,original_entry_id) references public.books_native_journal_entries(org_id,legal_entity_id,id),
 foreign key(org_id,project_id) references public.projects(org_id,id),foreign key(org_id,invoice_id) references public.invoices(org_id,id),
 foreign key(org_id,legal_entity_id,project_id,owner_review_id) references public.books_project_entity_reviews(org_id,legal_entity_id,project_id,id),
 foreign key(org_id,legal_entity_id,chart_id) references public.books_entity_chart_versions(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,period_id) references public.books_entity_fiscal_periods(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,prepared_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create function public.books_validate_native_invoice_correction_request(q jsonb,p_org uuid,p_entity uuid,p_project uuid,p_actor uuid)
returns uuid language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare k text;v text;c jsonb:=q->'context';
begin
 if jsonb_typeof(q) is distinct from 'object' or octet_length(q::text)>8400000 or q-array['id','expectedOrgId','expectedActorId','context','originalPostingId','notes']<>'{}' or (select count(*) from jsonb_object_keys(q))<>6 then raise exception 'Canonical bounded native correction request is required';end if;
 foreach k in array array['id','expectedOrgId','expectedActorId','originalPostingId'] loop v:=q->>k;if jsonb_typeof(q->k) is distinct from 'string' or v::uuid::text is distinct from v then raise exception 'Canonical native correction UUID is required';end if;end loop;
 if (q->>'expectedOrgId',q->>'expectedActorId',c->>'orgId',c->>'actorId',c->'owner'->>'legal_entity_id',c->>'projectId',c->>'sourceType') is distinct from(p_org::text,p_actor::text,p_org::text,p_actor::text,p_entity::text,p_project::text,'invoice') then raise exception 'Native correction request differs from original scope or actor';end if;
 if jsonb_typeof(q->'notes') is distinct from 'string' or length(q->>'notes') not between 10 and 2000 or q->>'notes'<>btrim(q->>'notes') then raise exception 'Native correction explanation is required';end if;
 return (q->>'id')::uuid;
end $$;
create function public.books_native_invoice_correction_proposal_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare q jsonb:=new.request_text::jsonb;r jsonb;c jsonb;
begin
 if public.books_validate_native_invoice_correction_request(q,new.org_id,new.legal_entity_id,new.project_id,new.prepared_by) is distinct from new.id then raise exception 'Native correction proposal identity differs';end if;
 r:=public.books_derive_native_invoice_reversal(new.org_id,new.legal_entity_id,new.project_id,new.prepared_by,new.id,(q->>'originalPostingId')::uuid,q->'context',q->>'notes');c:=r->'validatedContext';
 new.invoice_id:=(c->>'sourceId')::uuid;new.original_posting_id:=(r->'originalPosting'->>'id')::uuid;new.original_entry_id:=(r->'originalPosting'->>'entry_id')::uuid;
 new.owner_review_id:=(c->'owner'->>'id')::uuid;new.chart_id:=(c->'chart'->>'id')::uuid;new.period_id:=(c->'period'->>'id')::uuid;new.entry_date:=(c->>'entryDate')::date;
 new.request_text:=q::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');new.derivation_text:=r::text;new.derivation_sha256:=encode(sha256(convert_to(new.derivation_text,'UTF8')),'hex');new.prepared_at:=clock_timestamp();
 select id into new.prepared_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.prepared_by order by sequence_no desc limit 1;
 return new;
end $$;
create trigger books_native_invoice_correction_proposal_guard before insert on public.books_native_invoice_correction_proposals for each row execute function public.books_native_invoice_correction_proposal_guard();
create trigger books_native_invoice_correction_proposal_immutable before update or delete on public.books_native_invoice_correction_proposals for each row execute function public.books_entity_immutable();
create function public.prepare_books_native_invoice_correction(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare target uuid;r public.books_native_invoice_correction_proposals;created boolean:=false;
begin
 target:=public.books_validate_native_invoice_correction_request(p_request,p_org,p_entity,p_project,p_actor);
 perform public.books_lock_native_adjustment_scope(p_org,p_entity,p_project,p_actor,'prepare','invoice',(p_request->'context'->>'sourceId')::uuid);
 select * into r from public.books_native_invoice_correction_proposals where id=target;
 if found then
  if (r.org_id,r.legal_entity_id,r.project_id,r.prepared_by,r.request_text::jsonb) is distinct from(p_org,p_entity,p_project,p_actor,p_request) then raise exception 'Native correction retry differs from original intent';end if;
 else
  insert into public.books_native_invoice_correction_proposals(id,org_id,legal_entity_id,project_id,prepared_by,request_text) values(target,p_org,p_entity,p_project,p_actor,p_request::text) returning * into r;created:=true;
 end if;
 return jsonb_build_object('proposal',to_jsonb(r),'created',created,'posted',false,'reviewed',false,'sourceChanged',false,'ledgerActivated',false);
end $$;
alter table public.books_native_invoice_correction_proposals enable row level security;
revoke all on public.books_native_invoice_correction_proposals from public,anon,authenticated,service_role;
grant select,insert on public.books_native_invoice_correction_proposals to service_role;
create index books_native_invoice_correction_source_idx on public.books_native_invoice_correction_proposals(org_id,legal_entity_id,invoice_id);
create index books_native_invoice_correction_original_idx on public.books_native_invoice_correction_proposals(org_id,legal_entity_id,original_posting_id);
create index books_native_invoice_correction_entry_idx on public.books_native_invoice_correction_proposals(org_id,legal_entity_id,original_entry_id);
create index books_native_invoice_correction_project_idx on public.books_native_invoice_correction_proposals(org_id,project_id);
create index books_native_invoice_correction_owner_idx on public.books_native_invoice_correction_proposals(org_id,legal_entity_id,project_id,owner_review_id);
create index books_native_invoice_correction_chart_idx on public.books_native_invoice_correction_proposals(org_id,legal_entity_id,chart_id);
create index books_native_invoice_correction_period_idx on public.books_native_invoice_correction_proposals(org_id,legal_entity_id,period_id);
create index books_native_invoice_correction_actor_idx on public.books_native_invoice_correction_proposals(prepared_by);
create index books_native_invoice_correction_access_idx on public.books_native_invoice_correction_proposals(org_id,legal_entity_id,prepared_access_event_id);
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_native_invoice_corrections;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;rows jsonb;
begin s:=public.capture_books_export_snapshot_before_native_invoice_corrections(p_org_id);select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into rows from public.books_native_invoice_correction_proposals r where org_id=p_org_id;return jsonb_set(s,'{tables}',s->'tables'||jsonb_build_object('books_native_invoice_correction_proposals',rows));end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
alter function public.capture_books_legacy_ownership_evidence(uuid,uuid) rename to capture_books_ownership_before_invoice_corrections;
create function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;
begin s:=public.capture_books_ownership_before_invoice_corrections(p_org,p_actor);return jsonb_set(s,'{populationText}',to_jsonb(((s->>'populationText')::jsonb-'books_native_invoice_correction_proposals')::text));end $$;
do $$declare r record;begin
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_validate_native_invoice_correction_request','books_native_invoice_correction_proposal_guard','prepare_books_native_invoice_correction','capture_books_export_snapshot','capture_books_legacy_ownership_evidence','capture_books_export_snapshot_before_native_invoice_corrections','capture_books_ownership_before_invoice_corrections') loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
