-- Reviewed legacy assignment intent only. No source, chart, journal, period or
-- ledger is relabeled/activated by preparation or review.
create table public.books_legacy_entity_proposals (
 id uuid primary key, org_id uuid not null,legal_entity_id uuid not null,
 profile_id uuid not null,previous_reviewed_proposal_id uuid,
 accounting_cutoff date not null,
 assignment_kind text not null default 'single_entity_legacy' check(assignment_kind='single_entity_legacy'),
 decision_evidence jsonb not null,
 source_population_text text not null check(octet_length(source_population_text)<=268435456),
 source_population_sha256 text not null check(source_population_sha256 ~ '^[a-f0-9]{64}$'),
 source_captured_at timestamptz not null,source_database_snapshot text not null check(length(source_database_snapshot)>0),
 prepared_by uuid not null references public.app_users(id),prepared_at timestamptz not null,
 prepared_access_event_id uuid not null,preparation_notes text not null check(length(trim(preparation_notes)) between 10 and 2000),
 unique(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id) references public.books_legal_entities(org_id,id),
 foreign key(org_id,legal_entity_id,profile_id) references public.books_legal_entity_profiles(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,previous_reviewed_proposal_id) references public.books_legacy_entity_proposals(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,prepared_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id),
 check(previous_reviewed_proposal_id is distinct from id)
);
create table public.books_legacy_entity_reviews (
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,
 proposal_id uuid not null unique,
 reviewed_by uuid not null references public.app_users(id),reviewed_at timestamptz not null,
 source_population_sha256 text not null check(source_population_sha256 ~ '^[a-f0-9]{64}$'),source_rechecked_at timestamptz not null,source_database_snapshot text not null check(length(source_database_snapshot)>0),
 reviewed_access_event_id uuid not null,review_notes text not null check(length(trim(review_notes)) between 10 and 2000),
 foreign key(org_id,legal_entity_id,proposal_id) references public.books_legacy_entity_proposals(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,reviewed_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create index books_legacy_entity_proposal_page_idx on public.books_legacy_entity_proposals(org_id,legal_entity_id,id);

create function public.assert_books_legacy_entity_operation(p_org uuid,p_entity uuid,p_actor uuid,p_operation text)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog,public as $$
begin
 if p_operation not in('read','prepare','review') or not public.books_entity_has_access(p_org,p_entity,p_actor,p_operation) then raise exception 'Explicit entity operation access is required';end if;
 if exists(select 1 from public.books_legal_entities e where e.org_id=p_org and not public.books_entity_has_access(e.org_id,e.id,p_actor,'read')) then raise exception 'Legacy evidence requires explicit access to every included legal entity';end if;
 return true;
end $$;

create function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 -- Approval history cannot make its own preparation stale or recursively embed
 -- itself. All other captured tables, including access/profile/source history,
 -- remain included without a date/status filter.
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews';
 -- Match the existing accounting archive's typed redactions inside this frozen
 -- text too; nested evidence must not reintroduce full TINs or provider handles.
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end $$;
create function public.capture_books_legacy_ownership_population(p_org uuid,p_actor uuid)
returns text language sql stable security invoker set search_path=pg_catalog,public as $$
 select public.capture_books_legacy_ownership_evidence(p_org,p_actor)->>'populationText';
$$;

create function public.books_legacy_entity_proposal_guard()
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
 v_evidence:=public.capture_books_legacy_ownership_evidence(new.org_id,new.prepared_by);
 new.source_population_text:=v_evidence->>'populationText';
 new.source_captured_at:=(v_evidence->>'capturedAt')::timestamptz;new.source_database_snapshot:=v_evidence->>'databaseSnapshot';
 new.source_population_sha256:=encode(sha256(convert_to(new.source_population_text,'UTF8')),'hex');
 new.prepared_at:=clock_timestamp();
 select id into new.prepared_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.prepared_by order by sequence_no desc limit 1;
 return new;
end $$;

create function public.books_legacy_entity_review_guard()
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
 if p.source_population_text::jsonb is distinct from (v_evidence->>'populationText')::jsonb then raise exception 'Legacy source population changed; recapture and review original evidence';end if;
 new.source_population_sha256:=p.source_population_sha256;new.source_rechecked_at:=(v_evidence->>'capturedAt')::timestamptz;new.source_database_snapshot:=v_evidence->>'databaseSnapshot';
 new.reviewed_at:=clock_timestamp();
 select id into new.reviewed_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.reviewed_by order by sequence_no desc limit 1;
 return new;
end $$;
create trigger books_legacy_entity_proposals_guard before insert on public.books_legacy_entity_proposals for each row execute function public.books_legacy_entity_proposal_guard();
create trigger books_legacy_entity_reviews_guard before insert on public.books_legacy_entity_reviews for each row execute function public.books_legacy_entity_review_guard();
create trigger books_legacy_entity_proposals_immutable before update or delete on public.books_legacy_entity_proposals for each row execute function public.books_entity_immutable();
create trigger books_legacy_entity_reviews_immutable before update or delete on public.books_legacy_entity_reviews for each row execute function public.books_entity_immutable();

create function public.prepare_books_legacy_entity_proposal(p_org uuid,p_entity uuid,p_id uuid,p_actor uuid,p_profile uuid,p_previous uuid,p_cutoff date,p_evidence jsonb,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_legacy_entity_proposals;
begin
 perform 1 from public.orgs where id=p_org for update;
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') then raise exception 'Entity preparation access is required';end if;
 select * into p from public.books_legacy_entity_proposals where id=p_id;
 if found then
  if (p.org_id,p.legal_entity_id,p.prepared_by,p.profile_id,p.previous_reviewed_proposal_id,p.accounting_cutoff,p.decision_evidence,p.preparation_notes) is distinct from (p_org,p_entity,p_actor,p_profile,p_previous,p_cutoff,p_evidence,p_notes) then raise exception 'Legacy proposal retry differs from frozen preparation';end if;
  -- Current access to every entity is still required for this private receipt.
  perform public.assert_books_legacy_entity_operation(p_org,p_entity,p_actor,'prepare');
  return to_jsonb(p);
 end if;
 insert into public.books_legacy_entity_proposals(id,org_id,legal_entity_id,profile_id,previous_reviewed_proposal_id,accounting_cutoff,decision_evidence,prepared_by,preparation_notes)
 values(p_id,p_org,p_entity,p_profile,p_previous,p_cutoff,p_evidence,p_actor,p_notes) returning * into p;
 return to_jsonb(p);
end $$;
create function public.review_books_legacy_entity_proposal(p_org uuid,p_entity uuid,p_id uuid,p_proposal uuid,p_actor uuid,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.books_legacy_entity_reviews;
begin
 perform 1 from public.orgs where id=p_org for update;
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'review') then raise exception 'Entity review access is required';end if;
 select * into r from public.books_legacy_entity_reviews where id=p_id or proposal_id=p_proposal;
 if found then
  if (r.id,r.org_id,r.legal_entity_id,r.proposal_id,r.reviewed_by,r.review_notes) is distinct from (p_id,p_org,p_entity,p_proposal,p_actor,p_notes) then raise exception 'Legacy review retry differs from retained approval';end if;
  perform public.assert_books_legacy_entity_operation(p_org,p_entity,p_actor,'review');
  return to_jsonb(r);
 end if;
 insert into public.books_legacy_entity_reviews(id,org_id,legal_entity_id,proposal_id,reviewed_by,review_notes) values(p_id,p_org,p_entity,p_proposal,p_actor,p_notes) returning * into r;
 return to_jsonb(r);
end $$;
create function public.read_books_legacy_entity_proposal(p_org uuid,p_entity uuid,p_proposal uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare p public.books_legacy_entity_proposals;r jsonb;
begin
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Entity read access is required';end if;
 perform public.assert_books_legacy_entity_operation(p_org,p_entity,p_actor,'read');
 select * into p from public.books_legacy_entity_proposals where org_id=p_org and legal_entity_id=p_entity and id=p_proposal;
 if not found then raise exception 'Legacy ownership proposal is unavailable';end if;
 select to_jsonb(x) into r from public.books_legacy_entity_reviews x where org_id=p_org and legal_entity_id=p_entity and proposal_id=p.id;
 return jsonb_build_object('proposal',to_jsonb(p),'review',r,'sourcePopulationCurrent',p.source_population_text::jsonb=public.capture_books_legacy_ownership_population(p_org,p_actor)::jsonb,'approvedForLedgerActivation',false);
end $$;

do $$ declare v_table text;r record;begin
 foreach v_table in array array['books_legacy_entity_proposals','books_legacy_entity_reviews'] loop
  execute format('alter table public.%I enable row level security',v_table);
  execute format('revoke all on public.%I from public,anon,authenticated',v_table);
  execute format('grant select,insert,update,delete on public.%I to service_role',v_table);
 end loop;
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('assert_books_legacy_entity_operation','capture_books_legacy_ownership_evidence','capture_books_legacy_ownership_population','books_legacy_entity_proposal_guard','books_legacy_entity_review_guard','prepare_books_legacy_entity_proposal','review_books_legacy_entity_proposal','read_books_legacy_entity_proposal') loop
  execute format('revoke all on function %s from public,anon,authenticated',r.signature);
  execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;

-- Schema19 includes immutable assignment preparation and review history.
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
    'books_legal_entities',
    'books_legal_entity_members',
    'books_legal_entity_access_history',
    'books_legal_entity_profiles',
    'books_legal_entity_profile_reviews',
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
    'books_legacy_entity_proposals',
    'books_legacy_entity_reviews',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg((to_jsonb(t) || jsonb_build_object(''id'', t.id::text)) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
