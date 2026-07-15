/**
 * Financial Reconciliation report.
 *
 * Runs the project's data-integrity checks (§5.8 of the financials ecosystem
 * gameplan) and returns every exception grouped into queues. Each exception
 * deep-links to the page where a controller can fix it; a healthy project
 * reads "All clear".
 *
 * Only true integrity checks live here. Pipeline states that other pages
 * already own (unbilled costs → Close & Bill, AR aging → Receivables,
 * QBO sync errors → the sync sheet) are deliberately excluded.
 */

import { isCostDrivenBillingModel, resolveProjectBillingModel } from "@/lib/financials/billing-model"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { getProjectJobCostActualsByCostCode } from "@/lib/services/job-cost-actuals"
import {
  RECONCILIATION_QUEUE_LABELS,
  RECONCILIATION_QUEUE_ORDER,
  type ProjectReconciliationReport,
  type ReconciliationException,
  type ReconciliationExceptionKind,
  type ReconciliationQueueSummary,
  type ReconciliationSeverity,
} from "@/lib/services/reports/reconciliation-types"

export type {
  ProjectReconciliationReport,
  ReconciliationException,
  ReconciliationExceptionKind,
  ReconciliationQueueSummary,
  ReconciliationSeverity,
} from "@/lib/services/reports/reconciliation-types"
export { RECONCILIATION_QUEUE_LABELS, RECONCILIATION_QUEUE_ORDER } from "@/lib/services/reports/reconciliation-types"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function projectFinancialHref(projectId: string, section = "") {
  return `/projects/${projectId}/financials${section}`
}

function money(cents: number) {
  return `$${(Math.abs(cents) / 100).toLocaleString()}`
}

function severityForAmount(
  cents: number,
  thresholdWarn = 50000,
  thresholdCritical = 200000,
): ReconciliationSeverity {
  if (Math.abs(cents) >= thresholdCritical) return "critical"
  if (Math.abs(cents) >= thresholdWarn) return "warning"
  return "info"
}

function makeQueueSummaries(exceptions: ReconciliationException[]): ReconciliationQueueSummary[] {
  const map = new Map<ReconciliationExceptionKind, ReconciliationQueueSummary>()

  for (const ex of exceptions) {
    const current = map.get(ex.kind)
    if (current) {
      current.count += 1
      current.total_cents += Math.abs(ex.amount_cents)
      if (ex.severity === "critical" || (ex.severity === "warning" && current.severity !== "critical")) {
        current.severity = ex.severity
      }
    } else {
      map.set(ex.kind, {
        kind: ex.kind,
        label: RECONCILIATION_QUEUE_LABELS[ex.kind],
        count: 1,
        total_cents: Math.abs(ex.amount_cents),
        severity: ex.severity,
      })
    }
  }

  return RECONCILIATION_QUEUE_ORDER.filter((kind) => map.has(kind)).map((kind) => map.get(kind)!)
}

// ─── Row shapes (untyped Supabase client) ─────────────────────────────────────

type BillableCostRow = {
  id: string
  description: string | null
  cost_cents: number | null
  billable_cents: number | null
  source_type: string | null
  source_id: string | null
  invoice_id: string | null
}

type JobCostEntryRow = {
  id: string
  source_type: string | null
  source_id: string | null
  cost_cents: number | null
  is_billable: boolean | null
  billable_cost_id: string | null
  metadata: Record<string, unknown> | null
}

// ─── Checks ───────────────────────────────────────────────────────────────────

