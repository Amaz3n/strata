begin;
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_project_owners;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;rows jsonb;t text;
begin
 snapshot:=public.capture_books_export_snapshot_before_project_owners(p_org_id);
 foreach t in array array['books_project_entity_proposals','books_project_entity_reviews'] loop
 execute format('select coalesce(jsonb_agg(to_jsonb(r) order by r.id),''[]'') from public.%I r where org_id=$1',t) into rows using p_org_id;
 snapshot:=jsonb_set(snapshot,array['tables',t],rows);end loop;return snapshot;
end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions'-'books_entity_calendar_years'-'books_entity_fiscal_periods'-'books_entity_calendar_reviews'-'books_entity_chart_versions'-'books_entity_accounts'-'books_entity_account_definitions'-'books_entity_control_accounts'-'books_entity_chart_reviews';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;
alter table public.books_legacy_entity_proposals add column population_contract_version integer not null default 1 check(population_contract_version in(1,2));
create or replace function public.books_legacy_entity_proposal_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_profile uuid;v_previous uuid;v_doc text;v_evidence jsonb;
begin
 perform 1 from public.orgs where id=new.org_id for update;
 lock table public.memberships in share mode;
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 if not found or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.prepared_by,'prepare') then raise exception 'Entity preparation access is required';end if;
 select p.id into v_profile from public.books_legal_entity_profiles p join public.books_legal_entity_profile_reviews r on r.profile_id=p.id where p.org_id=new.org_id and p.legal_entity_id=new.legal_entity_id order by p.revision desc limit 1;
 if v_profile is null or new.profile_id is distinct from v_profile then raise exception 'Use the current independently reviewed entity identity';end if;
 select p.id into v_previous from public.books_legacy_entity_proposals p join public.books_legacy_entity_reviews r on r.proposal_id=p.id where p.org_id=new.org_id and p.legal_entity_id=new.legal_entity_id order by r.reviewed_at desc,r.id desc limit 1;
 if new.previous_reviewed_proposal_id is distinct from v_previous then raise exception 'Legacy ownership predecessor changed';end if;
 if new.accounting_cutoff>current_date then raise exception 'Ownership cutoff cannot be in the future';end if;
 if jsonb_typeof(new.decision_evidence) is distinct from 'object' or new.decision_evidence-array['rationale','single_entity_history_confirmed','document_version_ids']<>'{}' or new.decision_evidence->'single_entity_history_confirmed' is distinct from 'true'::jsonb or jsonb_typeof(new.decision_evidence->'rationale') is distinct from 'string' or length(trim(new.decision_evidence->>'rationale')) not between 10 and 2000 or jsonb_typeof(new.decision_evidence->'document_version_ids') is distinct from 'array' then raise exception 'Explicit single-entity rationale and original supporting versions are required';end if;
 if jsonb_array_length(new.decision_evidence->'document_version_ids') not between 1 and 50 or (select count(distinct d) from jsonb_array_elements_text(new.decision_evidence->'document_version_ids') d)<>jsonb_array_length(new.decision_evidence->'document_version_ids') then raise exception 'Retain one to fifty distinct original document versions';end if;
 for v_doc in select jsonb_array_elements_text(new.decision_evidence->'document_version_ids') loop
  if v_doc::uuid::text<>v_doc or not exists(select 1 from public.doc_versions d join public.files f on f.org_id=d.org_id and f.id=d.file_id where d.org_id=new.org_id and d.id=v_doc::uuid and d.storage_path like new.org_id::text||'/%' and d.checksum ~ '^[a-f0-9]{64}$' and d.size_bytes>=0) then raise exception 'Original ownership document metadata is missing or outside organization';end if;
 end loop;
 if exists(select 1 from public.books_project_entity_reviews where org_id=new.org_id and legal_entity_id<>new.legal_entity_id) then raise exception 'Mixed native project owners require explicit entity legacy adoption';end if;
 new.population_contract_version:=2;
 v_evidence:=public.capture_books_legacy_ownership_evidence(new.org_id,new.prepared_by);
 new.source_population_text:=v_evidence->>'populationText';
 new.source_captured_at:=(v_evidence->>'capturedAt')::timestamptz;new.source_database_snapshot:=v_evidence->>'databaseSnapshot';
 new.source_population_sha256:=encode(sha256(convert_to(new.source_population_text,'UTF8')),'hex');
 new.prepared_at:=clock_timestamp();
 select id into new.prepared_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.prepared_by order by sequence_no desc limit 1;
 return new;
