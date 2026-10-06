begin;
create unique index if not exists books_projects_org_identity_idx on public.projects(org_id,id);
create table public.books_project_entity_proposals(
 id uuid primary key,org_id uuid not null,project_id uuid not null,legal_entity_id uuid not null,profile_id uuid not null,effective_on date not null,
 project_name text not null,decision_evidence jsonb not null,documents jsonb not null,
 prepared_by uuid not null references public.app_users(id),prepared_at timestamptz not null,prepared_access_event_id uuid not null,preparation_notes text not null check(length(btrim(preparation_notes)) between 10 and 2000),
 unique(org_id,legal_entity_id,project_id,id),
 foreign key(org_id,project_id) references public.projects(org_id,id) on delete restrict,
 foreign key(org_id,legal_entity_id,profile_id) references public.books_legal_entity_profiles(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,prepared_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id),
 check(effective_on between '1900-01-01' and '9997-12-31')
);
create table public.books_project_entity_reviews(
 id uuid primary key,org_id uuid not null,project_id uuid not null,legal_entity_id uuid not null,proposal_id uuid not null unique,
 reviewed_by uuid not null references public.app_users(id),reviewed_at timestamptz not null,reviewed_access_event_id uuid not null,review_notes text not null check(length(btrim(review_notes)) between 10 and 2000),
 unique(org_id,project_id),
 foreign key(org_id,legal_entity_id,project_id,proposal_id) references public.books_project_entity_proposals(org_id,legal_entity_id,project_id,id),
 foreign key(org_id,legal_entity_id,reviewed_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create function public.books_payload_uuid_refs(p_payload jsonb)
returns setof uuid language sql immutable security invoker set search_path=pg_catalog,public as $$
 with recursive walked(v) as (
 select p_payload union all select child.v from walked w cross join lateral(
 select value v from jsonb_each(case when jsonb_typeof(w.v)='object' then w.v else '{}'::jsonb end)
 union all select value v from jsonb_array_elements(case when jsonb_typeof(w.v)='array' then w.v else '[]'::jsonb end)) child
 ), strings(value) as(
 select v#>>'{}' from walked where jsonb_typeof(v)='string'
 union all select key from walked cross join lateral jsonb_object_keys(case when jsonb_typeof(v)='object' then v else '{}'::jsonb end) key
 ) select distinct value::uuid from strings where value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
$$;
create function public.books_fact_project_refs(p_org uuid,p_type text,p_source uuid,p_payload jsonb)
returns setof uuid language sql stable security invoker set search_path=pg_catalog,public as $$
 select p.id from public.projects p where p.org_id=p_org and p.id in(
 select public.books_payload_uuid_refs(p_payload)
 union select project_id from public.vendor_bills where org_id=p_org and id=p_source and p_type in('vendor_bill','retainage_release')
 union select project_id from public.invoices where org_id=p_org and id=p_source and p_type in('invoice','retainage_release')
 union select project_id from public.project_expenses where org_id=p_org and id=p_source and p_type='expense'
 union select legs.project_id from public.payments s left join public.invoices i on i.org_id=s.org_id and i.id=s.invoice_id left join public.vendor_bills b on b.org_id=s.org_id and b.id=s.bill_id cross join lateral(values(s.project_id),(i.project_id),(b.project_id))legs(project_id) where s.org_id=p_org and s.id=p_source and p_type in('invoice_payment','bill_payment','customer_deposit_receipt','customer_deposit_application','customer_deposit_reversal','payment_reversal')
 );
$$;
create function public.books_assert_project_has_no_ledger_history(p_org uuid,p_project uuid)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog,public as $$
begin
 -- Conservative across all nested project/labor/settlement evidence. Do not
 -- mislabel existing facts through a newly selected mutable project dimension.
 if exists(select 1 from public.accounting_facts f cross join lateral public.books_fact_project_refs(f.org_id,f.source_type,f.source_id,f.payload) ref where f.org_id=p_org and ref=p_project)
 or exists(select 1 from public.journal_entries j cross join lateral public.books_fact_project_refs(j.org_id,j.source_type,j.source_id,'{}'::jsonb) ref where j.org_id=p_org and ref=p_project)
 or exists(select 1 from public.journal_lines l where l.org_id=p_org and (l.project_id=p_project or strpos(l.dimensions::text,p_project::text)>0)) then raise exception 'Project has retained accounting history; reviewed legacy ownership/correction is required';end if;
 return true;
end $$;
create function public.books_project_owner_documents(p_org uuid,p_ids jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;x text;
begin
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 50 or (select count(distinct item.value) from jsonb_array_elements_text(p_ids)item(value))<>jsonb_array_length(p_ids) then raise exception 'Retain one to fifty distinct original ownership documents';end if;
 for x in select jsonb_array_elements_text(p_ids) loop
 if x::uuid::text<>x or not exists(select 1 from public.doc_versions d join public.files f on f.org_id=d.org_id and f.id=d.file_id where d.org_id=p_org and d.id=x::uuid and d.storage_path like p_org::text||'/%' and d.checksum ~ '^[a-f0-9]{64}$' and d.size_bytes>=0) then raise exception 'Original project ownership document is missing or foreign';end if;
 end loop;
 select jsonb_agg(jsonb_build_object('id',d.id,'file_id',d.file_id,'storage_path',d.storage_path,'checksum',d.checksum,'size_bytes',d.size_bytes) order by d.id) into result from public.doc_versions d where d.org_id=p_org and d.id in(select value::uuid from jsonb_array_elements_text(p_ids));return result;
end $$;
create function public.books_project_entity_proposal_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare profile uuid;
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 if not found or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.prepared_by,'prepare') then raise exception 'Project entity preparation access is required';end if;
 perform 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active' for share;if not found then raise exception 'Active organization membership is required';end if;
 select name into new.project_name from public.projects where org_id=new.org_id and id=new.project_id for update;if not found then raise exception 'Project is unavailable in organization';end if;
 perform public.books_assert_project_has_no_ledger_history(new.org_id,new.project_id);
 if exists(select 1 from public.books_project_entity_reviews where org_id=new.org_id and project_id=new.project_id) then raise exception 'Project already has an immutable reviewed owner';end if;
 select p.id into profile from public.books_legal_entity_profiles p join public.books_legal_entity_profile_reviews r on r.profile_id=p.id where p.org_id=new.org_id and p.legal_entity_id=new.legal_entity_id and p.effective_on<=new.effective_on order by p.revision desc limit 1;
 if new.effective_on>current_date or profile is null or profile is distinct from new.profile_id then raise exception 'Use the applicable reviewed identity and nonfuture ownership date';end if;
 if jsonb_typeof(new.decision_evidence) is distinct from 'object' or new.decision_evidence-array['single_entity_project_confirmed','rationale','document_version_ids']<>'{}' or (select count(*) from jsonb_object_keys(new.decision_evidence))<>3 or new.decision_evidence->'single_entity_project_confirmed' is distinct from 'true'::jsonb or jsonb_typeof(new.decision_evidence->'rationale') is distinct from 'string' or length(btrim(new.decision_evidence->>'rationale')) not between 10 and 2000 then raise exception 'Explicit single-entity project rationale is required';end if;
 new.documents:=public.books_project_owner_documents(new.org_id,new.decision_evidence->'document_version_ids');
 new.prepared_at:=clock_timestamp();new.preparation_notes:=btrim(new.preparation_notes);
 select id into new.prepared_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.prepared_by order by sequence_no desc limit 1;
 return new;
end $$;
create function public.books_project_entity_review_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_project_entity_proposals;profile uuid;
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 select * into p from public.books_project_entity_proposals where org_id=new.org_id and legal_entity_id=new.legal_entity_id and project_id=new.project_id and id=new.proposal_id;if not found then raise exception 'Project ownership proposal is missing or foreign';end if;
 perform 1 from public.memberships where org_id=new.org_id and user_id in(p.prepared_by,new.reviewed_by) and status='active' order by user_id for share;
 if p.prepared_by=new.reviewed_by or not public.books_entity_has_access(new.org_id,new.legal_entity_id,p.prepared_by,'prepare') or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.reviewed_by,'review') then raise exception 'Independent active project ownership maker/reviewer is required';end if;
 perform 1 from public.projects where org_id=new.org_id and id=new.project_id for update;if not found then raise exception 'Project is unavailable in organization';end if;
 perform public.books_assert_project_has_no_ledger_history(new.org_id,new.project_id);
 select x.id into profile from public.books_legal_entity_profiles x join public.books_legal_entity_profile_reviews r on r.profile_id=x.id where x.org_id=new.org_id and x.legal_entity_id=new.legal_entity_id and x.effective_on<=p.effective_on order by x.revision desc limit 1;
 if profile is distinct from p.profile_id or public.books_project_owner_documents(new.org_id,p.decision_evidence->'document_version_ids') is distinct from p.documents then raise exception 'Project ownership profile or original documents changed';end if;
 new.reviewed_at:=clock_timestamp();new.review_notes:=btrim(new.review_notes);
 select id into new.reviewed_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.reviewed_by order by sequence_no desc limit 1;
 return new;
end $$;
create trigger books_project_entity_proposal_guard before insert on public.books_project_entity_proposals for each row execute function public.books_project_entity_proposal_guard();
create trigger books_project_entity_review_guard before insert on public.books_project_entity_reviews for each row execute function public.books_project_entity_review_guard();
do $$declare t text;begin foreach t in array array['books_project_entity_proposals','books_project_entity_reviews'] loop execute format('create trigger books_project_entity_immutable before update or delete on public.%I for each row execute function public.books_entity_immutable()',t);execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant all on public.%I to service_role',t);end loop;end $$;
create function public.prepare_books_project_entity(p_org uuid,p_entity uuid,p_project uuid,p_id uuid,p_profile uuid,p_actor uuid,p_effective date,p_decision jsonb,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_project_entity_proposals;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') then raise exception 'Project entity preparation access is required';end if;
 select * into p from public.books_project_entity_proposals where id=p_id;
 if found then if(p.org_id,p.legal_entity_id,p.project_id,p.profile_id,p.prepared_by,p.effective_on,p.decision_evidence,p.preparation_notes) is distinct from(p_org,p_entity,p_project,p_profile,p_actor,p_effective,p_decision,btrim(p_notes)) then raise exception 'Project ownership retry differs from original preparation';end if;
 else insert into public.books_project_entity_proposals(id,org_id,project_id,legal_entity_id,profile_id,effective_on,project_name,decision_evidence,documents,prepared_by,prepared_at,prepared_access_event_id,preparation_notes) values(p_id,p_org,p_project,p_entity,p_profile,p_effective,'pending',p_decision,'[]',p_actor,clock_timestamp(),p_id,p_notes) returning * into p;end if;
 return jsonb_build_object('proposal',to_jsonb(p),'ledgerActivated',false);
end $$;
create function public.review_books_project_entity(p_org uuid,p_entity uuid,p_project uuid,p_proposal uuid,p_id uuid,p_actor uuid,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.books_project_entity_reviews;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'review') then raise exception 'Project entity review access is required';end if;
 select * into r from public.books_project_entity_reviews where org_id=p_org and project_id=p_project;
 if found then if(r.id,r.legal_entity_id,r.proposal_id,r.reviewed_by,r.review_notes) is distinct from(p_id,p_entity,p_proposal,p_actor,btrim(p_notes)) then raise exception 'Project ownership retry differs from original reviewed owner';end if;
 else insert into public.books_project_entity_reviews(id,org_id,project_id,legal_entity_id,proposal_id,reviewed_by,reviewed_at,reviewed_access_event_id,review_notes) values(p_id,p_org,p_project,p_entity,p_proposal,p_actor,clock_timestamp(),p_id,p_notes) returning * into r;end if;
 return jsonb_build_object('review',to_jsonb(r),'sourceOwnerEstablished',true,'ledgerActivated',false);
end $$;
create function public.books_project_entity_legacy_line_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.project_id is not null then
 -- Serialize legacy first posting against ownership review: neither may commit
 -- a history check performed before the other's transaction became visible.
 perform 1 from public.projects where org_id=new.org_id and id=new.project_id for update;
 if exists(select 1 from public.books_project_entity_reviews where org_id=new.org_id and project_id=new.project_id) then raise exception 'Project has a reviewed native entity owner; entity-native posting is required';end if;
 end if;return new;
end $$;
create trigger books_project_entity_legacy_line_guard before insert on public.journal_lines for each row execute function public.books_project_entity_legacy_line_guard();
create function public.books_project_entity_legacy_fact_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p uuid;
begin
 for p in select id from public.projects where org_id=new.org_id and id in(select public.books_fact_project_refs(new.org_id,new.source_type,new.source_id,new.payload)) order by id for update loop
 if exists(select 1 from public.books_project_entity_reviews where org_id=new.org_id and project_id=p) then raise exception 'Project has a reviewed native entity owner; entity-native facts/posting are required';end if;
 end loop;return new;
end $$;
create trigger books_project_entity_legacy_fact_guard before insert on public.accounting_facts for each row execute function public.books_project_entity_legacy_fact_guard();
create function public.books_project_entity_legacy_entry_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p uuid;
begin
 for p in select id from public.projects where org_id=new.org_id and id in(select public.books_fact_project_refs(new.org_id,new.source_type,new.source_id,'{}'::jsonb)) order by id for update loop
 if exists(select 1 from public.books_project_entity_reviews where org_id=new.org_id and project_id=p) then raise exception 'Project has a reviewed native entity owner; entity-native journal posting is required';end if;
 end loop;return new;
end $$;
create trigger books_project_entity_legacy_entry_guard before insert on public.journal_entries for each row execute function public.books_project_entity_legacy_entry_guard();
create function public.books_project_entity_source_scope_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if (old.org_id,old.project_id) is distinct from(new.org_id,new.project_id) then
 perform 1 from public.projects where (org_id=old.org_id and id=old.project_id) or (org_id=new.org_id and id=new.project_id) order by org_id,id for update;
 if exists(select 1 from public.books_project_entity_reviews where (org_id=old.org_id and project_id=old.project_id) or (org_id=new.org_id and project_id=new.project_id)) then raise exception 'Native-owned monetary source cannot change project/organization through an ordinary edit; governed correction is required';end if;
 end if;return new;
end $$;
create trigger books_project_entity_source_scope_guard before update of org_id,project_id on public.vendor_bills for each row execute function public.books_project_entity_source_scope_guard();
create trigger books_project_entity_source_scope_guard before update of org_id,project_id on public.invoices for each row execute function public.books_project_entity_source_scope_guard();
create trigger books_project_entity_source_scope_guard before update of org_id,project_id on public.project_expenses for each row execute function public.books_project_entity_source_scope_guard();
create trigger books_project_entity_source_scope_guard before update of org_id,project_id on public.payments for each row execute function public.books_project_entity_source_scope_guard();
create function public.books_project_entity_payment_scope_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare refs uuid[];
begin
 if (old.org_id,old.invoice_id,old.bill_id) is distinct from(new.org_id,new.invoice_id,new.bill_id) then
 select array_agg(distinct project_id) into refs from (
 select project_id from public.invoices where (org_id=old.org_id and id=old.invoice_id) or (org_id=new.org_id and id=new.invoice_id)
 union select project_id from public.vendor_bills where (org_id=old.org_id and id=old.bill_id) or (org_id=new.org_id and id=new.bill_id))x;
 perform 1 from public.projects where id=any(refs) and org_id in(old.org_id,new.org_id) order by org_id,id for update;
 if exists(select 1 from public.books_project_entity_reviews where project_id=any(refs) and org_id in(old.org_id,new.org_id)) then raise exception 'Native-owned payment cannot change its document/organization through an ordinary edit; governed correction is required';end if;
 end if;return new;
end $$;
create trigger books_project_entity_payment_scope_guard before update of org_id,invoice_id,bill_id on public.payments for each row execute function public.books_project_entity_payment_scope_guard();
do $$declare r record;begin for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_payload_uuid_refs','books_fact_project_refs','books_assert_project_has_no_ledger_history','books_project_owner_documents','books_project_entity_proposal_guard','books_project_entity_review_guard','prepare_books_project_entity','review_books_project_entity','books_project_entity_legacy_line_guard','books_project_entity_legacy_fact_guard','books_project_entity_source_scope_guard','books_project_entity_payment_scope_guard','books_project_entity_legacy_entry_guard') loop execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);end loop;end $$;
commit;