async function checkInvoiceTotalMismatch(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<ReconciliationException[]> {
  const { data, error } = await ctx.supabase
    .from("invoices")
    .select("id, invoice_number, title, total_cents, tax_cents, status")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .not("status", "in", "(void,draft)")

  if (error) throw error
  const invoices: Array<{
    id: string
    invoice_number: string | null
    title: string | null
    total_cents: number | null
    tax_cents: number | null
  }> = data ?? []
  if (invoices.length === 0) return []

  const { data: lineData, error: linesError } = await ctx.supabase
    .from("invoice_lines")
    .select("id, invoice_id, quantity, unit_price_cents")
    .eq("org_id", ctx.orgId)
    .in("invoice_id", invoices.map((invoice) => invoice.id))

  if (linesError) throw linesError
  const subtotalByInvoice = new Map<string, number>()
  const lines: Array<{ invoice_id: string; quantity: number | null; unit_price_cents: number | null }> =
    lineData ?? []
  for (const line of lines) {
    const lineTotal = Math.round(Number(line.quantity ?? 1) * Number(line.unit_price_cents ?? 0))
    subtotalByInvoice.set(line.invoice_id, (subtotalByInvoice.get(line.invoice_id) ?? 0) + lineTotal)
  }

  const exceptions: ReconciliationException[] = []
  for (const invoice of invoices) {
    const subtotal = subtotalByInvoice.get(invoice.id)
    if (subtotal === undefined) continue

    const computedTotal = subtotal + Number(invoice.tax_cents ?? 0)
    const storedTotal = invoice.total_cents ?? 0
    const mismatch = Math.abs(storedTotal - computedTotal)

    // Allow for small rounding differences (tax, rounding)
    if (mismatch > 100) {
      exceptions.push({
        id: `invoice-total-${invoice.id}`,
        kind: "invoice_total_mismatch",
        severity: severityForAmount(mismatch, 1000, 10000),
        project_id: projectId,
        reference: invoice.invoice_number
          ? `Invoice ${invoice.invoice_number}`
          : invoice.title ?? `Invoice ${invoice.id.slice(0, 8)}`,
        description: `Invoice total (${money(storedTotal)}) differs from computed line total (${money(computedTotal)}) by ${money(mismatch)}`,
        amount_cents: mismatch,
        source_type: "invoice",
        source_id: invoice.id,
        href: projectFinancialHref(projectId, `/receivables?invoice=${invoice.id}`),
      })
    }
  }

  return exceptions
}

async function checkBudgetActualMismatch(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<ReconciliationException[]> {
  const jobCostActuals = await getProjectJobCostActualsByCostCode({
    projectId,
    orgId: ctx.orgId,
    supabase: ctx.supabase,
  })

  const jceTotalCents = jobCostActuals.reduce((sum, row) => sum + row.actual_cents, 0)

  const { data, error } = await ctx.supabase
    .from("bill_lines")
    .select("id, unit_cost_cents, quantity, bill:vendor_bills!inner(id, project_id, status)")
    .eq("org_id", ctx.orgId)
    .eq("bill.project_id", projectId)
    .in("bill.status", ["approved", "partial", "paid"])

  if (error) throw error
  const billLines: Array<{ unit_cost_cents: number | null; quantity: number | null }> = data ?? []
  const billLineTotalCents = billLines.reduce((sum, line) => {
    return sum + Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1))
  }, 0)

  // Time/expenses legitimately push job-cost actuals above vendor bill totals,
  // so only flag when job-cost entries are missing bill-line postings.
  const gapCents = billLineTotalCents - jceTotalCents
  if (jceTotalCents > 0 && gapCents > 100) {
    return [
      {
        id: `budget-mismatch-${projectId}`,
        kind: "budget_actual_mismatch",
        severity: severityForAmount(gapCents, 10000, 100000),
        project_id: projectId,
        reference: "Budget / Job Cost Ledger",
        description: `Job-cost entries (${money(jceTotalCents)}) are less than approved vendor bill totals (${money(billLineTotalCents)}) — ${money(gapCents)} gap`,
        amount_cents: gapCents,
        href: projectFinancialHref(projectId, "/budget"),
      },
    ]
  }

  return []
}