end $$;

create or replace function public.books_legacy_entity_review_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_legacy_entity_proposals;v_profile uuid;v_previous uuid;v_table text;v_evidence jsonb;
begin
 perform 1 from public.orgs where id=new.org_id for update;
 lock table public.memberships in share mode;
 -- Source-table write fences are retained until transaction end. They protect
 -- this reviewed intent, not a native ownership activation. Full native race
 -- acceptance and a scalable writer/ownership fence are still required.
 for v_table in select jsonb_object_keys((public.capture_books_legacy_ownership_population(new.org_id,new.reviewed_by))::jsonb) order by 1 loop
  execute format('lock table public.%I in share mode',v_table);
 end loop;
 select * into p from public.books_legacy_entity_proposals where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.proposal_id for update;
 if not found or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.reviewed_by,'review') or new.reviewed_by=p.prepared_by then raise exception 'Legacy ownership requires a separate active entity reviewer';end if;
 select x.id into v_profile from public.books_legal_entity_profiles x join public.books_legal_entity_profile_reviews r on r.profile_id=x.id where x.org_id=p.org_id and x.legal_entity_id=p.legal_entity_id order by x.revision desc limit 1;
 if v_profile is distinct from p.profile_id then raise exception 'Reviewed entity identity changed; prepare a current proposal';end if;
 select x.id into v_previous from public.books_legacy_entity_proposals x join public.books_legacy_entity_reviews r on r.proposal_id=x.id where x.org_id=p.org_id and x.legal_entity_id=p.legal_entity_id order by r.reviewed_at desc,r.id desc limit 1;
 if v_previous is distinct from p.previous_reviewed_proposal_id then raise exception 'Legacy ownership predecessor changed; prepare a current proposal';end if;
 v_evidence:=public.capture_books_legacy_ownership_evidence(p.org_id,new.reviewed_by);
 if exists(select 1 from public.books_project_entity_reviews where org_id=p.org_id and legal_entity_id<>p.legal_entity_id) then raise exception 'Mixed native project owners require explicit entity legacy adoption';end if;
 if p.population_contract_version=1 then
 if exists(select 1 from public.books_project_entity_proposals where org_id=p.org_id) or exists(select 1 from public.books_project_entity_reviews where org_id=p.org_id) then raise exception 'Project ownership changed; prepare a current legacy population contract';end if;
 v_evidence:=jsonb_set(v_evidence,'{populationText}',to_jsonb(((v_evidence->>'populationText')::jsonb-'books_project_entity_proposals'-'books_project_entity_reviews')::text));
 end if;
 if p.source_population_text::jsonb is distinct from (v_evidence->>'populationText')::jsonb then raise exception 'Legacy source population changed; recapture and review original evidence';end if;
 new.source_population_sha256:=p.source_population_sha256;new.source_rechecked_at:=(v_evidence->>'capturedAt')::timestamptz;new.source_database_snapshot:=v_evidence->>'databaseSnapshot';
 new.reviewed_at:=clock_timestamp();
 select id into new.reviewed_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.reviewed_by order by sequence_no desc limit 1;
 return new;
end $$;
create or replace function public.read_books_legacy_entity_proposal(p_org uuid,p_entity uuid,p_proposal uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare p public.books_legacy_entity_proposals;r jsonb;population jsonb;is_current boolean;
begin
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Entity read access is required';end if;
 perform public.assert_books_legacy_entity_operation(p_org,p_entity,p_actor,'read');
 select * into p from public.books_legacy_entity_proposals where org_id=p_org and legal_entity_id=p_entity and id=p_proposal;
 if not found then raise exception 'Legacy ownership proposal is unavailable';end if;
 select to_jsonb(x) into r from public.books_legacy_entity_reviews x where org_id=p_org and legal_entity_id=p_entity and proposal_id=p.id;
 population:=public.capture_books_legacy_ownership_population(p_org,p_actor)::jsonb;
 if p.population_contract_version=1 and not exists(select 1 from public.books_project_entity_proposals where org_id=p_org) and not exists(select 1 from public.books_project_entity_reviews where org_id=p_org) then
 population:=population-'books_project_entity_proposals'-'books_project_entity_reviews';
 end if;
 is_current:=p.source_population_text::jsonb=population;
 return jsonb_build_object('proposal',to_jsonb(p),'review',r,'sourcePopulationCurrent',is_current,'approvedForLedgerActivation',false);
end $$;
commit;
