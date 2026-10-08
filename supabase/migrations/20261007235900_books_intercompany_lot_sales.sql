-- B14.3/B14.4: a land company sells a lot to an affiliated building company's home.
--
-- The seller (the company that holds the lot's land basis) records the sale: it
-- earns the price and relieves the lot's cost. The buyer's home takes the lot into
-- construction at the price. Posting adds the due-from / due-to pair between them.
-- This replaces the ordinary start transfer for that lot (same posting key), so a
-- lot enters a house once.
--
-- Consolidated statements eliminate the sale: the seller's revenue and cost of the
-- lot (tagged intercompany_eliminate) and the due-from / due-to pair are removed,
-- and the profit the seller made stays out of the home's inventory until the home
-- sells to an outside buyer (computed from this register; nothing is posted to
-- either company's books).

create table public.books_intercompany_sales (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  lot_id uuid not null,
  buyer_project_id uuid not null,
  seller_entity_id uuid not null,
  buyer_entity_id uuid not null,
  sale_date date not null,
  price_cents bigint not null check (price_cents > 0),
  cost_cents bigint not null check (cost_cents > 0),
  evidence_url text not null check (evidence_url like 'https://%'),
  journal_entry_id uuid not null references public.journal_entries(id) on delete restrict,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint books_intercompany_sales_parties_check check (seller_entity_id <> buyer_entity_id),
  constraint books_intercompany_sales_lot_fkey foreign key (lot_id) references public.lots(id) on delete restrict,
  constraint books_intercompany_sales_project_fkey foreign key (buyer_project_id) references public.projects(id) on delete restrict,
  constraint books_intercompany_sales_seller_fkey foreign key (org_id, seller_entity_id) references public.books_legal_entities(org_id, id),
  constraint books_intercompany_sales_buyer_fkey foreign key (org_id, buyer_entity_id) references public.books_legal_entities(org_id, id),
  unique (org_id, lot_id)
);
create index books_intercompany_sales_project_idx on public.books_intercompany_sales (org_id, buyer_project_id);
create index books_intercompany_sales_lot_idx on public.books_intercompany_sales (lot_id);
create index books_intercompany_sales_buyer_project_fk_idx on public.books_intercompany_sales (buyer_project_id);
create index books_intercompany_sales_seller_idx on public.books_intercompany_sales (org_id, seller_entity_id);
create index books_intercompany_sales_buyer_idx on public.books_intercompany_sales (org_id, buyer_entity_id);
create index books_intercompany_sales_entry_idx on public.books_intercompany_sales (journal_entry_id);
create index books_intercompany_sales_created_by_idx on public.books_intercompany_sales (created_by) where created_by is not null;
alter table public.books_intercompany_sales enable row level security;
create policy books_intercompany_sales_read on public.books_intercompany_sales
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_intercompany_sales to authenticated;

create or replace function public.books_guard_intercompany_sale()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'An intercompany sale is kept as recorded; correct it with a new posting';
end;
$$;
revoke all on function public.books_guard_intercompany_sale() from public, anon, authenticated;
create trigger books_intercompany_sales_guard before update or delete on public.books_intercompany_sales
  for each row execute function public.books_guard_intercompany_sale();

create or replace function public.sell_books_lot_to_affiliate(p_org_id uuid, p_lot_id uuid, p_date date, p_price_cents bigint, p_evidence_url text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_lot public.lots%rowtype; v_land uuid; v_cip uuid; v_revenue uuid; v_cogs uuid; v_cost bigint; v_seller uuid; v_buyer uuid; v_policy integer;
  v_entry uuid; v_sale uuid := gen_random_uuid(); v_key text; v_dims jsonb; v_existing public.books_intercompany_sales%rowtype; v_holders bigint;
begin
  if p_price_cents is null or p_price_cents <= 0 or p_evidence_url not like 'https://%' then raise exception 'A sale price and supporting evidence are required'; end if;
  select * into v_lot from public.lots where org_id = p_org_id and id = p_lot_id for update;
  if not found then raise exception 'Lot not found'; end if;
  select * into v_existing from public.books_intercompany_sales where org_id = p_org_id and lot_id = p_lot_id;
  if found then
    if v_existing.sale_date <> p_date or v_existing.price_cents <> p_price_cents then raise exception 'This lot was already sold to its home on different terms'; end if;
    return jsonb_build_object('status', 'posted', 'saleId', v_existing.id, 'journalEntryId', v_existing.journal_entry_id);
  end if;
  if v_lot.books_acquisition_entry_id is null then raise exception 'The lot has no recorded land basis'; end if;
  if v_lot.project_id is null then raise exception 'Assign the lot to the home it is sold to'; end if;
  perform 1 from public.project_financial_settings where org_id = p_org_id and project_id = v_lot.project_id and books_inventory_enabled and books_inventory_effective_on <= p_date
    and books_inventory_completed_on is null and books_inventory_sold_on is null for update;
  if not found then raise exception 'The buying home must hold owned inventory before the lot is sold to it'; end if;
  v_key := 'inventory_start:' || v_lot.id;
  if exists(select 1 from public.journal_entries where org_id = p_org_id and posting_key = v_key and status = 'posted') then raise exception 'The lot is already in a home'; end if;
  select id into v_land from public.gl_accounts where org_id = p_org_id and code = '1120' and active;
  select id into v_cip from public.gl_accounts where org_id = p_org_id and code = '1160' and active;
  select id into v_revenue from public.gl_accounts where org_id = p_org_id and code = '4000' and active;
  select id into v_cogs from public.gl_accounts where org_id = p_org_id and code = '5000' and active;
  if v_land is null or v_cip is null or v_revenue is null or v_cogs is null then raise exception 'Inventory, revenue or cost accounts are missing'; end if;
  -- The seller is whoever holds the lot's land basis.
  select coalesce(sum(l.debit_cents - l.credit_cents), 0), (array_agg(distinct l.legal_entity_id))[1], count(distinct l.legal_entity_id)
    into v_cost, v_seller, v_holders
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    where l.org_id = p_org_id and l.account_id = v_land and l.dimensions ->> 'lot_id' = v_lot.id::text and e.status in ('posted','reversed') and e.entry_date <= p_date;
  if v_cost <= 0 then raise exception 'The lot has no positive land basis at the sale date'; end if;
  if v_holders <> 1 then raise exception 'The lot''s land basis is split between companies; review it before selling the lot'; end if;
  v_buyer := coalesce((select legal_entity_id from public.projects where org_id = p_org_id and id = v_lot.project_id), public.books_primary_entity(p_org_id));
  if v_seller = v_buyer then raise exception 'The home belongs to the company that holds the lot; move the lot into the home instead of selling it'; end if;
  select active_policy_version into v_policy from public.books_settings where org_id = p_org_id;
  v_dims := jsonb_build_object('lot_id', v_lot.id, 'community_id', v_lot.community_id, 'division_id', v_lot.division_id, 'intercompany_sale_id', v_sale);
  v_entry := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', p_date, 'entry_kind', 'adjusting', 'memo', 'Lot sold to an affiliated company',
    'posting_key', v_key, 'projection_version', 1, 'policy_version', v_policy, 'source_type', 'inventory_start', 'source_id', v_lot.id, 'created_by', p_actor_id),
    jsonb_build_array(
      jsonb_build_object('line_no', 1, 'account_id', v_cip, 'project_id', v_lot.project_id, 'debit_cents', p_price_cents, 'credit_cents', 0, 'dimensions', v_dims),
      jsonb_build_object('line_no', 2, 'account_id', v_land, 'legal_entity_id', v_seller, 'debit_cents', 0, 'credit_cents', v_cost, 'dimensions', v_dims),
      jsonb_build_object('line_no', 3, 'account_id', v_cogs, 'legal_entity_id', v_seller, 'debit_cents', v_cost, 'credit_cents', 0, 'dimensions', v_dims || jsonb_build_object('intercompany_eliminate', true)),
      jsonb_build_object('line_no', 4, 'account_id', v_revenue, 'legal_entity_id', v_seller, 'debit_cents', 0, 'credit_cents', p_price_cents, 'dimensions', v_dims || jsonb_build_object('intercompany_eliminate', true))));
  insert into public.job_cost_entries(org_id, project_id, source_type, source_id, incurred_on, cost_cents, status, is_billable, metadata)
    values (p_org_id, v_lot.project_id, 'inventory_event', v_entry, p_date, p_price_cents, 'posted', false, jsonb_build_object('lot_id', v_lot.id, 'journal_entry_id', v_entry, 'intercompany_sale_id', v_sale));
  insert into public.books_intercompany_sales(id, org_id, lot_id, buyer_project_id, seller_entity_id, buyer_entity_id, sale_date, price_cents, cost_cents, evidence_url, journal_entry_id, created_by)
    values (v_sale, p_org_id, v_lot.id, v_lot.project_id, v_seller, v_buyer, p_date, p_price_cents, v_cost, p_evidence_url, v_entry, p_actor_id);
  return jsonb_build_object('status', 'posted', 'saleId', v_sale, 'journalEntryId', v_entry, 'costCents', v_cost);
end;
$$;
revoke all on function public.sell_books_lot_to_affiliate(uuid,uuid,date,bigint,text,uuid) from public, anon, authenticated;
grant execute on function public.sell_books_lot_to_affiliate(uuid,uuid,date,bigint,text,uuid) to service_role;

-- The export carries the companies every journal line belongs to and the
-- intercompany sales register consolidation reads.
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

-- The intercompany reconciliation: for each company and each affiliate, what it
-- is owed (1180) and what it owes (2180) on the ledger as of a date. A's net
-- position with B must equal B's opposite position with A.
create or replace function public.books_intercompany_positions(p_org_id uuid, p_as_of date)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('entityId', owner, 'counterpartyId', counterparty, 'dueFromCents', due_from, 'dueToCents', due_to) order by owner, counterparty), '[]'::jsonb)
  from (
    select l.legal_entity_id as owner, (l.dimensions ->> 'counterparty_entity_id')::uuid as counterparty,
      coalesce(sum(l.debit_cents - l.credit_cents) filter (where a.code = '1180'), 0)::bigint as due_from,
      coalesce(sum(l.credit_cents - l.debit_cents) filter (where a.code = '2180'), 0)::bigint as due_to
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = p_org_id and e.status in ('posted','reversed') and e.entry_date <= p_as_of
      and l.dimensions ->> 'intercompany' = 'true' and a.code in ('1180','2180')
    group by 1, 2
  ) positions;
$$;
revoke all on function public.books_intercompany_positions(uuid, date) from public, anon, authenticated;
grant execute on function public.books_intercompany_positions(uuid, date) to service_role;
