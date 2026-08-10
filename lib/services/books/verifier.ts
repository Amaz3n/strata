import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { BILLED_INVOICE_STATUSES, PAYABLE_VENDOR_BILL_STATUSES } from "@/lib/financials/ledger-status"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import { buildBalanceSheet, buildTrialBalance } from "@/lib/services/books/statements"
import {
  sumApRetainageCents,
  sumApSubledgerCents,
  sumArSubledgerCents,
} from "@/lib/services/books/tie-out-rules"

/**
 * The ledger tie-outs.
 *
 * Run nightly for every org by the reconciliation spine
 * (`books/reconciliation.ts`), which persists each failure as an
 * `accounting_reconciliation_items` row, and again at period close, which turns them
 * into blocking close checks. Both callers read these results; neither recomputes them.
 *
 * These are the four checks the Books design calls non-negotiable: the trial
 * balance sums to zero, the balance sheet balances, GL job cost ties to the
 * `job_cost_entries` subledger, and AR/AP tie to the aging subledgers. The
 * job-cost tie-out is the one that never existed — the GL and the cost subledger
 * were derived independently, so nothing would have noticed them diverging.
 */

export type LedgerTieOut = {
  code:
    | "trial_balance"
    | "balance_sheet"
    | "job_cost_control"
    | "ar_control"
    | "ap_control"
    | "retainage_receivable_control"
    | "retainage_payable_control"
  label: string
  status: "passed" | "failed"
  differenceCents: number
  ledgerCents: number
  subledgerCents: number
}

const PAGE_SIZE = 1000

async function collectPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE
    const { data, error } = await loadPage(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }
}

/** Job cost recognized in the GL: cost-of-goods lines carrying a project. */
async function loadGlJobCostCents(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient()
  const rows = await collectPages(
    (from, to) => service
      .from("journal_lines")
      .select("debit_cents, credit_cents, entry:journal_entries!inner(status, entry_date), account:gl_accounts!inner(account_type)")
      .eq("org_id", orgId)
      .eq("entry.status", "posted")
      .lte("entry.entry_date", asOf)
      .eq("account.account_type", "cogs")
      .not("project_id", "is", null)
      .range(from, to),
    "GL job cost lines",
  )
  return rows.reduce((sum, row) => sum + Number(row.debit_cents ?? 0) - Number(row.credit_cents ?? 0), 0)
}

async function loadSubledgerJobCostCents(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient()
  const rows = await collectPages(
    (from, to) => service
      .from("job_cost_entries")
      .select("cost_cents")
      .eq("org_id", orgId)
      .eq("status", "posted")
      .lte("incurred_on", asOf)
      .range(from, to),
    "job cost subledger",
  )
  return rows.reduce((sum, row) => sum + Number(row.cost_cents ?? 0), 0)
}

async function loadArApSubledgerCents(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient()
  const [invoices, bills] = await Promise.all([
    collectPages(
      // The status set is the projector's, not a wider one: a control tie-out has
      // to sum exactly the records that produced the account. Excluding only
      // `draft` and `void` counted `saved` invoices, which never post to 1100.
      (from, to) => service.from("invoices").select("balance_due_cents").eq("org_id", orgId).lte("issue_date", asOf).in("status", [...BILLED_INVOICE_STATUSES]).range(from, to),
      "AR subledger",
    ),
    collectPages(
      (from, to) => service.from("vendor_bills").select("total_cents, paid_cents, retainage_cents").eq("org_id", orgId).lte("bill_date", asOf).in("status", [...PAYABLE_VENDOR_BILL_STATUSES]).range(from, to),
      "AP subledger",
    ),
  ])
  return {
    arCents: sumArSubledgerCents(invoices),
    apCents: sumApSubledgerCents(bills),
  }
}

/**
 * Retainage still held, per side.
 *
 * Accounts 1110 and 2010 are posted to by the invoice and vendor-bill rules but were
 * never verified against anything — retainage could drift indefinitely without a single
 * check noticing. AR retainage lives in the `retainage` table (its authoritative home);
 * AP retainage lives in the vendor-bill columns, net of what has been released.
 */
