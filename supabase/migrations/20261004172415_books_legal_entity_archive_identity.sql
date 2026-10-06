-- Stable row identities and ordered, restore-safe access events. No ledger activation.
alter table public.books_legal_entity_members add column id uuid not null default gen_random_uuid() unique;
alter table public.books_legal_entity_profile_reviews add column id uuid not null default gen_random_uuid() unique;
alter table public.books_legal_entity_access_history rename column id to sequence_no;
alter table public.books_legal_entity_access_history alter column sequence_no drop identity;
alter table public.books_legal_entity_access_history drop constraint books_legal_entity_access_history_pkey;
alter table public.books_legal_entity_access_history add column id uuid not null default gen_random_uuid() primary key;
alter table public.books_legal_entity_access_history add constraint books_entity_access_sequence_unique unique(org_id,legal_entity_id,sequence_no);
create function public.books_entity_access_sequence() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 if not found then raise exception 'Entity access event has no owning entity';end if;
 -- Restored values are preserved during the administrative replica-mode load;
 -- the first normal access change continues after retained entity history.
 select coalesce(max(sequence_no),0)+1 into new.sequence_no from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id;
 return new;
end $$;
create trigger books_entity_access_sequence before insert on public.books_legal_entity_access_history for each row execute function public.books_entity_access_sequence();
revoke all on function public.books_entity_access_sequence() from public,anon,authenticated;
grant execute on function public.books_entity_access_sequence() to service_role;
do $$ declare v_definition text;begin
 select pg_get_functiondef('public.read_books_legal_entity_setup(uuid,uuid,uuid,uuid,integer)'::regprocedure) into v_definition;
 v_definition:=replace(v_definition,'order by id desc','order by sequence_no desc');
 execute v_definition;
end $$;

-- Freeze the precise access event that authorized preparation/review. Future
-- revocation cannot erase that historical proof or invent past reviewer rights.
alter table public.books_legal_entity_access_history add constraint books_entity_access_identity_unique unique(org_id,legal_entity_id,id);
alter table public.books_legal_entity_profiles add column prepared_access_event_id uuid;
alter table public.books_legal_entity_profile_reviews add column reviewed_access_event_id uuid;
alter table public.books_legal_entity_profiles disable trigger books_entity_profiles_immutable;
alter table public.books_legal_entity_profile_reviews disable trigger books_entity_reviews_immutable;
update public.books_legal_entity_profiles p set prepared_access_event_id=(select h.id from public.books_legal_entity_access_history h where h.org_id=p.org_id and h.legal_entity_id=p.legal_entity_id and h.user_id=p.prepared_by and h.changed_at<=p.prepared_at order by h.sequence_no desc limit 1);
update public.books_legal_entity_profile_reviews r set reviewed_access_event_id=(select h.id from public.books_legal_entity_access_history h where h.org_id=r.org_id and h.legal_entity_id=r.legal_entity_id and h.user_id=r.reviewed_by and h.changed_at<=r.reviewed_at order by h.sequence_no desc limit 1);
alter table public.books_legal_entity_profiles enable trigger books_entity_profiles_immutable;
alter table public.books_legal_entity_profile_reviews enable trigger books_entity_reviews_immutable;
do $$ begin
 if exists(select 1 from public.books_legal_entity_profiles p left join public.books_legal_entity_access_history h on h.org_id=p.org_id and h.legal_entity_id=p.legal_entity_id and h.id=p.prepared_access_event_id where h.id is null or h.access_level not in('prepare','manage')) or exists(select 1 from public.books_legal_entity_profile_reviews r left join public.books_legal_entity_access_history h on h.org_id=r.org_id and h.legal_entity_id=r.legal_entity_id and h.id=r.reviewed_access_event_id where h.id is null or h.access_level not in('review','manage')) then raise exception 'Legacy entity identity lacks proven historical preparation/review access; review setup evidence before upgrade';end if;
