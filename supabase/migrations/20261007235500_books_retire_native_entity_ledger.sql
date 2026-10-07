-- B14: retire the separate per-entity ledger (books_native_*, per-entity charts,
-- calendars, project-owner reviews). It was never applied in production; the
-- owner chose (2026-10-07) to make the legal entity a segment of the one Books
-- ledger instead (docs/books-entities.md). Its history files stay; this drops
-- what they created, including the guards they put on ordinary tables.
--
-- Kept: payroll labor ownership (20261004004909, part of payroll posting), the
-- service-only books_exports privileges, and every export behavior that was not
-- the layer: row ids exported as text, journal request resolutions, and invoice
-- quantities as exact decimal text.

drop table if exists public.books_entity_account_definitions cascade;
drop table if exists public.books_entity_accounts cascade;
drop table if exists public.books_entity_calendar_reviews cascade;
drop table if exists public.books_entity_calendar_years cascade;
drop table if exists public.books_entity_chart_reviews cascade;
drop table if exists public.books_entity_chart_versions cascade;
drop table if exists public.books_entity_control_accounts cascade;
drop table if exists public.books_entity_fiscal_periods cascade;
drop table if exists public.books_legacy_entity_proposals cascade;
drop table if exists public.books_legacy_entity_reviews cascade;
drop table if exists public.books_legal_entities cascade;
drop table if exists public.books_legal_entity_access_history cascade;
drop table if exists public.books_legal_entity_members cascade;
drop table if exists public.books_legal_entity_profile_reviews cascade;
drop table if exists public.books_legal_entity_profiles cascade;
drop table if exists public.books_native_adjustment_facts cascade;
drop table if exists public.books_native_adjustment_reviews cascade;
drop table if exists public.books_native_entity_fences cascade;
drop table if exists public.books_native_invoice_correction_proposals cascade;
drop table if exists public.books_native_invoice_correction_reviews cascade;
drop table if exists public.books_native_invoice_income_resolutions cascade;
drop table if exists public.books_native_invoice_income_selections cascade;
drop table if exists public.books_native_invoice_postings cascade;
drop table if exists public.books_native_invoice_request_fences cascade;
drop table if exists public.books_native_invoice_request_resolutions cascade;
drop table if exists public.books_native_journal_entries cascade;
drop table if exists public.books_native_journal_lines cascade;
drop table if exists public.books_native_period_holds cascade;
drop table if exists public.books_project_entity_proposals cascade;
drop table if exists public.books_project_entity_reviews cascade;
drop table if exists public.books_project_owner_request_fences cascade;
drop table if exists public.books_project_owner_request_resolutions cascade;

