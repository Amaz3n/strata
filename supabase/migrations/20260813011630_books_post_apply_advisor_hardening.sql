-- Follow-up to the sole-ledger release train. Keep authenticated access read-only
-- and org-scoped without the deprecated auth.role() policy branch; service_role
-- bypasses RLS and remains the only mutation boundary.

begin;

drop policy if exists invoice_deliveries_access on public.invoice_deliveries;
create policy invoice_deliveries_access
  on public.invoice_deliveries
  for select
  to authenticated
  using (public.is_org_member(org_id));

drop policy if exists invoice_approval_requests_access on public.invoice_approval_requests;
create policy invoice_approval_requests_access
  on public.invoice_approval_requests
  for select
  to authenticated
  using (public.is_org_member(org_id));

-- Cover every new foreign key so parent deletes/updates do not require a full
-- child-table scan. Existing org-first operational indexes remain unchanged.
create index if not exists books_debt_events_created_by_idx
  on public.books_debt_events (created_by);
create index if not exists books_debt_instruments_cash_account_idx
  on public.books_debt_instruments (cash_account_id);
create index if not exists books_debt_instruments_created_by_idx
  on public.books_debt_instruments (created_by);
create index if not exists books_debt_instruments_interest_expense_account_idx
  on public.books_debt_instruments (interest_expense_account_id);
create index if not exists books_debt_instruments_lender_company_idx
  on public.books_debt_instruments (lender_company_id);
create index if not exists books_debt_instruments_liability_account_idx
  on public.books_debt_instruments (liability_account_id);

create index if not exists books_fixed_asset_events_created_by_idx
  on public.books_fixed_asset_events (created_by);
create index if not exists books_fixed_assets_accum_depreciation_account_idx
  on public.books_fixed_assets (accumulated_depreciation_account_id);
create index if not exists books_fixed_assets_asset_account_idx
  on public.books_fixed_assets (asset_account_id);
create index if not exists books_fixed_assets_created_by_idx
  on public.books_fixed_assets (created_by);
create index if not exists books_fixed_assets_depreciation_expense_account_idx
  on public.books_fixed_assets (depreciation_expense_account_id);
create index if not exists books_fixed_assets_funding_account_idx
  on public.books_fixed_assets (funding_account_id);
create index if not exists books_fixed_assets_project_idx
  on public.books_fixed_assets (project_id);

create index if not exists books_journal_proposals_journal_entry_idx
  on public.books_journal_proposals (journal_entry_id);
create index if not exists books_journal_proposals_proposed_by_idx
  on public.books_journal_proposals (proposed_by);
create index if not exists books_journal_proposals_reversal_entry_idx
  on public.books_journal_proposals (reversal_entry_id);
create index if not exists books_journal_proposals_reviewed_by_idx
  on public.books_journal_proposals (reviewed_by);

create index if not exists books_tax_filings_created_by_idx
  on public.books_tax_filings (created_by);
create index if not exists books_tax_filings_evidence_file_idx
  on public.books_tax_filings (evidence_file_id);
create index if not exists books_tax_filings_filed_by_idx
  on public.books_tax_filings (filed_by);
create index if not exists books_tax_filings_jurisdiction_idx
  on public.books_tax_filings (jurisdiction_id);
create index if not exists books_tax_jurisdictions_created_by_idx
  on public.books_tax_jurisdictions (created_by);

create index if not exists invoice_approval_requests_decided_by_idx
  on public.invoice_approval_requests (decided_by);
create index if not exists invoice_approval_requests_invoice_idx
  on public.invoice_approval_requests (invoice_id);
create index if not exists invoice_approval_requests_requested_by_idx
  on public.invoice_approval_requests (requested_by);
create index if not exists invoice_deliveries_invoice_idx
  on public.invoice_deliveries (invoice_id);
create index if not exists payment_launch_gate_attestations_attested_by_idx
  on public.payment_launch_gate_attestations (attested_by);
create index if not exists tax_identity_refs_company_idx
  on public.tax_identity_refs (company_id);

commit;
