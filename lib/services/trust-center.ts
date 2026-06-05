/**
 * Trust Center & Reconciliation Service
 *
 * Phase 8 — Core reconciliation exception engine.
 * Queries every financial data source for a given project and produces a
 * complete list of exceptions grouped into the queues defined in §5.8.
 *
 * Each exception links to the source page so a controller can fix it.
 * The project Trust Center page can reach zero exceptions.
 */

import { differenceInCalendarDays, parseISO } from "date-fns"

import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { getProjectJobCostActualsByCostCode } from "@/lib/services/job-cost-actuals"
import {
  type TrustCenterException,
  type TrustCenterQueueSummary,
  type TrustCenterExceptionKind,
  type TrustCenterSeverity,
  type ProjectTrustCenterData,
  type PortfolioTrustCenterData,
  type PortfolioTrustCenterSummary,
  TRUST_CENTER_QUEUE_LABELS,
  TRUST_CENTER_QUEUE_ORDER,
} from "@/lib/financials/trust-center-types"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function projectFinancialHref(projectId: string, section = "") {
  return `/projects/${projectId}/financials${section}`
}

function getTodayUtcDate() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function getDaysUntil(dueDate?: string | null) {
  if (!dueDate) return null
  return differenceInCalendarDays(parseISO(dueDate), getTodayUtcDate())
}

function severityForAmount(cents: number, thresholdWarn = 50000, thresholdCritical = 200000): TrustCenterSeverity {
  if (Math.abs(cents) >= thresholdCritical) return "critical"
  if (Math.abs(cents) >= thresholdWarn) return "warning"
  return "info"
}

function makeQueueSummaries(exceptions: TrustCenterException[]): TrustCenterQueueSummary[] {
  const map = new Map<TrustCenterExceptionKind, TrustCenterQueueSummary>()

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
        label: TRUST_CENTER_QUEUE_LABELS[ex.kind],
        count: 1,
        total_cents: Math.abs(ex.amount_cents),
        severity: ex.severity,
      })
    }
  }

  return TRUST_CENTER_QUEUE_ORDER
    .filter((kind) => map.has(kind))
    .map((kind) => map.get(kind)!)
}

// ─── Project-Level Exception Checks ──────────────────────────────────────────

