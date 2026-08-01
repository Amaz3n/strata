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

function monthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

export async function getBooksWorkspace(orgId?: string) {
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
    throw new Error("Arc Books is disabled. Enable it in Settings → Accounting.");

  const [
    accounts,
    periods,
    journals,
    bankAccounts,
    bankTransactions,
    bankReconciliations,
    comparisons,
    reconciliations,
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
    service
      .from("gl_accounts")
      .select(
        "id, code, name, account_type, subtype, normal_balance, active, is_system",
      )
      .eq("org_id", context.orgId)
      .order("code"),
    service
      .from("accounting_periods")
      .select(
        "id, period_start, period_end, fiscal_year, fiscal_period, status, closed_at, reopened_at, close_digest",
      )
      .eq("org_id", context.orgId)
      .order("period_end", { ascending: false })
      .limit(24),
    service
      .from("journal_entries")
      .select(
        "id, entry_date, entry_kind, status, memo, posting_key, posted_at, source_type, source_id",
      )
      .eq("org_id", context.orgId)
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100),
    service
      .from("bank_accounts")
      .select(
        "id, name, official_name, mask, account_type, account_subtype, current_balance_cents, available_balance_cents, balance_as_of, active, last_reconciled_on, connection:bank_feed_connections(institution_name,status,last_refresh_at,last_error)",
      )
      .eq("org_id", context.orgId)
      .eq("active", true)
      .order("name"),
    service
      .from("bank_transactions")
      .select(
        "id, bank_account_id, transaction_date, amount_cents, direction, merchant_name, description, lifecycle_status, excluded, matches:bank_transaction_matches(id,status,matched_amount_cents,match_type)",
      )
      .eq("org_id", context.orgId)
      .eq("lifecycle_status", "posted")
      .eq("excluded", false)
      .order("transaction_date", { ascending: false })
      .limit(250),
    service
      .from("bank_reconciliations")
      .select(
        "id, bank_account_id, statement_start, statement_end, beginning_balance_cents, ending_balance_cents, cleared_balance_cents, difference_cents, status, closed_at",
      )
      .eq("org_id", context.orgId)
      .order("statement_end", { ascending: false })
      .limit(24),
    service
      .from("books_comparison_runs")
      .select(
        "id, period_id, status, variance_count, unexplained_variance_count, completed_at, approved_at, items:books_comparison_items(id, account_id, difference_cents, variance_reason, explanation, status)",
      )
      .eq("org_id", context.orgId)
      .order("completed_at", { ascending: false })
      .limit(12),
    service
      .from("accounting_reconciliation_runs")
      .select("id, run_date, status, discrepancy_count, completed_at")
      .eq("org_id", context.orgId)
      .order("created_at", { ascending: false })
      .limit(12),
    service
      .from("accounting_connections")
      .select("id, provider, display_name:label, status, last_sync_at")
      .eq("org_id", context.orgId)
      .order("created_at", { ascending: false }),
    service
      .from("books_exports")
      .select(
        "id, export_type, status, content_hash, requested_at, downloaded_at, completed_at, expires_at",
      )
      .eq("org_id", context.orgId)
      .order("requested_at", { ascending: false })
      .limit(12),
    service
      .from("accountant_packages")
      .select(
        "id, period_id, tax_year, status, content_hash, manifest, requested_at, completed_at",
      )
      .eq("org_id", context.orgId)
      .order("requested_at", { ascending: false })
      .limit(12),
    service
      .from("opening_balance_batches")
      .select(
        "id, cutover_date, status, debit_total_cents, credit_total_cents, source_filename, digest, created_at",
      )
      .eq("org_id", context.orgId)
      .order("created_at", { ascending: false })
      .limit(10),
    service
      .from("books_cutover_runs")
      .select(
        "id, cutover_date, target_posture, status, blockers, digest, rollback_deadline, completed_at",
      )
      .eq("org_id", context.orgId)
      .order("created_at", { ascending: false })
      .limit(10),
    service
      .from("books_close_items")
      .select(
        "id, period_id, code, label, category, blocking, status, issue_count, evidence, updated_at",
      )
      .eq("org_id", context.orgId)
      .order("category")
      .order("label"),
    buildTrialBalance(context.orgId, asOf),
    buildProfitAndLoss(context.orgId, monthStart(), asOf),
    buildBalanceSheet(context.orgId, asOf),
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
  return {
    initialized: true as const,
    orgId: context.orgId,
    asOf,
    settings,
    accounts: accounts.data ?? [],
    periods: periods.data ?? [],
    journals: journals.data ?? [],
    bankAccounts: bankAccounts.data ?? [],
    bankTransactions: bankTransactions.data ?? [],
    bankReconciliations: bankReconciliations.data ?? [],
    unmatchedTransactions,
    comparisons: comparisons.data ?? [],
    reconciliations: reconciliations.data ?? [],
    accountingConnections: accountingConnections.data ?? [],
    exports: exports.data ?? [],
    accountantPackages: accountantPackages.data ?? [],
    openingBatches: openingBatches.data ?? [],
    cutovers: cutovers.data ?? [],
    closeItems: closeItems.data ?? [],
    statements: { trialBalance, profitLoss, balanceSheet },
  };
}
