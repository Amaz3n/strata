import "server-only"

import { z } from "zod"

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
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getApAgingReport } from "@/lib/services/reports/ap-aging"
import { getArAgingReport } from "@/lib/services/reports/ar-aging"
import { getOrgWipOverUnderReport } from "@/lib/services/reports/wip-over-under"

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

  const [drafts, bankAccounts, bankReconciliations, bankTransactions, reconciliationItems, pocProjects, pocSnapshots, openInvoices, openBills, taxVendors, closeTrialBalance] = await Promise.all([
    service.from("journal_entries").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("status", "draft").lte("entry_date", period.period_end),
    service.from("bank_accounts").select("id").eq("org_id", context.orgId).eq("active", true),
    service.from("bank_reconciliations").select("bank_account_id, statement_end, status").eq("org_id", context.orgId).eq("status", "closed").lte("statement_end", period.period_end).order("statement_end", { ascending: false }),
    service.from("bank_transactions").select("id, bank_transaction_matches(status)").eq("org_id", context.orgId).eq("lifecycle_status", "posted").eq("excluded", false).lte("transaction_date", period.period_end),
    service.from("accounting_reconciliation_items").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("status", "open"),
    service.from("projects").select("id").eq("org_id", context.orgId).in("status", ["active", "on_hold"]),
    service.from("poc_snapshots").select("project_id, as_of").eq("org_id", context.orgId).lte("as_of", period.period_end).order("as_of", { ascending: false }),
    service.from("invoices").select("id, balance_due_cents, retainage_cents").eq("org_id", context.orgId).lte("issue_date", period.period_end).not("status", "in", "(draft,void)"),
    service.from("vendor_bills").select("id, total_cents, paid_cents, retainage_cents, accounting_coding").eq("org_id", context.orgId).lte("bill_date", period.period_end).in("status", ["approved", "partial", "paid"]),
    service.from("companies").select("id, tax_id_last4, w9_file_id, is_1099_eligible").eq("org_id", context.orgId).eq("is_1099_eligible", true),
    buildTrialBalance(context.orgId, period.period_end),
  ])
  const errors = [drafts.error, bankAccounts.error, bankReconciliations.error, bankTransactions.error, reconciliationItems.error, pocProjects.error, pocSnapshots.error, openInvoices.error, openBills.error, taxVendors.error].filter(Boolean)
  if (errors.length > 0) throw new Error(`Failed to run Books close checklist: ${errors[0]?.message}`)

  const latestBankReconciliation = new Map<string, string>()
  for (const row of bankReconciliations.data ?? []) {
    if (!latestBankReconciliation.has(row.bank_account_id)) latestBankReconciliation.set(row.bank_account_id, row.statement_end)
  }
  const unreconciledAccounts = (bankAccounts.data ?? []).filter((account) => {
    const end = latestBankReconciliation.get(account.id)
    return !end || end < period.period_end
  })
  const latestPoc = new Map<string, string>()
  for (const row of pocSnapshots.data ?? []) {
    if (!latestPoc.has(row.project_id)) latestPoc.set(row.project_id, row.as_of)
  }
  const missingPoc = (pocProjects.data ?? []).filter((project) => latestPoc.get(project.id) !== period.period_end)
  const unmatched = (bankTransactions.data ?? []).filter((transaction) => {
    const matches = Array.isArray(transaction.bank_transaction_matches)
      ? transaction.bank_transaction_matches
      : []
    return !matches.some((match) => match.status === "confirmed")
  })
  const accountBalance = (code: string) => closeTrialBalance.rows.find((row) => row.code === code)?.balanceCents ?? 0
  const arSubledgerCents = (openInvoices.data ?? []).reduce((sum, row) => sum + Math.max(0, Number(row.balance_due_cents ?? 0) - Number(row.retainage_cents ?? 0)), 0)
  const apSubledgerCents = (openBills.data ?? []).reduce((sum, row) => sum + Math.max(0, Number(row.total_cents ?? 0) - Number(row.paid_cents ?? 0) - Number(row.retainage_cents ?? 0)), 0)
  const arDifferenceCents = accountBalance("1100") - arSubledgerCents
  const apDifferenceCents = accountBalance("2000") - apSubledgerCents
  const clearingBalances = ["1010", "2200"].map((code) => ({ code, balanceCents: accountBalance(code) })).filter((row) => row.balanceCents !== 0)
  const uncodedBills = (openBills.data ?? []).filter((bill) => !bill.accounting_coding || (typeof bill.accounting_coding === "object" && Object.keys(bill.accounting_coding).length === 0))
  const taxExceptions = (taxVendors.data ?? []).filter((vendor) => !vendor.w9_file_id || !vendor.tax_id_last4)

  const checks: CloseCheck[] = [
    { code: "journal_drafts", label: "All journals posted", category: "ledger", blocking: true, status: drafts.count ? "failed" : "passed", issueCount: drafts.count ?? 0, evidence: {} },
    { code: "bank_reconciliations", label: "Bank and card accounts reconciled", category: "cash", blocking: true, status: unreconciledAccounts.length ? "failed" : "passed", issueCount: unreconciledAccounts.length, evidence: { account_ids: unreconciledAccounts.map((row) => row.id) } },
    { code: "bank_matches", label: "Bank transactions matched or excluded", category: "cash", blocking: true, status: unmatched.length ? "failed" : "passed", issueCount: unmatched.length, evidence: { transaction_ids: unmatched.map((row) => row.id) } },
    { code: "accounting_drift", label: "Accounting reconciliation issues resolved", category: "integrations", blocking: true, status: reconciliationItems.count ? "failed" : "passed", issueCount: reconciliationItems.count ?? 0, evidence: {} },
    { code: "poc_snapshots", label: "WIP and POC captured through period end", category: "construction", blocking: true, status: missingPoc.length ? "failed" : "passed", issueCount: missingPoc.length, evidence: { project_ids: missingPoc.map((row) => row.id) } },
    { code: "ar_control", label: "Accounts receivable ties to the AR subledger", category: "controls", blocking: true, status: arDifferenceCents === 0 ? "passed" : "failed", issueCount: arDifferenceCents === 0 ? 0 : 1, evidence: { ledger_cents: accountBalance("1100"), subledger_cents: arSubledgerCents, difference_cents: arDifferenceCents } },
    { code: "ap_control", label: "Accounts payable ties to the AP subledger", category: "controls", blocking: true, status: apDifferenceCents === 0 ? "passed" : "failed", issueCount: apDifferenceCents === 0 ? 0 : 1, evidence: { ledger_cents: accountBalance("2000"), subledger_cents: apSubledgerCents, difference_cents: apDifferenceCents } },
    { code: "clearing_accounts", label: "Clearing and undeposited-funds accounts reviewed", category: "controls", blocking: true, status: clearingBalances.length ? "failed" : "passed", issueCount: clearingBalances.length, evidence: { balances: clearingBalances } },
    { code: "coding_exceptions", label: "Approved bills are coded", category: "ledger", blocking: true, status: uncodedBills.length ? "failed" : "passed", issueCount: uncodedBills.length, evidence: { bill_ids: uncodedBills.map((row) => row.id) } },
    { code: "tax_readiness", label: "W-9 and tax identity exceptions reviewed", category: "tax", blocking: false, status: taxExceptions.length ? "warning" : "passed", issueCount: taxExceptions.length, evidence: { company_ids: taxExceptions.map((row) => row.id) } },
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
    evidence: check.evidence,
  })), { onConflict: "period_id,code" })
  if (itemError) throw new Error(`Failed to persist close checklist: ${itemError.message}`)
  return { period, checks, blockingFailures: checks.filter((check) => check.blocking && check.status === "failed") }
}