async function checkIncurredBillableTieOut(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<ReconciliationException[]> {
  const [settingsResult, contractResult] = await Promise.all([
    ctx.supabase
      .from("project_financial_settings")
      .select("billing_model")
      .eq("org_id", ctx.orgId)
      .eq("project_id", projectId)
      .maybeSingle(),
    ctx.supabase
      .from("contracts")
      .select("contract_type, fixed_fee_cents, gmp_cents, snapshot")
      .eq("org_id", ctx.orgId)
      .eq("project_id", projectId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (settingsResult.error) throw settingsResult.error
  if (contractResult.error) throw contractResult.error

  const billingModel = resolveProjectBillingModel({
    status: "active",
    financial_settings: settingsResult.data ?? null,
    billing_contract: contractResult.data ?? null,
  })
  if (!isCostDrivenBillingModel(billingModel)) return []

  const { data, error: actualsError } = await ctx.supabase
    .from("job_cost_entries")
    .select("id, source_type, source_id, cost_cents, is_billable, billable_cost_id, metadata")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .eq("status", "posted")
    .in("source_type", ["vendor_bill_line", "project_expense", "project_expense_line", "time_entry"])

  if (actualsError) throw actualsError
  const actuals: JobCostEntryRow[] = data ?? []
  if (actuals.length === 0) return []

  const sourceIdsByType = new Map<string, string[]>()
  for (const entry of actuals) {
    if (!entry.source_type || !entry.source_id) continue
    const values = sourceIdsByType.get(entry.source_type) ?? []
    values.push(entry.source_id)
    sourceIdsByType.set(entry.source_type, values)
  }

  const ledgerPairs = new Set<string>()
  await Promise.all(
    Array.from(sourceIdsByType.entries()).map(async ([sourceType, sourceIds]) => {
      const ids = Array.from(new Set(sourceIds))
      if (ids.length === 0) return
      const { data: ledgerRows } = await ctx.supabase
        .from("billable_costs")
        .select("source_type, source_id")
        .eq("org_id", ctx.orgId)
        .eq("project_id", projectId)
        .eq("source_type", sourceType)
        .in("source_id", ids)
        .neq("status", "voided")
      const rows: Array<{ source_type: string | null; source_id: string | null }> = ledgerRows ?? []
      for (const row of rows) {
        ledgerPairs.add(`${row.source_type}:${row.source_id}`)
      }
    }),
  )

  const missing = actuals.filter((entry) => {
    if (entry.billable_cost_id) return false
    if (ledgerPairs.has(`${entry.source_type}:${entry.source_id}`)) return false
    const metadata = entry.metadata ?? {}
    return entry.is_billable === true || metadata.billable_to_customer === true || metadata.imported_from_qbo === true
  })

  if (missing.length === 0) return []

  const amountCents = missing.reduce((sum, entry) => sum + Number(entry.cost_cents ?? 0), 0)
  return [
    {
      id: `incurred-billable-tieout-${projectId}`,
      kind: "incurred_billable_tieout",
      severity: severityForAmount(amountCents),
      project_id: projectId,
      reference: `${missing.length} incurred cost${missing.length === 1 ? "" : "s"}`,
      description: `${money(amountCents)} in actual costs look reimbursable but are missing from the billable ledger`,
      amount_cents: Math.abs(amountCents),
      source_type: "job_cost_entries",
      source_id: projectId,
      href: projectFinancialHref(projectId, "/review"),
      metadata: {
        entry_count: missing.length,
        qbo_imported_count: missing.filter((entry) => entry.metadata?.imported_from_qbo === true).length,
      },
    },
  ]
}

async function checkBillableNoJobCost(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<ReconciliationException[]> {
  const { data, error } = await ctx.supabase
    .from("billable_costs")
    .select("id, description, cost_cents, billable_cents, source_type, source_id, invoice_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .neq("status", "voided")

  if (error) throw error
  const billableCosts: BillableCostRow[] = data ?? []
  if (billableCosts.length === 0) return []

  const { data: linkData, error: linksError } = await ctx.supabase
    .from("job_cost_entries")
    .select("billable_cost_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .eq("status", "posted")
    .not("billable_cost_id", "is", null)

  if (linksError) throw linksError
  const linkedIds = new Set(
    ((linkData ?? []) as Array<{ billable_cost_id: string | null }>).map((row) => row.billable_cost_id),
  )

  return billableCosts
    .filter((cost) => cost.source_type !== "manual_adjustment" && cost.source_type !== "allowance_overage")
    .filter((cost) => !linkedIds.has(cost.id))
    .map((cost) => ({
      id: `billable-no-jce-${cost.id}`,
      kind: "billable_no_job_cost" as const,
      severity: "warning" as const,
      project_id: projectId,
      reference: cost.description ?? `Billable cost ${cost.id.slice(0, 8)}`,
      description: `Billable cost (${money(cost.cost_cents ?? 0)}) has no matching job-cost entry`,
      amount_cents: cost.cost_cents ?? 0,
      source_type: cost.source_type,
      source_id: cost.source_id,
      href: projectFinancialHref(projectId, "/budget"),
    }))
}

async function checkJobCostUnclassified(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<ReconciliationException[]> {
  const { data, error } = await ctx.supabase
    .from("job_cost_entries")
    .select("id, source_type, source_id, cost_cents, is_billable, billable_cost_id, metadata")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .eq("status", "posted")
    .eq("is_billable", true)
    .is("billable_cost_id", null)

  if (error) throw error
  const entries: JobCostEntryRow[] = data ?? []

  return entries.map((entry) => ({
    id: `jce-unclassified-${entry.id}`,
    kind: "job_cost_unclassified" as const,
    severity: "info" as const,
    project_id: projectId,
    reference: `${entry.source_type ?? "Entry"} ${entry.id.slice(0, 8)}`,
    description: `Job-cost entry (${money(entry.cost_cents ?? 0)}) marked billable but not linked to a billable cost row`,
    amount_cents: entry.cost_cents ?? 0,
    source_type: entry.source_type,
    source_id: entry.source_id,
    href: projectFinancialHref(projectId, "/budget"),
  }))
}

async function checkBilledWithoutProof(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<ReconciliationException[]> {
  // Only meaningful when the project requires proof on billed costs
  const { data: settings, error: settingsError } = await ctx.supabase
    .from("project_financial_settings")
    .select("proof_required")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  if (settingsError) throw settingsError
  if (!settings?.proof_required) return []

  const { data, error } = await ctx.supabase
    .from("billable_costs")
    .select("id, description, billable_cents, cost_cents, source_type, source_id, invoice_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .not("invoice_id", "is", null)
    .neq("status", "voided")

  if (error) throw error
  const billedCosts: BillableCostRow[] = data ?? []
  if (billedCosts.length === 0) return []

  const sourceIdsFor = (sourceType: string) =>
    Array.from(
      new Set(
        billedCosts
          .filter((cost) => cost.source_type === sourceType)
          .map((cost) => cost.source_id)
          .filter((id): id is string => Boolean(id)),
      ),
    )
  const billLineIds = sourceIdsFor("vendor_bill_line")
  const expenseIds = sourceIdsFor("project_expense")

  const [billLinesResult, expensesResult] = await Promise.all([
    billLineIds.length
      ? ctx.supabase.from("bill_lines").select("id, bill_id").eq("org_id", ctx.orgId).in("id", billLineIds)
      : Promise.resolve({ data: [], error: null }),
    expenseIds.length
      ? ctx.supabase
          .from("project_expenses")
          .select("id, receipt_file_id")
          .eq("org_id", ctx.orgId)
          .in("id", expenseIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (billLinesResult.error) throw billLinesResult.error
  if (expensesResult.error) throw expensesResult.error

  const billLines: Array<{ id: string; bill_id: string }> = billLinesResult.data ?? []
  const billIds = Array.from(new Set(billLines.map((line) => line.bill_id)))
  const { data: billData, error: billsError } = billIds.length
    ? await ctx.supabase.from("vendor_bills").select("id, file_id, metadata").eq("org_id", ctx.orgId).in("id", billIds)
    : { data: [], error: null }

  if (billsError) throw billsError
  const bills: Array<{ id: string; file_id: string | null; metadata: Record<string, unknown> | null }> =
    billData ?? []
  const billHasProof = new Map(
    bills.map((bill) => [bill.id, Boolean(bill.file_id || bill.metadata?.proof_file_id)]),
  )
  const billIdByLineId = new Map(billLines.map((line) => [line.id, line.bill_id]))

  const expenses: Array<{ id: string; receipt_file_id: string | null }> = expensesResult.data ?? []
  const expenseHasProof = new Map(expenses.map((expense) => [expense.id, Boolean(expense.receipt_file_id)]))

  const exceptions: ReconciliationException[] = []
  for (const cost of billedCosts) {
    let hasProof = true
    if (cost.source_type === "vendor_bill_line") {
      const billId = cost.source_id ? billIdByLineId.get(cost.source_id) : undefined
      hasProof = billId ? (billHasProof.get(billId) ?? false) : false
    } else if (cost.source_type === "project_expense") {
      hasProof = cost.source_id ? (expenseHasProof.get(cost.source_id) ?? false) : false
    }
    // Other source types (time entries, adjustments) have no proof artifact — skip

    if (!hasProof) {
      exceptions.push({
        id: `billed-no-proof-${cost.id}`,
        kind: "billed_without_proof",
        severity: "warning",
        project_id: projectId,
        reference: cost.description ?? `Billed cost ${cost.id.slice(0, 8)}`,
        description: `Billed cost (${money(cost.billable_cents ?? 0)}) has no source proof attached`,
        amount_cents: cost.billable_cents ?? 0,
        source_type: cost.source_type,
        source_id: cost.source_id,
        href: projectFinancialHref(projectId, "/receivables"),
      })
    }
  }

  return exceptions
}

async function checkUnlinkedPayments(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<ReconciliationException[]> {
  const { data, error } = await ctx.supabase
    .from("payments")
    .select("id, amount_cents, method, created_at, invoice_id, bill_id, metadata")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .is("invoice_id", null)
    .is("bill_id", null)
    .neq("status", "voided")

  if (error) throw error
  const payments: Array<{ id: string; amount_cents: number | null }> = data ?? []
  if (payments.length === 0) return []

  const { data: allocationData, error: allocationsError } = await ctx.supabase
    .from("payment_allocations")
    .select("payment_id")
    .eq("org_id", ctx.orgId)
    .in("payment_id", payments.map((payment) => payment.id))

  if (allocationsError) throw allocationsError
  const allocatedPaymentIds = new Set(
    ((allocationData ?? []) as Array<{ payment_id: string | null }>)
      .map((allocation) => allocation.payment_id)
      .filter(Boolean),
  )

  return payments
    .filter((payment) => !allocatedPaymentIds.has(payment.id))
    .map((payment) => ({
      id: `payment-unlinked-${payment.id}`,
      kind: "payment_unlinked" as const,
      severity: "warning" as const,
      project_id: projectId,
      reference: `Payment ${payment.id.slice(0, 8)}`,
      description: `Payment (${money(payment.amount_cents ?? 0)}) not linked to any invoice or vendor bill`,
      amount_cents: payment.amount_cents ?? 0,
      href: projectFinancialHref(projectId, "/receivables"),
    }))
}

async function checkRetainageMismatch(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<ReconciliationException[]> {
  const { data, error } = await ctx.supabase
    .from("retainage")
    .select("id, amount_cents, status, invoice_id, release_invoice_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)

  if (error) throw error
  const retainageRecords: Array<{
    id: string
    amount_cents: number | null
    status: string | null
    invoice_id: string | null
    release_invoice_id: string | null
  }> = data ?? []
  if (retainageRecords.length === 0) return []

  const orphanedRetainage = retainageRecords.filter((row) => row.status === "held" && !row.invoice_id)
  const releasedWithoutInvoice = retainageRecords.filter(
    (row) => ["released", "invoiced", "paid"].includes(row.status ?? "") && !row.release_invoice_id,
  )
  const releaseInvoiceIds = Array.from(
    new Set(retainageRecords.map((row) => row.release_invoice_id).filter((id): id is string => Boolean(id))),
  )
  const { data: invoiceData } = releaseInvoiceIds.length
    ? await ctx.supabase
        .from("invoices")
        .select("id, invoice_number, status, balance_due_cents, total_cents")
        .eq("org_id", ctx.orgId)
        .in("id", releaseInvoiceIds)
    : { data: [] }
  const releaseInvoices: Array<{
    id: string
    invoice_number: string | null
    status: string | null
    balance_due_cents: number | null
  }> = invoiceData ?? []
  const releaseInvoiceById = new Map(releaseInvoices.map((invoice) => [invoice.id, invoice]))

  const exceptions: ReconciliationException[] = []

  if (orphanedRetainage.length > 0) {
    const totalOrphaned = orphanedRetainage.reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
    exceptions.push({
      id: `retainage-orphan-${projectId}`,
      kind: "retainage_mismatch",
      severity: "info",
      project_id: projectId,
      reference: `${orphanedRetainage.length} retainage record(s)`,
      description: `${money(totalOrphaned)} in retainage held but not linked to an invoice`,
      amount_cents: totalOrphaned,
      href: projectFinancialHref(projectId, "/receivables"),
    })
  }

  if (releasedWithoutInvoice.length > 0) {
    const amountCents = releasedWithoutInvoice.reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
    exceptions.push({
      id: `retainage-release-invoice-missing-${projectId}`,
      kind: "retainage_mismatch",
      severity: "critical",
      project_id: projectId,
      reference: `${releasedWithoutInvoice.length} released retainage record(s)`,
      description: `${money(amountCents)} is marked released or paid without a release invoice`,
      amount_cents: amountCents,
      href: projectFinancialHref(projectId, "/receivables"),
    })
  }

  for (const row of retainageRecords) {
    if (!row.release_invoice_id) continue
    const releaseInvoice = releaseInvoiceById.get(row.release_invoice_id)
    if (!releaseInvoice || releaseInvoice.status === "void") {
      exceptions.push({
        id: `retainage-release-invalid-${row.id}`,
        kind: "retainage_mismatch",
        severity: "critical",
        project_id: projectId,
        reference: `Retainage ${row.id.slice(0, 8)}`,
        description: `Retainage release for ${money(Number(row.amount_cents ?? 0))} points to a missing or void invoice`,
        amount_cents: Number(row.amount_cents ?? 0),
        source_type: "invoice",
        source_id: row.release_invoice_id,
        href: projectFinancialHref(projectId, `/receivables?invoice=${row.release_invoice_id}`),
      })
      continue
    }

    const invoicePaid = releaseInvoice.status === "paid" || Number(releaseInvoice.balance_due_cents ?? 0) === 0
    if ((row.status === "paid") !== invoicePaid) {
      exceptions.push({
        id: `retainage-payment-state-${row.id}`,
        kind: "retainage_mismatch",
        severity: "warning",
        project_id: projectId,
        reference: releaseInvoice.invoice_number
          ? `Invoice ${releaseInvoice.invoice_number}`
          : `Retainage ${row.id.slice(0, 8)}`,
        description: invoicePaid
          ? "Release invoice is paid but the retainage ledger is not marked paid"
          : "Retainage is marked paid but its release invoice still has an outstanding balance",
        amount_cents: Number(row.amount_cents ?? 0),
        source_type: "invoice",
        source_id: row.release_invoice_id,
        href: projectFinancialHref(projectId, `/receivables?invoice=${row.release_invoice_id}`),
      })
    }
  }

  return exceptions
}

// ─── Report ───────────────────────────────────────────────────────────────────

const CHECKS: Array<{
  name: string
  run: (ctx: OrgServiceContext, projectId: string) => Promise<ReconciliationException[]>
}> = [
  { name: "Invoice totals", run: checkInvoiceTotalMismatch },
  { name: "Budget/actuals tie-out", run: checkBudgetActualMismatch },
  { name: "Incurred/billable tie-out", run: checkIncurredBillableTieOut },
  { name: "Billable ledger job-cost links", run: checkBillableNoJobCost },
  { name: "Job-cost classification", run: checkJobCostUnclassified },
  { name: "Billed proof", run: checkBilledWithoutProof },
  { name: "Payment links", run: checkUnlinkedPayments },
  { name: "Retainage ledger", run: checkRetainageMismatch },
]

export async function getProjectReconciliationReport(
  projectId: string,
  orgId?: string,
): Promise<ProjectReconciliationReport> {
  const ctx = await requireOrgContext(orgId)

  await requireAuthorization({
    permission: "invoice.read",
    userId: ctx.userId,
    orgId: ctx.orgId,
    projectId,
    supabase: ctx.supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  const results = await Promise.allSettled(CHECKS.map((check) => check.run(ctx, projectId)))

  const exceptions: ReconciliationException[] = []
  const failedChecks: string[] = []
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      exceptions.push(...result.value)
    } else {
      failedChecks.push(CHECKS[index].name)
    }
  })

  return {
    project_id: projectId,
    queues: makeQueueSummaries(exceptions),
    exceptions,
    total_exception_count: exceptions.length,
    critical_count: exceptions.filter((ex) => ex.severity === "critical").length,
    warning_count: exceptions.filter((ex) => ex.severity === "warning").length,
    info_count: exceptions.filter((ex) => ex.severity === "info").length,
    is_clean: exceptions.length === 0,
    failed_checks: failedChecks,
    generated_at: new Date().toISOString(),
  }
}