async function loadRetainageSubledgerCents(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient()
  const [held, bills] = await Promise.all([
    collectPages(
      // Joined to the invoice rather than filtered on `held_at`, for two reasons.
      // Retainage only reaches 1110 through `postCustomerInvoice`, so a hold whose
      // invoice is still `saved` — or which has no invoice at all — was never
      // posted and must not be summed here. And the GL dates that debit by the
      // invoice's `issue_date`, so the cutoff has to be the invoice's date, not
      // the date somebody recorded the hold.
      //
      // The `!invoice_id` hint is required, not decorative: `retainage` has two
      // foreign keys to `invoices` (`invoice_id` and `release_invoice_id`), and
      // without it PostgREST refuses the embed as ambiguous.
      (from, to) => service
        .from("retainage")
        .select("amount_cents, invoice:invoices!invoice_id!inner(status, issue_date)")
        .eq("org_id", orgId)
        .eq("status", "held")
        .in("invoice.status", [...BILLED_INVOICE_STATUSES])
        .lte("invoice.issue_date", asOf)
        .range(from, to),
      "AR retainage subledger",
    ),
    collectPages(
      (from, to) => service
        .from("vendor_bills")
        .select("retainage_cents, retainage_released_cents")
        .eq("org_id", orgId)
        .lte("bill_date", asOf)
        .in("status", [...PAYABLE_VENDOR_BILL_STATUSES])
        .range(from, to),
      "AP retainage subledger",
    ),
  ])
  return {
    receivableCents: held.reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0),
    payableCents: sumApRetainageCents(bills),
  }
}

export async function runLedgerTieOuts(orgId: string, asOf: string): Promise<LedgerTieOut[]> {
  const [trialBalance, balanceSheet, glJobCostCents, subledgerJobCostCents, arAp, retainage] = await Promise.all([
    buildTrialBalance(orgId, asOf),
    buildBalanceSheet(orgId, asOf),
    loadGlJobCostCents(orgId, asOf),
    loadSubledgerJobCostCents(orgId, asOf),
    loadArApSubledgerCents(orgId, asOf),
    loadRetainageSubledgerCents(orgId, asOf),
  ])
  const accountBalance = (code: string) => trialBalance.rows.find((row) => row.code === code)?.balanceCents ?? 0
  const trialDifference = trialBalance.totalDebitCents - trialBalance.totalCreditCents
  const jobCostDifference = glJobCostCents - subledgerJobCostCents
  const arDifference = accountBalance(SYSTEM_ACCOUNT_CODES.accountsReceivable) - arAp.arCents
  const apDifference = accountBalance(SYSTEM_ACCOUNT_CODES.accountsPayable) - arAp.apCents
  const retainageReceivableDifference =
    accountBalance(SYSTEM_ACCOUNT_CODES.retainageReceivable) - retainage.receivableCents
  const retainagePayableDifference = accountBalance(SYSTEM_ACCOUNT_CODES.retainagePayable) - retainage.payableCents

  return [
    {
      code: "trial_balance",
      label: "Trial balance sums to zero",
      status: trialDifference === 0 ? "passed" : "failed",
      differenceCents: trialDifference,
      ledgerCents: trialBalance.totalDebitCents,
      subledgerCents: trialBalance.totalCreditCents,
    },
    {
      code: "balance_sheet",
      label: "Balance sheet balances",
      status: balanceSheet.differenceCents === 0 ? "passed" : "failed",
      differenceCents: balanceSheet.differenceCents,
      ledgerCents: balanceSheet.assetCents,
      subledgerCents: balanceSheet.liabilityCents + balanceSheet.equityCents,
    },
    {
      code: "job_cost_control",
      label: "GL job cost ties to the job-cost subledger",
      status: jobCostDifference === 0 ? "passed" : "failed",
      differenceCents: jobCostDifference,
      ledgerCents: glJobCostCents,
      subledgerCents: subledgerJobCostCents,
    },
    {
      code: "ar_control",
      label: "Accounts receivable ties to the AR subledger",
      status: arDifference === 0 ? "passed" : "failed",
      differenceCents: arDifference,
      ledgerCents: accountBalance(SYSTEM_ACCOUNT_CODES.accountsReceivable),
      subledgerCents: arAp.arCents,
    },
    {
      code: "ap_control",
      label: "Accounts payable ties to the AP subledger",
      status: apDifference === 0 ? "passed" : "failed",
      differenceCents: apDifference,
      ledgerCents: accountBalance(SYSTEM_ACCOUNT_CODES.accountsPayable),
      subledgerCents: arAp.apCents,
    },
    {
      code: "retainage_receivable_control",
      label: "Retainage receivable ties to retainage still held",
      status: retainageReceivableDifference === 0 ? "passed" : "failed",
      differenceCents: retainageReceivableDifference,
      ledgerCents: accountBalance(SYSTEM_ACCOUNT_CODES.retainageReceivable),
      subledgerCents: retainage.receivableCents,
    },
    {
      code: "retainage_payable_control",
      label: "Retainage payable ties to unreleased vendor retainage",
      status: retainagePayableDifference === 0 ? "passed" : "failed",
      differenceCents: retainagePayableDifference,
      ledgerCents: accountBalance(SYSTEM_ACCOUNT_CODES.retainagePayable),
      subledgerCents: retainage.payableCents,
    },
  ]
}