export async function closeAccountingPeriod(periodId: string, orgId?: string) {
  const context = await requirePeriodPermission("books.close", orgId)
  const checklist = await runBooksCloseChecklist(periodId, context.orgId)
  if (checklist.blockingFailures.length > 0) {
    throw new Error(`Close blocked: ${checklist.blockingFailures.map((item) => item.label).join(", ")}`)
  }
  const { period } = checklist
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
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.period_closed", entityType: "accounting_period", entityId: period.id, payload: { period_end: period.period_end, digest } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "accounting_period", entityId: period.id, after: { status: "closed", digest }, source: "books.close" }),
  ])
  return { periodId: period.id, digest, statements: officialStatements }
}

export async function closeFiscalYearToRetainedEarnings(periodId: string, orgId?: string) {
  const context = await requirePeriodPermission("books.close", orgId)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("accounting_periods").select("id, period_start, period_end, fiscal_year, fiscal_period, status").eq("org_id", context.orgId).eq("id", periodId).single()
  if (error) throw new Error(`Failed to load year-end period: ${error.message}`)
  const period = periodSchema.parse(data)
  if (period.fiscal_period !== 12 && period.fiscal_period !== 13) throw new Error("Retained-earnings close is only available for the final fiscal period")
  if (period.status === "closed") throw new Error("Post the retained-earnings entry before closing the period")
  const profitLoss = await buildProfitAndLoss(context.orgId, `${period.fiscal_year}-01-01`, period.period_end)
  if (profitLoss.netIncomeCents === 0) return { created: false, reason: "zero_net_income" as const }
  const draft = postYearEndClose({ id: period.id, date: period.period_end, memo: `Close fiscal ${period.fiscal_year} net income to retained earnings`, policyVersion: 1, incomeAccountBalances: profitLoss.rows.map((row) => ({ accountCode: row.code, balanceCents: row.balanceCents })) })
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
