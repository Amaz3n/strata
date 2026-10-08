-- Books export schema 34: the accounting records added since schema 33 (revenue
-- policies, development, cost and WIP allocations, inventory impairments, bank
-- offsets and their lines, 1099 packages) are captured in the same snapshot. The
-- payer TIN's Vault pointer is left out: an ordinary archive carries last fours only.
-- Bank feed connections are archived without their credential reference or cursor.
begin;

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
    'books_legal_entities',
    'books_intercompany_sales',
    'books_revenue_policies',
    'books_development_allocations',
    'books_cost_allocations',
    'books_wip_cost_allocations',
    'books_inventory_impairments',
    'books_bank_offsets',
    'books_1099_packages',
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
  -- Bank offset lines have no id of their own; their content orders them.
  select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text), '[]'::jsonb)
    into v_rows from public.books_bank_offset_lines r where r.org_id = p_org_id;
  v_tables := v_tables || jsonb_build_object('books_bank_offset_lines', v_rows);
  -- Bank feed connections carry no credential or sync cursor into an archive; a
  -- restore brings each back disconnected, to be reconnected by its owner.
  select coalesce(jsonb_agg((to_jsonb(r) - 'secret_ref' - 'cursor') || jsonb_build_object('id', r.id::text) order by r.id), '[]'::jsonb)
    into v_rows from public.bank_feed_connections r where r.org_id = p_org_id;
  v_tables := v_tables || jsonb_build_object('bank_feed_connections', v_rows);
  -- A company's payer TIN lives in Vault; the archive keeps its last four only, so
  -- an ordinary export never carries a pointer to a secret.
  select coalesce(jsonb_agg((to_jsonb(r) - 'payer_tin_secret_id') || jsonb_build_object('id', r.id::text) order by r.id), '[]'::jsonb)
    into v_rows from public.books_legal_entities r where r.org_id = p_org_id;
  v_tables := jsonb_set(v_tables, '{books_legal_entities}', v_rows);
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

commit;
