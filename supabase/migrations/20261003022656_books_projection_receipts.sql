create table public.books_projection_receipts (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id) on delete cascade,
 source_type text not null,
 source_id uuid not null,
 source_observed_at timestamptz not null,
 fact_id uuid not null references public.accounting_facts(id),
 journal_id uuid not null references public.journal_entries(id),
 checked_at timestamptz not null default now(),
 unique(org_id,source_type,source_id)
);
alter table public.books_projection_receipts enable row level security;
revoke all on public.books_projection_receipts from anon,authenticated;
grant select,insert,update,delete on public.books_projection_receipts to service_role;

create or replace function public.record_books_projection_receipt(p_org_id uuid,p_source_type text,p_source_id uuid,p_source_observed_at timestamptz,p_fact_id uuid,p_journal_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_source_observed_at is null then raise exception 'Source observation timestamp is required'; end if;
 perform 1 from public.accounting_facts f join public.journal_entries j on j.fact_id=f.id and j.org_id=f.org_id
 where f.org_id=p_org_id and f.id=p_fact_id and f.source_type=p_source_type and f.source_id=p_source_id
 and j.id=p_journal_id and j.status='posted' for share of j;
 if not found then raise exception 'Projection receipt requires a posted journal for this source and organization'; end if;
 insert into public.books_projection_receipts(org_id,source_type,source_id,source_observed_at,fact_id,journal_id)
 values(p_org_id,p_source_type,p_source_id,p_source_observed_at,p_fact_id,p_journal_id)
 on conflict(org_id,source_type,source_id) do update set source_observed_at=excluded.source_observed_at,
 fact_id=excluded.fact_id,journal_id=excluded.journal_id,checked_at=clock_timestamp()
 where books_projection_receipts.source_observed_at<=excluded.source_observed_at;
end;
$$;
revoke all on function public.record_books_projection_receipt(uuid,text,uuid,timestamptz,uuid,uuid) from public,anon,authenticated;
grant execute on function public.record_books_projection_receipt(uuid,text,uuid,timestamptz,uuid,uuid) to service_role;

-- STABLE is essential: every table SELECT uses the calling query's MVCC snapshot.
-- Never accept caller-controlled table names or expose this RPC to browser roles.
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
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
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
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
