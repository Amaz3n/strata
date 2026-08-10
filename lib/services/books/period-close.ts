import "server-only"

import { z } from "zod"

import { PAYABLE_VENDOR_BILL_STATUSES } from "@/lib/financials/ledger-status"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { booksDigest } from "@/lib/services/books/hash"
import {
  buildBalanceSheet,
  buildCashFlowStatement,
  buildGeneralLedger,
  buildProfitAndLoss,
  buildTrialBalance,
} from "@/lib/services/books/statements"
import { postBooksJournalEntry } from "@/lib/services/books/ledger"
import { postYearEndClose } from "@/lib/services/books/posting-rules"
import { resolveProjectionVersion } from "@/lib/services/books/projector"
import { loadProjectRevenueBases } from "@/lib/services/books/revenue-basis"
import { recognizeRevenueForPeriod } from "@/lib/services/books/revenue-recognition"
import { runLedgerTieOuts } from "@/lib/services/books/verifier"
import { TIE_OUT_ITEM_CATEGORIES } from "@/lib/services/books/reconciliation-rules"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getApAgingReport } from "@/lib/services/reports/ap-aging"
import { getArAgingReport } from "@/lib/services/reports/ar-aging"
import { getOrgWipOverUnderReport } from "@/lib/services/reports/wip-over-under"

/**
 * Cap on the exception scans that have no natural bound. A capped scan records
 * `scan_capped` in its evidence so a truncated pass can never read as a clean one.
 */
const SYNC_BACKLOG_SCAN_LIMIT = 500

/**
 * PostgREST answers an unbounded select with at most 1000 rows and says nothing
 * about it. The blocking `bank_matches` and `coding_exceptions` checks read those
 * results directly, so an org whose 1001st bank transaction was unmatched closed
 * its books on a scan that never saw it — a truncated pass reading as a clean one,
 * on a gate whose whole job is to stop exactly that.
 */
const CLOSE_PAGE_SIZE = 1000

async function collectPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; ; page += 1) {
    const from = page * CLOSE_PAGE_SIZE
    const { data, error } = await loadPage(from, from + CLOSE_PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < CLOSE_PAGE_SIZE) return rows
  }
}

/**
 * The status of a check whose scan is explicitly capped.
 *
 * A capped scan that found nothing is not a pass — it is an unfinished question.
 * Everything paged above reports zero honestly; the three bounded scans below use
 * this so they cannot report clean while truncated.
 */
function closeScanStatus(args: {
  issueCount: number
  scanCapped: boolean
  failedStatus: "failed" | "warning"
}) {
  if (args.issueCount > 0 || args.scanCapped) return args.failedStatus
  return "passed" as const
}

/**
 * The rule-set versions a posting is made under.
 *
 * The projection version comes from the org's approved policy, the policy version
 * from its Books settings — the same pair the projector and revenue recognition
 * resolve. Nothing that posts may invent them.
 */
async function resolveBooksVersions(orgId: string) {
  const service = createServiceSupabaseClient()
  const [settings, projectionVersion] = await Promise.all([
    service.from("books_settings").select("active_policy_version").eq("org_id", orgId).single(),
    resolveProjectionVersion(orgId),
  ])
  if (settings.error) throw new Error(`Failed to load Books settings: ${settings.error.message}`)
  return { policyVersion: Number(settings.data.active_policy_version), projectionVersion }
}