async function checkApprovedUnbilledCosts(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  const { data, error } = await ctx.supabase
    .from("billable_costs")
    .select("id, description, billable_cents, cost_cents, occurred_on, source_type, source_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .eq("status", "open")
    .eq("is_billable", true)

  if (error || !data) return []

  return data.map((cost: any) => ({
    id: `approved-unbilled-${cost.id}`,
    kind: "approved_unbilled" as const,
    severity: severityForAmount(cost.billable_cents ?? 0),
    project_id: projectId,
    reference: cost.description ?? `${cost.source_type ?? "Cost"} ${cost.id.slice(0, 8)}`,
    description: `Approved billable cost ($${((cost.billable_cents ?? 0) / 100).toLocaleString()}) not yet invoiced`,
    amount_cents: cost.billable_cents ?? 0,
    source_type: cost.source_type,
    source_id: cost.source_id,
    href: projectFinancialHref(projectId),
  }))
}

async function checkBilledWithoutProof(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  // Check project financial settings — only flag if proof is required
  const { data: settings } = await ctx.supabase
    .from("project_financial_settings")
    .select("proof_required")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  if (!settings?.proof_required) return []

  // Find billed costs (linked to an invoice) where source lacks proof
  const { data: billedCosts, error } = await ctx.supabase
    .from("billable_costs")
    .select("id, description, billable_cents, source_type, source_id, invoice_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .not("invoice_id", "is", null)
    .neq("status", "voided")

  if (error || !billedCosts) return []

  const exceptions: TrustCenterException[] = []

  for (const cost of billedCosts as any[]) {
    let hasProof = false

    if (cost.source_type === "vendor_bill_line") {
      const { data: billLine } = await ctx.supabase
        .from("bill_lines")
        .select("id, bill_id, metadata")
        .eq("id", cost.source_id)
        .maybeSingle()

      if (billLine) {
        const { data: bill } = await ctx.supabase
          .from("vendor_bills")
          .select("id, file_id, metadata")
          .eq("id", billLine.bill_id)
          .maybeSingle()

        hasProof = Boolean(bill?.file_id || (bill?.metadata as any)?.proof_file_id)
      }
    } else if (cost.source_type === "project_expense") {
      const { data: expense } = await ctx.supabase
        .from("project_expenses")
        .select("id, receipt_file_id")
        .eq("id", cost.source_id)
        .maybeSingle()

      hasProof = Boolean(expense?.receipt_file_id)
    } else if (cost.source_type === "time_entry") {
      // Time entries typically don't have proof files — skip unless custom proof
      hasProof = true
    }

    if (!hasProof) {
      exceptions.push({
        id: `billed-no-proof-${cost.id}`,
        kind: "billed_without_proof",
        severity: "warning",
        project_id: projectId,
        reference: cost.description ?? `Billed cost ${cost.id.slice(0, 8)}`,
        description: `Billed cost ($${((cost.billable_cents ?? 0) / 100).toLocaleString()}) has no source proof attached`,
        amount_cents: cost.billable_cents ?? 0,
        source_type: cost.source_type,
        source_id: cost.source_id,
        href: projectFinancialHref(projectId, `/receivables`),
      })
    }
  }

  return exceptions
}

async function checkBillableNoJobCost(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  const { data: billableCosts, error } = await ctx.supabase
    .from("billable_costs")
    .select("id, description, cost_cents, billable_cents, source_type, source_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .neq("status", "voided")

  if (error || !billableCosts) return []

  const sourceIds = (billableCosts as any[]).map((c) => c.id).filter(Boolean)
  if (sourceIds.length === 0) return []

  const { data: jobCostLinks } = await ctx.supabase
    .from("job_cost_entries")
    .select("billable_cost_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .eq("status", "posted")
    .not("billable_cost_id", "is", null)

  const linkedBillableCostIds = new Set((jobCostLinks ?? []).map((j: any) => j.billable_cost_id))

  return (billableCosts as any[])
    .filter((cost) => !linkedBillableCostIds.has(cost.id))
    .map((cost) => ({
      id: `billable-no-jce-${cost.id}`,
      kind: "billable_no_job_cost" as const,
      severity: "warning" as const,
      project_id: projectId,
      reference: cost.description ?? `Billable cost ${cost.id.slice(0, 8)}`,
      description: `Billable cost ($${((cost.cost_cents ?? 0) / 100).toLocaleString()}) has no matching job-cost entry`,
      amount_cents: cost.cost_cents ?? 0,
      source_type: cost.source_type,
      source_id: cost.source_id,
      href: projectFinancialHref(projectId, "/budget"),
    }))
}

async function checkJobCostUnclassified(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  const { data, error } = await ctx.supabase
    .from("job_cost_entries")
    .select("id, source_type, source_id, cost_cents, is_billable, billable_cost_id, metadata")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .eq("status", "posted")
    .is("billable_cost_id", null)

  if (error || !data) return []

  // Only flag entries that have no billable_cost_id but are marked is_billable — they should be linked
  return (data as any[])
    .filter((entry) => entry.is_billable === true)
    .map((entry) => ({
      id: `jce-unclassified-${entry.id}`,
      kind: "job_cost_unclassified" as const,
      severity: "info" as const,
      project_id: projectId,
      reference: `${entry.source_type ?? "Entry"} ${entry.id.slice(0, 8)}`,
      description: `Job-cost entry ($${((entry.cost_cents ?? 0) / 100).toLocaleString()}) marked billable but not linked to a billable cost row`,
      amount_cents: entry.cost_cents ?? 0,
      source_type: entry.source_type,
      source_id: entry.source_id,
      href: projectFinancialHref(projectId, "/budget"),
    }))
}

async function checkBillsWithoutCommitment(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  const { data, error } = await ctx.supabase
    .from("vendor_bills")
    .select("id, bill_number, total_cents, status, commitment_id, due_date")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .is("commitment_id", null)

  if (error || !data) return []

  return (data as any[])
    .filter((bill) => !["void", "voided", "cancelled"].includes(String(bill.status ?? "").toLowerCase()))
    .map((bill) => ({
      id: `bill-no-commit-${bill.id}`,
      kind: "bill_no_commitment" as const,
      severity: "info" as const,
      project_id: projectId,
      reference: bill.bill_number ? `Bill ${bill.bill_number}` : `Vendor bill ${bill.id.slice(0, 8)}`,
      description: `Vendor bill ($${((bill.total_cents ?? 0) / 100).toLocaleString()}) is not linked to any commitment/subcontract`,
      amount_cents: bill.total_cents ?? 0,
      href: projectFinancialHref(projectId, "/payables"),
    }))
}

async function checkUnlinkedPayments(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  const { data, error } = await ctx.supabase
    .from("payments")
    .select("id, amount_cents, method, created_at, invoice_id, bill_id, metadata")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .is("invoice_id", null)
    .is("bill_id", null)
    .neq("status", "voided")

  if (error || !data) return []

  return (data as any[]).map((payment) => ({
    id: `payment-unlinked-${payment.id}`,
    kind: "payment_unlinked" as const,
    severity: "warning" as const,
    project_id: projectId,
    reference: `Payment ${payment.id.slice(0, 8)}`,
    description: `Payment ($${((payment.amount_cents ?? 0) / 100).toLocaleString()}) not linked to any invoice or vendor bill`,
    amount_cents: payment.amount_cents ?? 0,
    href: projectFinancialHref(projectId, "/receivables"),
  }))
}

async function checkQboSyncErrors(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  const exceptions: TrustCenterException[] = []

  // Check invoices with QBO sync issues
  const { data: invoices } = await ctx.supabase
    .from("invoices")
    .select("id, invoice_number, title, total_cents, qbo_sync_status, metadata")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .in("qbo_sync_status", ["error", "pending", "failed"])

  for (const inv of (invoices ?? []) as any[]) {
    exceptions.push({
      id: `qbo-invoice-${inv.id}`,
      kind: "qbo_sync_error",
      severity: inv.qbo_sync_status === "error" || inv.qbo_sync_status === "failed" ? "warning" : "info",
      project_id: projectId,
      reference: inv.invoice_number ? `Invoice ${inv.invoice_number}` : inv.title ?? `Invoice ${inv.id.slice(0, 8)}`,
      description: `Invoice QBO sync status: ${inv.qbo_sync_status}`,
      amount_cents: inv.total_cents ?? 0,
      source_type: "invoice",
      source_id: inv.id,
      href: projectFinancialHref(projectId, `/receivables?invoice=${inv.id}`),
    })
  }

  // Check vendor bills with QBO sync issues
  const { data: bills } = await ctx.supabase
    .from("vendor_bills")
    .select("id, bill_number, total_cents, qbo_sync_status, metadata")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .in("qbo_sync_status", ["error", "pending", "failed"])

  for (const bill of (bills ?? []) as any[]) {
    exceptions.push({
      id: `qbo-bill-${bill.id}`,
      kind: "qbo_sync_error",
      severity: bill.qbo_sync_status === "error" || bill.qbo_sync_status === "failed" ? "warning" : "info",
      project_id: projectId,
      reference: bill.bill_number ? `Bill ${bill.bill_number}` : `Vendor bill ${bill.id.slice(0, 8)}`,
      description: `Vendor bill QBO sync status: ${bill.qbo_sync_status}`,
      amount_cents: bill.total_cents ?? 0,
      source_type: "vendor_bill",
      source_id: bill.id,
      href: projectFinancialHref(projectId, "/payables"),
    })
  }

  // Check project-scoped QBO sync records
  const { data: qboRecords } = await ctx.supabase
    .from("qbo_sync_records")
    .select("id, entity_type, entity_id, status, error_message")
    .eq("org_id", ctx.orgId)
    .in("status", ["error", "failed"])
    .limit(30)

  // Filter to project-relevant entities
  const projectInvoiceIds = new Set((invoices ?? []).map((i: any) => i.id))
  const projectBillIds = new Set((bills ?? []).map((b: any) => b.id))

  for (const record of (qboRecords ?? []) as any[]) {
    if (
      (record.entity_type === "invoice" && projectInvoiceIds.has(record.entity_id)) ||
      (record.entity_type === "vendor_bill" && projectBillIds.has(record.entity_id))
    ) {
      // Already covered by the direct QBO status checks above
      continue
    }
    // Skip records that clearly belong to other projects
    if (record.entity_type === "invoice" || record.entity_type === "vendor_bill") continue

    exceptions.push({
      id: `qbo-record-${record.id}`,
      kind: "qbo_sync_error",
      severity: "warning",
      project_id: projectId,
      reference: `${record.entity_type ?? "QBO"} sync`,
      description: record.error_message ?? "QBO sync error",
      amount_cents: 0,
      source_type: record.entity_type,
      source_id: record.entity_id,
      href: "/settings?tab=integrations",
    })
  }

  return exceptions
}

async function checkBudgetActualMismatch(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  try {
    const jobCostActuals = await getProjectJobCostActualsByCostCode({
      projectId,
      orgId: ctx.orgId,
      supabase: ctx.supabase,
    })

    const jceTotalCents = jobCostActuals.reduce((sum, row) => sum + row.actual_cents, 0)

    // Get budget actuals total from vendor bill lines (the old source) to compare
    const { data: billLines } = await ctx.supabase
      .from("bill_lines")
      .select("id, unit_cost_cents, quantity, bill:vendor_bills!inner(id, project_id, status)")
      .eq("bill.project_id", projectId)
      .in("bill.status", ["approved", "partial", "paid"])

    const billLineTotalCents = (billLines ?? []).reduce((sum, line: any) => {
      return sum + Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1))
    }, 0)

    // If bill line total != JCE total, there's a mismatch (could be expenses/time not posted)
    const mismatchCents = Math.abs(jceTotalCents - billLineTotalCents)
    if (mismatchCents > 100 && jceTotalCents > 0) {
      // This is expected when time/expenses contribute to actuals — only flag if JCE < bill lines
      // (which means job cost entries are missing some bill line postings)
      if (jceTotalCents < billLineTotalCents) {
        return [{
          id: `budget-mismatch-${projectId}`,
          kind: "budget_actual_mismatch" as const,
          severity: severityForAmount(billLineTotalCents - jceTotalCents, 10000, 100000),
          project_id: projectId,
          reference: "Budget / Job Cost Ledger",
          description: `Job-cost entries ($${(jceTotalCents / 100).toLocaleString()}) are less than approved vendor bill totals ($${(billLineTotalCents / 100).toLocaleString()}) — ${Math.round((billLineTotalCents - jceTotalCents) / 100).toLocaleString()} gap`,
          amount_cents: billLineTotalCents - jceTotalCents,
          href: projectFinancialHref(projectId, "/budget"),
        }]
      }
    }
  } catch {
    // If data load fails, don't block the trust center
  }

  return []
}

async function checkRetainageMismatch(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  const { data: retainageRecords } = await ctx.supabase
    .from("retainage")
    .select("id, amount_cents, status, invoice_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)

  if (!retainageRecords || retainageRecords.length === 0) return []

  const heldCents = (retainageRecords as any[])
    .filter((r) => r.status === "held")
    .reduce((sum, r) => sum + (r.amount_cents ?? 0), 0)

  const releasedCents = (retainageRecords as any[])
    .filter((r) => r.status === "released" || r.status === "invoiced" || r.status === "paid")
    .reduce((sum, r) => sum + (r.amount_cents ?? 0), 0)

  // Check for retainage records missing invoice links
  const orphanedRetainage = (retainageRecords as any[]).filter(
    (r) => r.status === "held" && !r.invoice_id
  )

  const exceptions: TrustCenterException[] = []

  if (orphanedRetainage.length > 0) {
    const totalOrphaned = orphanedRetainage.reduce((sum: number, r: any) => sum + (r.amount_cents ?? 0), 0)
    exceptions.push({
      id: `retainage-orphan-${projectId}`,
      kind: "retainage_mismatch",
      severity: "info",
      project_id: projectId,
      reference: `${orphanedRetainage.length} retainage record(s)`,
      description: `$${(totalOrphaned / 100).toLocaleString()} in retainage held but not linked to an invoice`,
      amount_cents: totalOrphaned,
      href: projectFinancialHref(projectId, "/receivables"),
    })
  }

  return exceptions
}

async function checkInvoiceTotalMismatch(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  const { data: invoices } = await ctx.supabase
    .from("invoices")
    .select("id, invoice_number, title, total_cents, tax_cents, status")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .not("status", "in", "(void,draft)")

  if (!invoices || invoices.length === 0) return []

  const exceptions: TrustCenterException[] = []

  for (const invoice of invoices as any[]) {
    const { data: lines } = await ctx.supabase
      .from("invoice_lines")
      .select("id, quantity, unit_price_cents")
      .eq("invoice_id", invoice.id)

    if (!lines || lines.length === 0) continue

    const computedSubtotal = lines.reduce((sum: number, line: any) => {
      return sum + Math.round(Number(line.quantity ?? 1) * Number(line.unit_price_cents ?? 0))
    }, 0)
    const computedTotal = computedSubtotal + Number(invoice.tax_cents ?? 0)

    const storedTotal = invoice.total_cents ?? 0
    const mismatch = Math.abs(storedTotal - computedTotal)

    // Allow for small rounding differences (tax, rounding)
    if (mismatch > 100) {
      exceptions.push({
        id: `invoice-total-${invoice.id}`,
        kind: "invoice_total_mismatch",
        severity: severityForAmount(mismatch, 1000, 10000),
        project_id: projectId,
        reference: invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : invoice.title ?? `Invoice ${invoice.id.slice(0, 8)}`,
        description: `Invoice total ($${(storedTotal / 100).toLocaleString()}) differs from computed line total ($${(computedTotal / 100).toLocaleString()}) by $${(mismatch / 100).toLocaleString()}`,
        amount_cents: mismatch,
        source_type: "invoice",
        source_id: invoice.id,
        href: projectFinancialHref(projectId, `/receivables?invoice=${invoice.id}`),
      })
    }
  }

  return exceptions
}

async function checkCashRisks(
  ctx: OrgServiceContext,
  projectId: string,
): Promise<TrustCenterException[]> {
  const exceptions: TrustCenterException[] = []

  // AP bills due in 30 days
  const { data: apBills } = await ctx.supabase
    .from("vendor_bills")
    .select("id, bill_number, total_cents, paid_cents, due_date, status")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .neq("status", "paid")
    .neq("status", "void")
    .not("due_date", "is", null)

  // AR invoices outstanding
  const { data: arInvoices } = await ctx.supabase
    .from("invoices")
    .select("id, invoice_number, total_cents, balance_due_cents, due_date, status")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .not("status", "in", "(paid,void)")
    .not("due_date", "is", null)

  const apDueWithin30 = (apBills ?? []).filter((bill: any) => {
    const daysUntil = getDaysUntil(bill.due_date)
    return daysUntil !== null && daysUntil <= 30 && daysUntil >= 0
  })

  const arDueWithin30 = (arInvoices ?? []).filter((inv: any) => {
    const daysUntil = getDaysUntil(inv.due_date)
    return daysUntil !== null && daysUntil <= 30 && daysUntil >= 0
  })

  const apDue30Total = apDueWithin30.reduce((sum, bill: any) => {
    return sum + Math.max(0, (bill.total_cents ?? 0) - (bill.paid_cents ?? 0))
  }, 0)

  const arDue30Total = arDueWithin30.reduce((sum, inv: any) => {
    return sum + (inv.balance_due_cents ?? inv.total_cents ?? 0)
  }, 0)

  if (apDue30Total > arDue30Total && apDue30Total > 0) {
    exceptions.push({
      id: `cash-risk-${projectId}`,
      kind: "cash_risk_ap_before_ar",
      severity: severityForAmount(apDue30Total - arDue30Total, 50000, 200000),
      project_id: projectId,
      reference: "30-Day Cash Position",
      description: `AP due ($${(apDue30Total / 100).toLocaleString()}) exceeds AR due ($${(arDue30Total / 100).toLocaleString()}) in next 30 days — net outflow of $${((apDue30Total - arDue30Total) / 100).toLocaleString()}`,
      amount_cents: apDue30Total - arDue30Total,
      href: projectFinancialHref(projectId, "/payables"),
    })
  }

  // Costs paid to vendors but not billed to owner
  const { data: paidBills } = await ctx.supabase
    .from("vendor_bills")
    .select("id, bill_number, total_cents, paid_cents, status")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .in("status", ["paid", "partial"])

  const { data: billedCosts } = await ctx.supabase
    .from("billable_costs")
    .select("id, cost_cents, invoice_id, source_type, source_id")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .not("invoice_id", "is", null)
    .neq("status", "voided")

  const billedVendorBillLineIds = new Set(
    (billedCosts ?? [])
      .filter((cost: any) => cost.source_type === "vendor_bill_line")
      .map((cost: any) => cost.source_id),
  )

  // Find bill lines that have been paid but whose costs haven't been billed
  const { data: paidBillLines } = await ctx.supabase
    .from("bill_lines")
    .select("id, unit_cost_cents, quantity, bill_id")
    .eq("org_id", ctx.orgId)
    .in("bill_id", (paidBills ?? []).map((b: any) => b.id))

  const unbilledPaidCents = (paidBillLines ?? [])
    .filter((line: any) => !billedVendorBillLineIds.has(line.id))
    .reduce((sum, line: any) => {
      return sum + Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1))
    }, 0)

  if (unbilledPaidCents > 10000) {
    exceptions.push({
      id: `cost-paid-not-billed-${projectId}`,
      kind: "cost_paid_not_billed",
      severity: severityForAmount(unbilledPaidCents),
      project_id: projectId,
      reference: "Paid But Unbilled Costs",
      description: `$${(unbilledPaidCents / 100).toLocaleString()} in vendor costs have been paid but not yet billed to the owner`,
      amount_cents: unbilledPaidCents,
      href: projectFinancialHref(projectId),
    })
  }

  // Costs billed to owner but unpaid
  const { data: billedUnpaid } = await ctx.supabase
    .from("invoices")
    .select("id, invoice_number, balance_due_cents, total_cents, status, due_date")
    .eq("org_id", ctx.orgId)
    .eq("project_id", projectId)
    .in("status", ["sent", "overdue", "partial"])

  const unpaidBilledCents = (billedUnpaid ?? []).reduce(
    (sum, inv: any) => sum + (inv.balance_due_cents ?? inv.total_cents ?? 0), 0
  )

  if (unpaidBilledCents > 10000) {
    const overdueCount = (billedUnpaid ?? []).filter((inv: any) => {
      const d = getDaysUntil(inv.due_date)
      return d !== null && d < 0
    }).length

    exceptions.push({
      id: `cost-billed-unpaid-${projectId}`,
      kind: "cost_billed_owner_unpaid",
      severity: overdueCount > 0 ? "warning" : "info",
      project_id: projectId,
      reference: `${(billedUnpaid ?? []).length} Outstanding Invoice(s)`,
      description: `$${(unpaidBilledCents / 100).toLocaleString()} billed to owner but unpaid${overdueCount > 0 ? ` (${overdueCount} overdue)` : ""}`,
      amount_cents: unpaidBilledCents,
      href: projectFinancialHref(projectId, "/receivables"),
    })
  }

  return exceptions
}

// ─── Main Project Trust Center ───────────────────────────────────────────────

export async function getProjectTrustCenterData(
  projectId: string,
  orgId?: string,
): Promise<ProjectTrustCenterData> {
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

  const checks = await Promise.allSettled([
    checkApprovedUnbilledCosts(ctx, projectId),
    checkBilledWithoutProof(ctx, projectId),
    checkBillableNoJobCost(ctx, projectId),
    checkJobCostUnclassified(ctx, projectId),
    checkBillsWithoutCommitment(ctx, projectId),
    checkUnlinkedPayments(ctx, projectId),
    checkQboSyncErrors(ctx, projectId),
    checkBudgetActualMismatch(ctx, projectId),
    checkRetainageMismatch(ctx, projectId),
    checkInvoiceTotalMismatch(ctx, projectId),
    checkCashRisks(ctx, projectId),
  ])

  const exceptions: TrustCenterException[] = []
  for (const result of checks) {
    if (result.status === "fulfilled") {
      exceptions.push(...result.value)
    }
  }

  const criticalCount = exceptions.filter((e) => e.severity === "critical").length
  const warningCount = exceptions.filter((e) => e.severity === "warning").length
  const infoCount = exceptions.filter((e) => e.severity === "info").length

  return {
    project_id: projectId,
    queues: makeQueueSummaries(exceptions),
    exceptions,
    total_exception_count: exceptions.length,
    critical_count: criticalCount,
    warning_count: warningCount,
    info_count: infoCount,
    is_clean: exceptions.length === 0,
    generated_at: new Date().toISOString(),
  }
}

// ─── Portfolio Trust Center Rollup ───────────────────────────────────────────

export async function getPortfolioTrustCenterData(orgId?: string): Promise<PortfolioTrustCenterData> {
  const ctx = await requireOrgContext(orgId)

  await requireAuthorization({
    permission: "invoice.read",
    userId: ctx.userId,
    orgId: ctx.orgId,
    supabase: ctx.supabase,
    logDecision: true,
    resourceType: "org",
    resourceId: ctx.orgId,
  })

  // Get all active projects
  const { data: projects } = await ctx.supabase
    .from("projects")
    .select("id, name, status")
    .eq("org_id", ctx.orgId)
    .in("status", ["planning", "bidding", "active", "on_hold"])
    .order("name")

  if (!projects || projects.length === 0) {
    return {
      projects: [],
      aggregate_queues: [],
      total_exception_count: 0,
      critical_count: 0,
      warning_count: 0,
      clean_project_count: 0,
      total_project_count: 0,
      generated_at: new Date().toISOString(),
    }
  }

  const allExceptions: TrustCenterException[] = []
  const projectSummaries: PortfolioTrustCenterSummary[] = []
  let cleanCount = 0

  // Run checks for all projects in parallel (with concurrency limit)
  const projectChunks: typeof projects[] = []
  const chunkSize = 5
  for (let i = 0; i < projects.length; i += chunkSize) {
    projectChunks.push(projects.slice(i, i + chunkSize))
  }

  for (const chunk of projectChunks) {
    const results = await Promise.allSettled(
      chunk.map(async (project: any) => {
        try {
          const data = await getProjectTrustCenterData(project.id, ctx.orgId)
          return { project, data }
        } catch {
          return { project, data: null }
        }
      })
    )

    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value.data) continue
      const { project, data } = result.value

      allExceptions.push(...data.exceptions)

      if (data.is_clean) {
        cleanCount += 1
      }

      // Find the most severe exception kind
      let topException: TrustCenterExceptionKind | null = null
      if (data.critical_count > 0) {
        topException = data.exceptions.find((e) => e.severity === "critical")?.kind ?? null
      } else if (data.warning_count > 0) {
        topException = data.exceptions.find((e) => e.severity === "warning")?.kind ?? null
      }

      projectSummaries.push({
        project_id: project.id,
        project_name: project.name ?? "Unnamed Project",
        total_exception_count: data.total_exception_count,
        critical_count: data.critical_count,
        warning_count: data.warning_count,
        info_count: data.info_count,
        top_exception: topException,
        total_exception_cents: data.exceptions.reduce((sum, e) => sum + Math.abs(e.amount_cents), 0),
        href: `/projects/${project.id}/financials/trust-center`,
      })
    }
  }

  // Sort: projects with critical exceptions first, then by exception count
  projectSummaries.sort((a, b) => {
    if (a.critical_count !== b.critical_count) return b.critical_count - a.critical_count
    if (a.warning_count !== b.warning_count) return b.warning_count - a.warning_count
    return b.total_exception_count - a.total_exception_count
  })

  return {
    projects: projectSummaries,
    aggregate_queues: makeQueueSummaries(allExceptions),
    total_exception_count: allExceptions.length,
    critical_count: allExceptions.filter((e) => e.severity === "critical").length,
    warning_count: allExceptions.filter((e) => e.severity === "warning").length,
    clean_project_count: cleanCount,
    total_project_count: projects.length,
    generated_at: new Date().toISOString(),
  }
}