end $$;
alter table public.books_legal_entity_profiles alter column prepared_access_event_id set not null;
alter table public.books_legal_entity_profile_reviews alter column reviewed_access_event_id set not null;
alter table public.books_legal_entity_profiles add foreign key(org_id,legal_entity_id,prepared_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id);
alter table public.books_legal_entity_profile_reviews add foreign key(org_id,legal_entity_id,reviewed_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id);
do $$ declare v_definition text;begin
 select pg_get_functiondef('public.books_entity_profile_guard()'::regprocedure) into v_definition;
 v_definition:=replace(v_definition,'return new;', 'new.prepared_at:=clock_timestamp();select id into new.prepared_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.prepared_by order by sequence_no desc limit 1;return new;');
 execute v_definition;
 select pg_get_functiondef('public.books_entity_profile_review_guard()'::regprocedure) into v_definition;
 v_definition:=replace(v_definition,'return new;', 'new.reviewed_at:=clock_timestamp();select id into new.reviewed_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.reviewed_by order by sequence_no desc limit 1;return new;');
 execute v_definition;
end $$;

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
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create function public.capture_books_entity_authorized_export(p_org_id uuid,p_actor_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Active organization membership is required for export';end if;
 if exists(select 1 from public.books_legal_entities e where e.org_id=p_org_id and not public.books_entity_has_access(e.org_id,e.id,p_actor_id,'read')) then raise exception 'Complete export requires explicit access to every included legal entity';end if;
 return public.capture_books_export_snapshot(p_org_id);
end $$;
revoke all on function public.capture_books_entity_authorized_export(uuid,uuid) from public,anon,authenticated;
grant execute on function public.capture_books_entity_authorized_export(uuid,uuid) to service_role;
create function public.assert_books_entity_export_download(p_org_id uuid,p_actor_id uuid,p_export_id uuid)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare e public.books_exports;v_ids jsonb;v_id text;v_count integer;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Active organization membership is required for export';end if;
 select * into e from public.books_exports where org_id=p_org_id and id=p_export_id;
 if not found or e.status<>'ready' or (e.expires_at is not null and e.expires_at<=statement_timestamp()) then raise exception 'Export is unavailable';end if;
 if e.schema_version>=18 then
  v_ids:=e.manifest->'legalEntityIds';
  if jsonb_typeof(v_ids) is distinct from 'array' then raise exception 'Export legal entity inventory is unavailable';end if;
  v_count:=(e.manifest->'tables'->'books_legal_entities'->>'rows')::integer;
  if v_count is null or v_count<>jsonb_array_length(v_ids) or (select count(distinct value) from jsonb_array_elements_text(v_ids))<>v_count then raise exception 'Export legal entity inventory differs from manifest';end if;
  for v_id in select value from jsonb_array_elements_text(v_ids) loop
   if not public.books_entity_has_access(p_org_id,v_id::uuid,p_actor_id,'read') then raise exception 'Export contains a legal entity outside current access';end if;
  end loop;
 else
  -- Legacy archive ownership is unknown; never bypass current entity access.
  if exists(select 1 from public.books_legal_entities x where x.org_id=p_org_id and not public.books_entity_has_access(x.org_id,x.id,p_actor_id,'read')) then raise exception 'Legacy export requires access to all organization entities';end if;
 end if;
 return true;
end $$;
revoke all on function public.assert_books_entity_export_download(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.assert_books_entity_export_download(uuid,uuid,uuid) to service_role;
-- Export proof must not be editable through the browser Data API. Download
-- audit fields remain writable by the permission-checked server action.
revoke all on public.books_exports from public,anon,authenticated;
grant select,insert,update,delete on public.books_exports to service_role;
create function public.books_entity_export_proof_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if (old.status in('ready','expired') or old.completed_at is not null or old.content_hash is not null) and (old.id,old.org_id,old.export_type,old.schema_version,old.storage_path,old.content_hash,old.manifest,old.verification,old.requested_by,old.requested_at,old.completed_at,old.expires_at) is distinct from (new.id,new.org_id,new.export_type,new.schema_version,new.storage_path,new.content_hash,new.manifest,new.verification,new.requested_by,new.requested_at,new.completed_at,new.expires_at) then raise exception 'Completed Books export proof is immutable';end if;
 return new;
end $$;
create trigger books_entity_export_proof_guard before update on public.books_exports for each row execute function public.books_entity_export_proof_guard();
revoke all on function public.books_entity_export_proof_guard() from public,anon,authenticated;
grant execute on function public.books_entity_export_proof_guard() to service_role;