/** The day after an inclusive date bound, for comparing timestamps against it. */
function exclusiveDayAfter(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

const periodSchema = z.object({
  id: z.string().uuid(),
  period_start: z.string(),
  period_end: z.string(),
  fiscal_year: z.number().int(),
  fiscal_period: z.number().int(),
  status: z.enum(["open", "reviewing", "closed", "reopened"]),
})

async function requirePeriodPermission(permission: "books.close" | "books.reopen", orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission,
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "accounting_period",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

export async function createAccountingPeriod(input: {
  periodStart: string
  periodEnd: string
  fiscalYear: number
  fiscalPeriod: number
  orgId?: string
}) {
  const context = await requirePeriodPermission("books.close", input.orgId)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("accounting_periods").insert({
    org_id: context.orgId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    fiscal_year: input.fiscalYear,
    fiscal_period: input.fiscalPeriod,
    status: "open",
  }).select("id").single()
  if (error) throw new Error(`Failed to create accounting period: ${error.message}`)
  return z.object({ id: z.string().uuid() }).parse(data).id
}

type CloseCheck = {
  code: string
  label: string
  category: string
  blocking: boolean
  status: "passed" | "warning" | "failed"
  issueCount: number
  /**
   * Where the person closing the period goes to fix it. A checklist that names
   * a failure without saying where to cure it makes them hunt; the evidence ids
   * were already collected and then rendered as plain text.
   *
   * Stored inside `evidence` — `books_close_items` has no href column, and this
   * is presentation riding on the evidence rather than a new fact.
   */
  href?: string
  evidence: Record<string, unknown>
}

export async function runBooksCloseChecklist(periodId: string, orgId?: string) {
  const context = await requirePeriodPermission("books.close", orgId)
  const service = createServiceSupabaseClient()
  const { data: periodData, error: periodError } = await service
    .from("accounting_periods")
    .select("id, period_start, period_end, fiscal_year, fiscal_period, status")
    .eq("org_id", context.orgId)
    .eq("id", periodId)
    .single()
  if (periodError) throw new Error(`Failed to load accounting period: ${periodError.message}`)
  const period = periodSchema.parse(periodData)

  const [drafts, bankAccounts, bankReconciliations, bankTransactions, reconciliationItems, latestReconciliationRun, pocProjectBases, pocSnapshots, openBills, taxVendors, closeTrialBalance, tieOuts, syncBacklog, waiverHolds, retainageMovement] = await Promise.all([
    service.from("journal_entries").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("status", "draft").lte("entry_date", period.period_end),
    collectPages(
      (from, to) => service.from("bank_accounts").select("id").eq("org_id", context.orgId).eq("active", true).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
      "bank accounts",
    ),
    collectPages(
      (from, to) => service.from("bank_reconciliations").select("bank_account_id, statement_end, status").eq("org_id", context.orgId).eq("status", "closed").lte("statement_end", period.period_end).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
      "closed bank reconciliations",
    ),
    collectPages(
      (from, to) => service.from("bank_transactions").select("id, bank_transaction_matches(status)").eq("org_id", context.orgId).eq("lifecycle_status", "posted").eq("excluded", false).lte("transaction_date", period.period_end).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
      "posted bank transactions",
    ),
    // The CURRENT state of reconciliation, not its history. Items carry an identity
    // and a lifecycle now (`planReconciliationItemSync`): a finding the nightly sweep
    // no longer reproduces is resolved, and one a person has explained or ignored is
    // no longer open. Counting every open row ever written meant an org that had had
    // one discrepancy could never close a period again, however thoroughly it was
    // cured — the row from a superseded run stayed open forever.
    //
    // The tie-out categories are excluded on purpose: `job_cost_control`, `ar_control`,
    // and `ap_control` below are dedicated blocking checks for the same failures, so
    // counting them here too would fail a close twice for one problem.
    service
      .from("accounting_reconciliation_items")
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .eq("status", "open")
      .not("category", "in", `(${TIE_OUT_ITEM_CATEGORIES.join(",")})`),
    service
      .from("accounting_reconciliation_runs")
      .select("id, run_date, status, checked_counts")
      .eq("org_id", context.orgId)
      .order("run_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    loadProjectRevenueBases(context.orgId),
    collectPages(
      (from, to) => service.from("poc_snapshots").select("project_id, as_of").eq("org_id", context.orgId).lte("as_of", period.period_end).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
      "POC snapshots",
    ),
    // Bills are loaded for the coding check only; AR/AP balances come from the tie-outs.
    collectPages(
      (from, to) => service.from("vendor_bills").select("id, accounting_coding").eq("org_id", context.orgId).lte("bill_date", period.period_end).in("status", [...PAYABLE_VENDOR_BILL_STATUSES]).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
      "payable vendor bills",
    ),
    collectPages(
      (from, to) => service.from("companies").select("id, tax_id_last4, w9_file_id, is_1099_eligible").eq("org_id", context.orgId).eq("is_1099_eligible", true).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
      "1099-eligible vendors",
    ),
    buildTrialBalance(context.orgId, period.period_end),
    runLedgerTieOuts(context.orgId, period.period_end),
    // Approved work that never reached the external system. Closing a period
    // while the mirror is behind means the two ledgers disagree about a period
    // nobody can reopen without an audit trail.
    service
      .from("accounting_sync_records")
      .select("id, entity_type, entity_id, status")
      .eq("org_id", context.orgId)
      .in("status", ["pending", "error", "processing", "needs_review", "conflict"])
      .limit(SYNC_BACKLOG_SCAN_LIMIT),
    // Payments the compliance gate is holding. These are real obligations that
    // belong to this period even though no cash moved.
    service
      .from("vendor_bills")
      .select("id, lien_waiver_status, status")
      .eq("org_id", context.orgId)
      .lte("bill_date", period.period_end)
      .in("status", ["approved", "partial"])
      .in("lien_waiver_status", ["requested", "pending"])
      .limit(SYNC_BACKLOG_SCAN_LIMIT),
    // Retainage that moved inside the period, on either side. Reported rather
    // than blocking: movement is normal, unnoticed movement is not.
    service
      .from("retainage")
      .select("id, amount_cents, released_at, project_id")
      .eq("org_id", context.orgId)
      .gte("released_at", period.period_start)
      // `released_at` is a timestamp and `period_end` a date, so an inclusive
      // upper bound would silently drop everything released after midnight on
      // the last day of the period.
      .lt("released_at", exclusiveDayAfter(period.period_end))
      .limit(SYNC_BACKLOG_SCAN_LIMIT),
  ])
  // Every control check reads the tie-outs rather than recomputing them. The AR and AP
  // numbers used to be derived a second time here, against hardcoded "1100"/"2000"
  // literals, so the close and the verifier could disagree about the same balance.
  const tieOut = (code: string) =>
    tieOuts.find((row) => row.code === code) ?? {
      status: "passed" as const,
      ledgerCents: 0,
      subledgerCents: 0,
      differenceCents: 0,
    }
  const jobCostTieOut = tieOut("job_cost_control")
  const arTieOut = tieOut("ar_control")
  const apTieOut = tieOut("ap_control")
  const errors = [drafts.error, reconciliationItems.error, latestReconciliationRun.error, syncBacklog.error, waiverHolds.error, retainageMovement.error].filter(Boolean)
  if (errors.length > 0) throw new Error(`Failed to run Books close checklist: ${errors[0]?.message}`)

  // Paged rather than ordered in SQL: the queries above sort by `created_at` so the
  // pagination is deterministic, which means "latest" has to be picked here.
  const latestBankReconciliation = new Map<string, string>()
  for (const row of bankReconciliations) {
    const current = latestBankReconciliation.get(row.bank_account_id)
    if (!current || row.statement_end > current) latestBankReconciliation.set(row.bank_account_id, row.statement_end)
  }
  const unreconciledAccounts = bankAccounts.filter((account) => {
    const end = latestBankReconciliation.get(account.id)
    return !end || end < period.period_end
  })
  const latestPoc = new Map<string, string>()
  for (const row of pocSnapshots) {
    const current = latestPoc.get(row.project_id)
    if (!current || row.as_of > current) latestPoc.set(row.project_id, row.as_of)
  }
  // Only percentage-of-completion projects have a POC position. A production
  // spec home sold under a purchase agreement earns revenue at closing, so
  // requiring a snapshot for it would block the period forever.
  const pocProjects = pocProjectBases.filter(
    (project) => project.basis === "percentage_of_completion" && (project.status === "active" || project.status === "on_hold"),
  )
  const missingPoc = pocProjects.filter((project) => latestPoc.get(project.projectId) !== period.period_end)
  const unmatched = bankTransactions.filter((transaction) => {
    const matches = Array.isArray(transaction.bank_transaction_matches)
      ? transaction.bank_transaction_matches
      : []
    return !matches.some((match: { status?: string }) => match.status === "confirmed")
  })
  const accountBalance = (code: string) => closeTrialBalance.rows.find((row) => row.code === code)?.balanceCents ?? 0
  const clearingBalances = [SYSTEM_ACCOUNT_CODES.undepositedFunds, SYSTEM_ACCOUNT_CODES.payrollClearing]
    .map((code) => ({ code, balanceCents: accountBalance(code) }))
    .filter((row) => row.balanceCents !== 0)
  const uncodedBills = openBills.filter((bill) => !bill.accounting_coding || (typeof bill.accounting_coding === "object" && Object.keys(bill.accounting_coding).length === 0))
  const taxExceptions = taxVendors.filter((vendor) => !vendor.w9_file_id || !vendor.tax_id_last4)
  const unpushed = syncBacklog.data ?? []
  const heldPayments = waiverHolds.data ?? []
  const retainageRows = retainageMovement.data ?? []
  const retainageMovedCents = retainageRows.reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
  // Freshness of the reconciliation state the drift gate is reading. Reported, not
  // blocking: what blocks a close is an unresolved finding, and widening that to
  // "the sweep has not run" would stop a close for a cron problem. But a stale or
  // failed sweep must not read as silence, either.
  const reconciliationRun = latestReconciliationRun.data
  const reconciliationStale =
    !reconciliationRun || reconciliationRun.status === "failed" || String(reconciliationRun.run_date) < period.period_end

  const checks: CloseCheck[] = [
    { code: "journal_drafts", label: "All journals posted", category: "ledger", blocking: true, status: drafts.count ? "failed" : "passed", issueCount: drafts.count ?? 0, href: "/books/ledger", evidence: {} },
    { code: "bank_reconciliations", label: "Bank and card accounts reconciled", category: "cash", blocking: true, status: unreconciledAccounts.length ? "failed" : "passed", issueCount: unreconciledAccounts.length, href: "/books/banking", evidence: { account_ids: unreconciledAccounts.map((row) => row.id) } },
    { code: "bank_matches", label: "Bank transactions matched or excluded", category: "cash", blocking: true, status: unmatched.length ? "failed" : "passed", issueCount: unmatched.length, href: "/books/banking", evidence: { transaction_ids: unmatched.map((row) => row.id) } },
    { code: "accounting_drift", label: "Accounting reconciliation issues resolved", category: "integrations", blocking: true, status: reconciliationItems.count ? "failed" : "passed", issueCount: reconciliationItems.count ?? 0, href: "/books/close", evidence: { run_id: reconciliationRun?.id ?? null, run_date: reconciliationRun?.run_date ?? null, run_status: reconciliationRun?.status ?? null } },
    { code: "reconciliation_freshness", label: "Reconciliation swept through period end", category: "integrations", blocking: false, status: reconciliationStale ? "warning" : "passed", issueCount: reconciliationStale ? 1 : 0, href: "/books/close", evidence: { run_date: reconciliationRun?.run_date ?? null, run_status: reconciliationRun?.status ?? null, scan_capped: reconciliationRun?.checked_counts && typeof reconciliationRun.checked_counts === "object" ? (reconciliationRun.checked_counts as { scan_capped?: unknown }).scan_capped === true : false } },
    { code: "poc_snapshots", label: "WIP and POC captured through period end", category: "construction", blocking: true, status: missingPoc.length ? "failed" : "passed", issueCount: missingPoc.length, href: "/reports/wip-over-under", evidence: { project_ids: missingPoc.map((row) => row.projectId) } },
    { code: "job_cost_control", label: "GL job cost ties to the job-cost subledger", category: "controls", blocking: true, status: jobCostTieOut.status, issueCount: jobCostTieOut.status === "failed" ? 1 : 0, evidence: { ledger_cents: jobCostTieOut.ledgerCents, subledger_cents: jobCostTieOut.subledgerCents, difference_cents: jobCostTieOut.differenceCents } },
    { code: "ar_control", label: "Accounts receivable ties to the AR subledger", category: "controls", blocking: true, status: arTieOut.status, issueCount: arTieOut.status === "failed" ? 1 : 0, evidence: { ledger_cents: arTieOut.ledgerCents, subledger_cents: arTieOut.subledgerCents, difference_cents: arTieOut.differenceCents } },
    { code: "ap_control", label: "Accounts payable ties to the AP subledger", category: "controls", blocking: true, status: apTieOut.status, issueCount: apTieOut.status === "failed" ? 1 : 0, evidence: { ledger_cents: apTieOut.ledgerCents, subledger_cents: apTieOut.subledgerCents, difference_cents: apTieOut.differenceCents } },
    { code: "clearing_accounts", label: "Clearing and undeposited-funds accounts reviewed", category: "controls", blocking: true, status: clearingBalances.length ? "failed" : "passed", issueCount: clearingBalances.length, href: "/books/chart", evidence: { balances: clearingBalances } },
    { code: "coding_exceptions", label: "Approved bills are coded", category: "ledger", blocking: true, status: uncodedBills.length ? "failed" : "passed", issueCount: uncodedBills.length, href: "/payables?tab=approval", evidence: { bill_ids: uncodedBills.map((row) => row.id) } },
    { code: "sync_backlog", label: "Approved records pushed to the external system", category: "integrations", blocking: true, status: closeScanStatus({ issueCount: unpushed.length, scanCapped: unpushed.length >= SYNC_BACKLOG_SCAN_LIMIT, failedStatus: "failed" }), issueCount: unpushed.length, href: "/settings/integrations", evidence: { entity_ids: unpushed.slice(0, 100).map((row) => row.entity_id), scan_capped: unpushed.length >= SYNC_BACKLOG_SCAN_LIMIT } },
    { code: "waiver_holds", label: "Waiver-held payables reviewed", category: "controls", blocking: false, status: closeScanStatus({ issueCount: heldPayments.length, scanCapped: heldPayments.length >= SYNC_BACKLOG_SCAN_LIMIT, failedStatus: "warning" }), issueCount: heldPayments.length, href: "/payables?tab=ready", evidence: { bill_ids: heldPayments.slice(0, 100).map((row) => row.id), scan_capped: heldPayments.length >= SYNC_BACKLOG_SCAN_LIMIT } },
    { code: "retainage_movement", label: "Retainage released this period reviewed", category: "construction", blocking: false, status: closeScanStatus({ issueCount: retainageRows.length, scanCapped: retainageRows.length >= SYNC_BACKLOG_SCAN_LIMIT, failedStatus: "warning" }), issueCount: retainageRows.length, href: "/reports/retainage", evidence: { released_cents: retainageMovedCents, retainage_ids: retainageRows.slice(0, 100).map((row) => row.id), scan_capped: retainageRows.length >= SYNC_BACKLOG_SCAN_LIMIT } },
    { code: "tax_readiness", label: "W-9 and tax identity exceptions reviewed", category: "tax", blocking: false, status: taxExceptions.length ? "warning" : "passed", issueCount: taxExceptions.length, href: "/books/accountant", evidence: { company_ids: taxExceptions.map((row) => row.id) } },
  ]
  const { error: itemError } = await service.from("books_close_items").upsert(checks.map((check) => ({
    org_id: context.orgId,
    period_id: period.id,
    code: check.code,
    label: check.label,
    category: check.category,
    blocking: check.blocking,
    status: check.status,
    issue_count: check.issueCount,
    evidence: check.href ? { ...check.evidence, href: check.href } : check.evidence,
  })), { onConflict: "period_id,code" })
  if (itemError) throw new Error(`Failed to persist close checklist: ${itemError.message}`)
  return {
    period,
    checks,
    blockingFailures: checks.filter((check) => check.blocking && check.status === "failed"),
    // The projects this checklist proved a period-end position for. Revenue
    // recognition runs over the same set, and the caller compares the two rather
    // than letting a project quietly recognize against a substituted position.
    pocProjectIds: pocProjects.map((project) => project.projectId),
  }
}

export async function closeAccountingPeriod(periodId: string, orgId?: string) {
  const context = await requirePeriodPermission("books.close", orgId)
  // The checklist runs FIRST. Recognizing revenue before the blocking gate meant a
  // close that was then refused still left percentage-of-completion journal entries
  // posted into the period — a failed attempt that changed the books.
  const checklist = await runBooksCloseChecklist(periodId, context.orgId)
  if (checklist.blockingFailures.length > 0) {
    throw new Error(`Close blocked: ${checklist.blockingFailures.map((item) => item.label).join(", ")}`)
  }
  const { period } = checklist
  // Revenue is earned before the books are closed on it: recognize percentage-of
  // -completion revenue through period end so the statements snapshotted below
  // show earned revenue rather than billings alone. `period_end` is passed
  // explicitly — recognition is an as-of question, never a "right now" one.
  const recognition = await recognizeRevenueForPeriod(context.orgId, period.period_end)
  // The checklist has just proved a period-end position exists for every project in
  // `pocProjectIds`. If recognition could not find one anyway, the two disagree, and
  // recognizing against whatever position it did find would silently substitute a
  // number nobody checked.
  const withoutPosition = recognition.results.filter(
    (row) => !row.posted && row.skippedReason !== "no_delta" && checklist.pocProjectIds.includes(row.projectId),
  )
  if (withoutPosition.length > 0) {
    throw new Error(
      `Close blocked: no percentage-of-completion position as of ${period.period_end} for ${withoutPosition.length} project${withoutPosition.length === 1 ? "" : "s"} (${withoutPosition.map((row) => row.projectId).join(", ")})`,
    )
  }
  const [trialBalance, profitLoss, balanceSheet, cashFlow, generalLedger, arAging, apAging, wip] = await Promise.all([
    buildTrialBalance(context.orgId, period.period_end),
    buildProfitAndLoss(context.orgId, period.period_start, period.period_end),
    buildBalanceSheet(context.orgId, period.period_end),
    buildCashFlowStatement(context.orgId, period.period_start, period.period_end),
    buildGeneralLedger(context.orgId, period.period_start, period.period_end),
    getArAgingReport({ asOf: period.period_end, orgId: context.orgId }),
    getApAgingReport({ asOf: period.period_end, orgId: context.orgId }),
    getOrgWipOverUnderReport({ asOf: period.period_end, orgId: context.orgId }),
  ])
  if (trialBalance.totalDebitCents !== trialBalance.totalCreditCents) throw new Error("Trial balance does not balance")
  if (balanceSheet.differenceCents !== 0) throw new Error("Balance sheet does not balance")
  const officialStatements = [trialBalance, profitLoss, balanceSheet, cashFlow, generalLedger, { statement: "ar_aging" as const, ...arAging }, { statement: "ap_aging" as const, ...apAging }, { statement: "wip" as const, ...wip }]
  const digest = booksDigest({ period, checklist: checklist.checks, statements: officialStatements })
  const service = createServiceSupabaseClient()
  const { error: snapshotError } = await service.from("financial_statement_snapshots").upsert(officialStatements.map((statement) => ({
    org_id: context.orgId,
    period_id: period.id,
    statement_type: statement.statement,
    basis: "accrual",
    content: statement,
    content_hash: booksDigest(statement),
    generated_by: context.userId,
  })), { onConflict: "period_id,statement_type,basis,content_hash", ignoreDuplicates: true })
  if (snapshotError) throw new Error(`Failed to snapshot financial statements: ${snapshotError.message}`)
  const { error: closeError } = await service.from("accounting_periods").update({
    status: "closed",
    close_digest: digest,
    closed_by: context.userId,
    closed_at: new Date().toISOString(),
  }).eq("org_id", context.orgId).eq("id", period.id).in("status", ["open", "reviewing", "reopened"])
  if (closeError) throw new Error(`Failed to close accounting period: ${closeError.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.period_closed", entityType: "accounting_period", entityId: period.id, payload: { period_end: period.period_end, digest, revenue_recognized_cents: recognition.postedCents, revenue_recognized_projects: recognition.recognized } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "accounting_period", entityId: period.id, after: { status: "closed", digest }, source: "books.close" }),
  ])
  return { periodId: period.id, digest, statements: officialStatements, recognition }
}

export async function closeFiscalYearToRetainedEarnings(periodId: string, orgId?: string) {
  const context = await requirePeriodPermission("books.close", orgId)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("accounting_periods").select("id, period_start, period_end, fiscal_year, fiscal_period, status").eq("org_id", context.orgId).eq("id", periodId).single()
  if (error) throw new Error(`Failed to load year-end period: ${error.message}`)
  const period = periodSchema.parse(data)
  if (period.fiscal_period !== 12 && period.fiscal_period !== 13) throw new Error("Retained-earnings close is only available for the final fiscal period")
  if (period.status === "closed") throw new Error("Post the retained-earnings entry before closing the period")
  // A reopened year can shift net income, and posting-key idempotency alone
  // would let a second, differently-sized closing entry post on top of the
  // first. Refuse instead: the existing entry has to be reversed deliberately.
  const { data: existingClose, error: existingCloseError } = await service
    .from("journal_entries")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("source_type", "year_end_close")
    .eq("source_id", period.id)
    .eq("status", "posted")
    .maybeSingle()
  if (existingCloseError) throw new Error(`Failed to check for an existing year-end entry: ${existingCloseError.message}`)
  if (existingClose) return { created: false, reason: "already_closed" as const }
  // Versions are resolved the same way every other posting resolves them. Hardcoding
  // `1` pinned the closing entry to a rule-set version the org may have left behind,
  // so a re-projection under a new version could not re-derive it.
  const [profitLoss, versions] = await Promise.all([
    buildProfitAndLoss(context.orgId, `${period.fiscal_year}-01-01`, period.period_end),
    resolveBooksVersions(context.orgId),
  ])
  if (profitLoss.netIncomeCents === 0) return { created: false, reason: "zero_net_income" as const }
  const draft = postYearEndClose({
    id: period.id,
    date: period.period_end,
    memo: `Close fiscal ${period.fiscal_year} net income to retained earnings`,
    projectionVersion: versions.projectionVersion,
    policyVersion: versions.policyVersion,
    incomeAccountBalances: profitLoss.rows.map((row) => ({ accountCode: row.code, accountType: row.accountType, balanceCents: row.balanceCents })),
  })
  return postBooksJournalEntry(draft, { permission: "books.adjust", orgId: context.orgId })
}

export async function reopenAccountingPeriod(input: { periodId: string; reason: string; orgId?: string }) {
  const context = await requirePeriodPermission("books.reopen", input.orgId)
  if (input.reason.trim().length < 10) throw new Error("A substantive reopen reason is required")
  const service = createServiceSupabaseClient()
  const { data: before, error: loadError } = await service.from("accounting_periods").select("status, close_digest").eq("org_id", context.orgId).eq("id", input.periodId).single()
  if (loadError || before?.status !== "closed") throw new Error("Only a closed accounting period can be reopened")
  const { error } = await service.from("accounting_periods").update({
    status: "reopened",
    reopened_by: context.userId,
    reopened_at: new Date().toISOString(),
    reopen_reason: input.reason.trim(),
  }).eq("org_id", context.orgId).eq("id", input.periodId).eq("status", "closed")
  if (error) throw new Error(`Failed to reopen accounting period: ${error.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.period_reopened", entityType: "accounting_period", entityId: input.periodId, payload: { reason: input.reason.trim(), prior_digest: before.close_digest } })
}
