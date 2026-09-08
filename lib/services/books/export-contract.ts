import { booksDigest } from "@/lib/services/books/hash";

export const EXPORT_TABLES = [
  "closings", "closing_checklist_items", "lot_takedowns", "lot_reservations",
  "budgets", "budget_lines", "commitments", "commitment_lines",
  "change_orders", "file_links",
  "project_financial_settings", "divisions", "communities", "community_phases", "lots",
  "contracts", "cost_codes", "time_entries",
  "warranty_requests", "warranty_service_visits", "warranty_backcharges",
  "org_funding_sources", "disbursements", "payment_runs", "payment_run_items",
  "receivable_adjustments",
  "books_deposit_batches",
  "books_deposit_batch_items",
  "receivable_payment_groups",
  "receivable_payment_group_items",
  "books_overhead_budgets",
  "books_overhead_budget_lines",
  "books_settings",
  "accounting_policies",
  "accounting_account_mappings",
  "gl_accounts",
  "accounting_facts",
  "journal_entries",
  "journal_lines",
  "accounting_periods",
  "accounting_reconciliation_runs",
  "accounting_reconciliation_items",
  "poc_snapshots",
  "books_comparison_runs",
  "books_comparison_items",
  "opening_balance_batches",
  "opening_balance_lines",
  "opening_balance_approvals",
  "bank_accounts",
  "bank_transactions",
  "bank_transaction_revisions",
  "bank_transaction_matches",
  "bank_reconciliations",
  "bank_reconciliation_items",
  "bank_rules",
  "coding_rules",
  "books_debt_instruments",
  "books_debt_events",
  "books_fixed_assets",
  "books_fixed_asset_events",
  "books_tax_jurisdictions",
  "books_tax_filings",
  "books_greenfield_launches",
  "books_journal_proposals",
  "books_cutover_runs",
  "books_cutover_approvals",
  "books_close_items",
  "recurring_posting_templates",
  "recurring_posting_lines",
  "financial_statement_snapshots",
  "tax_policy_versions",
  "companies",
  "contacts",
  "projects",
  "invoices",
  "invoice_lines",
  "payments",
  "payment_allocations",
  "payment_reversals",
  "vendor_bills",
  "bill_lines",
  "project_expenses",
  "project_expense_lines",
  "job_cost_entries",
  "billable_costs",
  "retainage",
  "files",
  "audit_log",
] as const;

export function verifyBooksExportBundle(bundle: {
  tables: Record<string, Record<string, unknown>[]>;
  manifest?: { schemaVersion: number; orgId: string; tables: Record<string, { rows: number; checksum?: string }> };
}) {
  const entries = bundle.tables.journal_entries ?? [];
  const postedEntryIds = new Set(
    entries
      .filter((entry) => ["posted", "reversed"].includes(String(entry.status)))
      .map((entry) => String(entry.id)),
  );
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const line of bundle.tables.journal_lines ?? []) {
    const entryId = String(line.entry_id);
    if (!postedEntryIds.has(entryId)) continue;
    const current = totals.get(entryId) ?? { debit: 0, credit: 0 };
    current.debit += Number(line.debit_cents ?? 0);
    current.credit += Number(line.credit_cents ?? 0);
    totals.set(entryId, current);
  }
  const unbalancedEntryIds = Array.from(totals.entries())
    .filter(([, total]) => total.debit <= 0 || total.debit !== total.credit)
    .map(([entryId]) => entryId);
  const missingLineEntryIds = Array.from(postedEntryIds).filter(
    (entryId) => !totals.has(entryId),
  );
  const integrityErrors: string[] = [];
  if (bundle.manifest?.schemaVersion === 2) {
    for (const table of EXPORT_TABLES) {
      const rows = bundle.tables[table];
      const expected = bundle.manifest.tables[table];
      if (!rows || !expected) { integrityErrors.push(`Missing table ${table}`); continue; }
      if (rows.length !== expected.rows || booksDigest(rows) !== expected.checksum) integrityErrors.push(`Checksum or row count differs for ${table}`);
      const ids = rows.map((row) => row.id).filter(Boolean);
      if (new Set(ids).size !== ids.length) integrityErrors.push(`Duplicate IDs in ${table}`);
      if (rows.some((row) => row.org_id !== bundle.manifest?.orgId)) integrityErrors.push(`Organization mismatch in ${table}`);
    }
    const references = [
      ["closings", "closing_invoice_id", "invoices"], ["closings", "lot_id", "lots"], ["closings", "project_id", "projects"],
      ["closing_checklist_items", "closing_id", "closings"],
      ["budget_lines", "budget_id", "budgets"], ["commitment_lines", "commitment_id", "commitments"],
      ["file_links", "file_id", "files"],
      ["project_financial_settings", "project_id", "projects"],
      ["lots", "project_id", "projects"], ["lots", "community_id", "communities"],
      ["warranty_service_visits", "request_id", "warranty_requests"],
      ["warranty_service_visits", "books_cost_journal_entry_id", "journal_entries"],
      ["time_entries", "project_id", "projects"],
      ["opening_balance_lines", "operational_payment_id", "payments"],
      ["journal_lines", "entry_id", "journal_entries"], ["journal_lines", "account_id", "gl_accounts"],
      ["journal_entries", "fact_id", "accounting_facts"], ["journal_entries", "reversal_of_entry_id", "journal_entries"],
      ["invoice_lines", "invoice_id", "invoices"], ["invoices", "project_id", "projects"],
      ["payments", "invoice_id", "invoices"], ["payments", "bill_id", "vendor_bills"],
      ["bill_lines", "bill_id", "vendor_bills"], ["vendor_bills", "company_id", "companies"],
      ["receivable_adjustments", "invoice_id", "invoices"],
      ["bank_transaction_matches", "journal_line_id", "journal_lines"], ["bank_transaction_matches", "bank_transaction_id", "bank_transactions"],
      ["bank_transactions", "bank_account_id", "bank_accounts"],
      ["bank_reconciliation_items", "reconciliation_id", "bank_reconciliations"],
      ["books_deposit_batch_items", "batch_id", "books_deposit_batches"], ["books_deposit_batch_items", "payment_id", "payments"],
      ["books_deposit_batches", "journal_entry_id", "journal_entries"], ["books_deposit_batches", "bank_transaction_id", "bank_transactions"],
      ["receivable_payment_group_items", "group_id", "receivable_payment_groups"], ["receivable_payment_group_items", "payment_id", "payments"],
      ["books_overhead_budget_lines", "budget_id", "books_overhead_budgets"], ["books_overhead_budget_lines", "account_id", "gl_accounts"],
      ["books_debt_events", "instrument_id", "books_debt_instruments"], ["books_fixed_asset_events", "asset_id", "books_fixed_assets"],
      ["opening_balance_lines", "batch_id", "opening_balance_batches"], ["recurring_posting_lines", "template_id", "recurring_posting_templates"],
    ];
    for (const [child, column, parent] of references) {
      const parents = new Set((bundle.tables[parent] ?? []).map((row) => row.id));
      for (const row of bundle.tables[child] ?? []) if (row[column] != null && !parents.has(row[column])) integrityErrors.push(`Missing ${parent} for ${child}.${column}:${String(row.id)}`);
    }
  } else if (bundle.manifest) integrityErrors.push(`Unsupported export schema version ${bundle.manifest.schemaVersion}`);
  return {
    valid: unbalancedEntryIds.length === 0 && missingLineEntryIds.length === 0 && integrityErrors.length === 0,
    integrityErrors,
    postedEntryCount: postedEntryIds.size,
    unbalancedEntryIds,
    missingLineEntryIds,
  };
}
