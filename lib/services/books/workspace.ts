import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireAuthorization } from "@/lib/services/authorization";
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
} from "@/lib/services/books/statements";
import { requireOrgContext } from "@/lib/services/context";
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module";
import { getUserPermissions } from "@/lib/services/permissions";

/** How many unresolved reconciliation findings the workspace renders at once. */
const RECONCILIATION_ITEM_CAP = 100;

export type BooksWorkspaceSection =
  | "overview"
  | "statements"
  | "transactions"
  | "banking"
  | "chart"
  | "ledger"
  | "close"
  | "opening-balances"
  | "accountant"
  | "cutover";

async function queryForSection<T>(enabled: boolean, query: PromiseLike<T>) {
  if (enabled) return query;
  return { data: [], error: null, count: 0 } as T;
}

function monthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

export async function getBooksWorkspace(
  orgId?: string,
  section: BooksWorkspaceSection = "overview",
) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "books.read",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books",
    resourceId: context.orgId,
    logDecision: false,
  });
  await requireBooksWorkspaceEnabled(context.orgId);
  const service = createServiceSupabaseClient();
  const asOf = new Date().toISOString().slice(0, 10);
  const { data: settings, error: settingsError } = await service
    .from("books_settings")
    .select("*")
    .eq("org_id", context.orgId)
    .maybeSingle();
  if (settingsError)
    throw new Error(`Failed to load Arc Books: ${settingsError.message}`);
  if (!settings?.workspace_enabled)
    throw new Error(
      "Arc Books is disabled. Enable it in Settings → Accounting.",
    );

  const needsAccounts = new Set([
    "overview",
    "banking",
    "transactions",
    "chart",
    "ledger",
    "opening-balances",
  ]).has(section);
  const needsBanking = new Set(["overview", "transactions", "banking"]).has(
    section,
  );
  const needsClose = section === "close";
  const needsCutover = section === "cutover";
  const needsAccountant = section === "accountant";
  const needsStatements = section === "overview";

  const [
    accounts,
    periods,
    journals,
    bankAccounts,
    bankTransactions,
    bankReconciliations,
    comparisons,
    reconciliations,
    reconciliationItems,
    accountingConnections,
    exports,
    accountantPackages,
    openingBatches,
    cutovers,
    closeItems,
    trialBalance,
    profitLoss,
    balanceSheet,
  ] = await Promise.all([
    queryForSection(
      needsAccounts,
      service
        .from("gl_accounts")
        .select(
          "id, code, name, description, account_type, subtype, normal_balance, cash_flow_category, active, is_system",
        )
        .eq("org_id", context.orgId)
        .order("code"),
    ),
    queryForSection(
      needsClose || needsCutover,
      service
        .from("accounting_periods")
        .select(
          "id, period_start, period_end, fiscal_year, fiscal_period, status, closed_at, reopened_at, close_digest",
        )
        .eq("org_id", context.orgId)
        .order("period_end", { ascending: false })
        .limit(24),
    ),
    queryForSection(
      false,
      service
        .from("journal_entries")
        .select(
          "id, entry_date, entry_kind, status, memo, posting_key, posted_at, source_type, source_id",
        )
        .eq("org_id", context.orgId)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(100),
    ),
    queryForSection(
      needsBanking,
      service
        .from("bank_accounts")
        .select(
          "id, name, official_name, mask, account_type, account_subtype, gl_account_id, current_balance_cents, available_balance_cents, balance_as_of, active, last_reconciled_on, connection:bank_feed_connections(institution_name,status,last_refresh_at,last_error)",
        )
        .eq("org_id", context.orgId)
        .eq("active", true)
        .order("name"),
    ),
    queryForSection(
      needsBanking,
      service
        .from("bank_transactions")
        .select(
          "id, bank_account_id, transaction_date, amount_cents, direction, merchant_name, description, lifecycle_status, excluded, matches:bank_transaction_matches(id,status,matched_amount_cents,match_type)",
        )
        .eq("org_id", context.orgId)
        .eq("lifecycle_status", "posted")
        .eq("excluded", false)
        .order("transaction_date", { ascending: false })
        .limit(251),
    ),
    queryForSection(
      section === "banking",
      service
        .from("bank_reconciliations")
        .select(
          "id, bank_account_id, statement_start, statement_end, beginning_balance_cents, ending_balance_cents, cleared_balance_cents, difference_cents, status, closed_at",
        )
        .eq("org_id", context.orgId)
        .order("statement_end", { ascending: false })
        .limit(24),
    ),
    queryForSection(
      needsCutover,
      service
        .from("books_comparison_runs")
        .select(
          "id, period_id, status, variance_count, unexplained_variance_count, completed_at, approved_at, items:books_comparison_items(id, account_id, difference_cents, variance_reason, explanation, status)",
        )
        .eq("org_id", context.orgId)
        .order("completed_at", { ascending: false })
        .limit(12),
    ),
    queryForSection(
      needsStatements,
      service
        .from("accounting_reconciliation_runs")
        .select("id, run_date, status, discrepancy_count, completed_at")
        .eq("org_id", context.orgId)
        .order("created_at", { ascending: false })
        .limit(12),
    ),
    // The unresolved findings themselves, not just the run that observed them:
    // these are what the blocking `accounting_drift` close check counts, so the
    // person closing the period has to be able to see and dispose of them.
    queryForSection(
      needsClose,
      service
        .from("accounting_reconciliation_items")
        .select(
          "id, category, entity_type, entity_id, local_amount_cents, external_amount_cents, difference_cents, status, details, created_at",
          { count: "exact" },
        )
        .eq("org_id", context.orgId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(RECONCILIATION_ITEM_CAP),
    ),
    queryForSection(
      needsCutover,
      service
        .from("accounting_connections")
        .select("id, provider, display_name:label, status, last_sync_at")
        .eq("org_id", context.orgId)
        .order("created_at", { ascending: false }),
    ),
    queryForSection(
      needsAccountant,
      service
        .from("books_exports")
        .select(
          "id, export_type, status, content_hash, requested_at, downloaded_at, completed_at, expires_at",
        )
        .eq("org_id", context.orgId)
        .order("requested_at", { ascending: false })
        .limit(12),
    ),
    queryForSection(
      needsAccountant,
      service
        .from("accountant_packages")
        .select(
          "id, period_id, tax_year, status, content_hash, manifest, requested_at, completed_at",
        )
        .eq("org_id", context.orgId)
        .order("requested_at", { ascending: false })
        .limit(12),
    ),
    queryForSection(
      section === "opening-balances",
      service
        .from("opening_balance_batches")
        .select(
          "id, cutover_date, status, debit_total_cents, credit_total_cents, source_filename, digest, created_at",
        )
        .eq("org_id", context.orgId)
        .order("created_at", { ascending: false })
        .limit(10),
    ),
    queryForSection(
      needsCutover,
      service
        .from("books_cutover_runs")
        .select(
          "id, cutover_date, target_posture, status, blockers, digest, rollback_deadline, completed_at",
        )
        .eq("org_id", context.orgId)
        .order("created_at", { ascending: false })
        .limit(10),
    ),
    queryForSection(
      needsClose || needsStatements,
      service
        .from("books_close_items")
        .select(
          "id, period_id, code, label, category, blocking, status, issue_count, evidence, updated_at",
        )
        .eq("org_id", context.orgId)
        .order("category")
        .order("label"),
    ),
    needsStatements
      ? buildTrialBalance(context.orgId, asOf)
      : Promise.resolve(null),
    needsStatements
      ? buildProfitAndLoss(context.orgId, monthStart(), asOf)
      : Promise.resolve(null),
    needsStatements
      ? buildBalanceSheet(context.orgId, asOf)
      : Promise.resolve(null),
  ]);
  const queryErrors = [
    accounts.error,
    periods.error,
    journals.error,
    bankAccounts.error,
    bankTransactions.error,
    bankReconciliations.error,
    comparisons.error,
    reconciliations.error,
    reconciliationItems.error,
    accountingConnections.error,
    exports.error,
    accountantPackages.error,
    openingBatches.error,
    cutovers.error,
    closeItems.error,
  ].filter(Boolean);
  if (queryErrors.length > 0)
    throw new Error(
      `Failed to load Books workspace: ${queryErrors[0]?.message}`,
    );
  const unmatchedTransactions = (bankTransactions.data ?? []).filter(
    (transaction) => {
      const matches = Array.isArray(transaction.matches)
        ? transaction.matches
        : [];
      const matched = matches
        .filter((match) => match.status === "confirmed")
        .reduce(
          (sum, match) => sum + Number(match.matched_amount_cents ?? 0),
          0,
        );
      return matched < Number(transaction.amount_cents ?? 0);
    },
  );
  const bankTransactionsTruncated = (bankTransactions.data ?? []).length > 250;
  const visibleBankTransactions = (bankTransactions.data ?? []).slice(0, 250);
  const visibleTransactionIds = new Set(
    visibleBankTransactions.map((transaction) => transaction.id),
  );
  const permissions = await getUserPermissions(context.userId, context.orgId);
  const permissionSet = new Set(permissions);
  const allowed = (permission: string) =>
    permissionSet.has("*") ||
    permissionSet.has("org.admin") ||
    permissionSet.has(permission);
  return {
    initialized: true as const,
    orgId: context.orgId,
    asOf,
    settings,
    accounts: accounts.data ?? [],
    periods: periods.data ?? [],
    journals: journals.data ?? [],
    bankAccounts: bankAccounts.data ?? [],
    bankTransactions: visibleBankTransactions,
    bankReconciliations: bankReconciliations.data ?? [],
    unmatchedTransactions: unmatchedTransactions.filter((transaction) =>
      visibleTransactionIds.has(transaction.id),
    ),
    bankTransactionsTruncated,
    comparisons: comparisons.data ?? [],
    reconciliations: reconciliations.data ?? [],
    reconciliationItems: reconciliationItems.data ?? [],
    reconciliationItemTotal: reconciliationItems.count ?? 0,
    reconciliationItemCap: RECONCILIATION_ITEM_CAP,
    accountingConnections: accountingConnections.data ?? [],
    exports: exports.data ?? [],
    accountantPackages: accountantPackages.data ?? [],
    openingBatches: openingBatches.data ?? [],
    cutovers: cutovers.data ?? [],
    closeItems: closeItems.data ?? [],
    statements:
      trialBalance && profitLoss && balanceSheet
        ? { trialBalance, profitLoss, balanceSheet }
        : null,
    capabilities: {
      manage: allowed("books.manage"),
      adjust: allowed("books.adjust"),
      reconcile: allowed("books.reconcile"),
      close: allowed("books.close"),
      reopen: allowed("books.reopen"),
      export: allowed("books.export"),
      tax: allowed("books.tax"),
      cutover: allowed("books.cutover"),
    },
  };
}