drop function if exists public.capture_books_export_snapshot_before_journal_resolutions(uuid) cascade;
drop function if exists public.books_entity_has_access(uuid,uuid,uuid,text) cascade;
drop function if exists public.books_entity_immutable() cascade;
drop function if exists public.books_entity_member_guard() cascade;
drop function if exists public.books_entity_member_audit() cascade;
drop function if exists public.books_entity_profile_guard() cascade;
drop function if exists public.books_entity_profile_review_guard() cascade;
drop function if exists public.create_books_legal_entity(uuid,uuid,text,uuid,text) cascade;
drop function if exists public.set_books_legal_entity_member(uuid,uuid,uuid,uuid,text,text) cascade;
drop function if exists public.prepare_books_legal_entity_profile(uuid,uuid,uuid,uuid,uuid,jsonb,text) cascade;
drop function if exists public.review_books_legal_entity_profile(uuid,uuid,uuid,uuid,text) cascade;
drop function if exists public.read_books_legal_entity_setup(uuid,uuid,uuid,uuid,integer) cascade;
drop function if exists public.books_entity_access_sequence() cascade;
drop function if exists public.capture_books_entity_authorized_export(uuid,uuid) cascade;
drop function if exists public.assert_books_entity_export_download(uuid,uuid,uuid) cascade;
drop function if exists public.books_entity_export_proof_guard() cascade;
drop function if exists public.assert_books_legacy_entity_operation(uuid,uuid,uuid,text) cascade;
drop function if exists public.capture_books_legacy_ownership_population(uuid,uuid) cascade;
drop function if exists public.books_legacy_entity_proposal_guard() cascade;
drop function if exists public.books_legacy_entity_review_guard() cascade;
drop function if exists public.prepare_books_legacy_entity_proposal(uuid,uuid,uuid,uuid,uuid,uuid,date,jsonb,text) cascade;
drop function if exists public.review_books_legacy_entity_proposal(uuid,uuid,uuid,uuid,uuid,text) cascade;
drop function if exists public.read_books_legacy_entity_proposal(uuid,uuid,uuid,uuid) cascade;
drop function if exists public.list_books_legacy_entity_proposals(uuid,uuid,uuid,uuid,integer) cascade;
drop function if exists public.list_books_entity_review_options(uuid,uuid,uuid,text,text,uuid,integer) cascade;
drop function if exists public.read_books_entity_setup_access(uuid,uuid,uuid) cascade;
drop function if exists public.capture_books_export_snapshot_before_entity_calendars(uuid) cascade;
drop function if exists public.books_entity_month_boundary(integer,integer,integer,integer) cascade;
drop function if exists public.books_entity_calendar_year_guard() cascade;
drop function if exists public.books_entity_fiscal_period_guard() cascade;
drop function if exists public.books_entity_calendar_complete() cascade;
drop function if exists public.books_entity_calendar_review_guard() cascade;
drop function if exists public.prepare_books_entity_calendar(uuid,uuid,uuid,uuid,uuid,integer,text) cascade;
drop function if exists public.review_books_entity_calendar(uuid,uuid,uuid,uuid,uuid,text) cascade;
drop function if exists public.read_books_entity_calendars(uuid,uuid,uuid,uuid,integer) cascade;
drop function if exists public.capture_books_export_snapshot_before_entity_charts(uuid) cascade;
drop function if exists public.books_validate_entity_chart(jsonb) cascade;
drop function if exists public.books_assert_entity_chart_receipt(uuid) cascade;
drop function if exists public.books_entity_chart_guard() cascade;
drop function if exists public.books_entity_chart_complete() cascade;
drop function if exists public.books_entity_chart_child_guard() cascade;
drop function if exists public.books_entity_chart_review_guard() cascade;
drop function if exists public.prepare_books_entity_chart(uuid,uuid,uuid,uuid,uuid,uuid,date,jsonb,text) cascade;
drop function if exists public.review_books_entity_chart(uuid,uuid,uuid,uuid,uuid,text) cascade;
drop function if exists public.read_books_entity_chart(uuid,uuid,uuid,uuid) cascade;
drop function if exists public.read_books_entity_charts(uuid,uuid,uuid,uuid,integer) cascade;
drop function if exists public.capture_books_export_snapshot_before_project_owners(uuid) cascade;
drop function if exists public.read_books_entity_chart_editor_context(uuid,uuid,uuid,integer,integer) cascade;
drop function if exists public.books_payload_uuid_refs(jsonb) cascade;
drop function if exists public.books_fact_project_refs(uuid,text,uuid,jsonb) cascade;
drop function if exists public.books_assert_project_has_no_ledger_history(uuid,uuid) cascade;
drop function if exists public.books_project_owner_documents(uuid,jsonb) cascade;
drop function if exists public.books_project_entity_proposal_guard() cascade;
drop function if exists public.books_project_entity_review_guard() cascade;
drop function if exists public.prepare_books_project_entity(uuid,uuid,uuid,uuid,uuid,uuid,date,jsonb,text) cascade;
drop function if exists public.review_books_project_entity(uuid,uuid,uuid,uuid,uuid,uuid,text) cascade;
drop function if exists public.books_project_entity_legacy_line_guard() cascade;
drop function if exists public.books_project_entity_legacy_fact_guard() cascade;
drop function if exists public.books_project_entity_legacy_entry_guard() cascade;
drop function if exists public.books_project_entity_source_scope_guard() cascade;
drop function if exists public.books_project_entity_payment_scope_guard() cascade;
drop function if exists public.capture_books_export_snapshot_before_project_owner_resolutions(uuid) cascade;
drop function if exists public.read_books_project_entity_proposal(uuid,uuid,uuid,uuid,uuid,text) cascade;
drop function if exists public.read_books_project_owner_workspace(uuid,uuid,uuid,uuid,uuid,uuid,integer) cascade;
drop function if exists public.books_validate_project_owner_request(text,jsonb,uuid,uuid,uuid,uuid) cascade;
drop function if exists public.books_lock_project_owner_request(text,uuid) cascade;
drop function if exists public.books_lock_project_owner_operation(uuid,uuid,uuid,uuid,text,uuid) cascade;
drop function if exists public.books_project_owner_resolution_guard() cascade;
drop function if exists public.books_project_owner_request_writer_fence() cascade;
drop function if exists public.resolve_books_project_owner_request(uuid,uuid,uuid,uuid,uuid,text,jsonb,text) cascade;
drop function if exists public.capture_books_export_snapshot_before_native_adjustments(uuid) cascade;
drop function if exists public.read_books_native_project_posting_context(uuid,uuid,text,uuid,uuid,date,text) cascade;
drop function if exists public.books_bump_native_entity_fence(uuid,uuid) cascade;
drop function if exists public.books_native_definition_fence() cascade;
drop function if exists public.books_lock_native_adjustment_scope(uuid,uuid,uuid,uuid,text,text,uuid) cascade;
drop function if exists public.books_native_period_hold_guard() cascade;
drop function if exists public.books_assert_native_period_available(uuid,uuid,uuid) cascade;
drop function if exists public.books_validate_native_adjustment_request(uuid,uuid,uuid,uuid,uuid,jsonb) cascade;
drop function if exists public.books_native_adjustment_fact_guard() cascade;
drop function if exists public.books_native_adjustment_review_guard() cascade;
drop function if exists public.books_native_journal_entry_guard() cascade;
drop function if exists public.books_native_journal_line_guard() cascade;
drop function if exists public.books_assert_native_adjustment_complete(uuid,uuid,uuid) cascade;
drop function if exists public.books_native_adjustment_complete() cascade;
drop function if exists public.prepare_books_native_adjustment(uuid,uuid,uuid,uuid,uuid,jsonb,text) cascade;
drop function if exists public.review_books_native_adjustment(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text) cascade;
drop function if exists public.set_books_native_period_hold(uuid,uuid,uuid,uuid,uuid,uuid,text,text) cascade;
drop function if exists public.read_books_native_adjustment(uuid,uuid,uuid,uuid,uuid) cascade;
drop function if exists public.capture_books_export_snapshot_before_native_invoices(uuid) cascade;
drop function if exists public.read_books_native_invoice_economic_context(uuid,uuid,text,uuid,uuid,date) cascade;
drop function if exists arc_private.books_native_economic_fence() cascade;
drop function if exists public.books_native_invoice_leg(jsonb,text,bigint,text,text,jsonb) cascade;
drop function if exists public.books_derive_native_invoice_draft(jsonb) cascade;
drop function if exists public.books_assert_native_closing_settlement(jsonb) cascade;
drop function if exists public.books_validate_native_invoice_posting(uuid,uuid,uuid,uuid,jsonb) cascade;
drop function if exists public.books_native_invoice_posting_guard() cascade;
drop function if exists public.books_assert_native_invoice_complete(uuid,uuid,uuid) cascade;
drop function if exists public.books_native_invoice_complete() cascade;
drop function if exists public.post_books_native_invoice(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,text) cascade;
drop function if exists public.read_books_native_invoice_posting(uuid,uuid,uuid,uuid,uuid) cascade;
drop function if exists public.capture_books_export_snapshot_before_native_invoice_resolutions(uuid) cascade;
drop function if exists public.books_validate_native_invoice_resolution(jsonb,uuid,uuid,uuid,uuid) cascade;
drop function if exists public.books_lock_native_invoice_request(uuid,uuid,uuid,uuid,uuid,uuid) cascade;
drop function if exists public.books_native_invoice_resolution_guard() cascade;
drop function if exists public.books_native_invoice_request_writer_guard() cascade;
drop function if exists public.resolve_books_native_invoice_request(uuid,uuid,uuid,uuid,uuid,jsonb,text) cascade;
drop function if exists public.capture_books_export_snapshot_before_native_invoice_income(uuid) cascade;
drop function if exists public.books_validate_native_invoice_income_request(jsonb,uuid,uuid,uuid,uuid) cascade;
drop function if exists public.books_native_invoice_income_selection_guard() cascade;
drop function if exists public.select_books_native_invoice_income(uuid,uuid,uuid,uuid,jsonb) cascade;
drop function if exists public.books_native_invoice_income_posting_guard() cascade;
drop function if exists public.capture_books_export_snapshot_before_native_income_resolutions(uuid) cascade;
drop function if exists public.books_native_invoice_income_resolution_guard() cascade;
drop function if exists public.books_native_invoice_income_cancellation_guard() cascade;
drop function if exists public.resolve_books_native_invoice_income(uuid,uuid,uuid,uuid,uuid,jsonb,text) cascade;
drop function if exists public.capture_books_export_snapshot_before_native_invoice_corrections(uuid) cascade;
drop function if exists public.books_derive_native_invoice_reversal(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,text) cascade;
drop function if exists public.books_validate_native_invoice_correction_request(jsonb,uuid,uuid,uuid,uuid) cascade;
drop function if exists public.books_native_invoice_correction_proposal_guard() cascade;
drop function if exists public.prepare_books_native_invoice_correction(uuid,uuid,uuid,uuid,jsonb) cascade;
drop function if exists public.capture_books_export_snapshot_before_exact_invoice_quantity(uuid) cascade;
drop function if exists public.capture_books_legacy_ownership_before_exact_invoice_quantity(uuid,uuid) cascade;
drop function if exists public.books_derive_native_invoice_replacement_draft(jsonb,uuid) cascade;
drop function if exists public.books_derive_native_invoice_correction_pair(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text) cascade;
drop function if exists public.capture_books_export_snapshot_before_invoice_correction_reviews(uuid) cascade;
drop function if exists public.books_native_invoice_correction_review_guard() cascade;
drop function if exists public.review_books_native_invoice_correction(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text) cascade;
drop function if exists public.capture_books_legacy_ownership_evidence(uuid,uuid) cascade;

drop index if exists public.books_projects_org_identity_idx;
drop index if exists public.books_native_company_identity;
drop index if exists public.books_native_cost_code_identity;
drop index if exists public.books_native_invoice_identity;
drop index if exists public.books_native_bill_identity;
drop index if exists public.books_native_expense_identity;

-- One complete export capture in one database snapshot.
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
    'books_payroll_posting_proposals',
    'books_payroll_postings',
    'books_payroll_labor_ownership',
    'books_payroll_correction_sources',
    'books_payroll_correction_proposals',
    'books_payroll_correction_postings',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
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
    'books_journal_request_resolutions',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg((to_jsonb(t) || jsonb_build_object(''id'', t.id::text)) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  -- Exact decimal quantities, so restore never round-trips them through a float.
  select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('id', r.id::text, 'quantity', to_jsonb(r)->>'quantity') order by r.id), '[]'::jsonb)
    into v_rows from public.invoice_lines r where r.org_id = p_org_id;
  v_tables := jsonb_set(v_tables, '{invoice_lines}', v_rows);
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
