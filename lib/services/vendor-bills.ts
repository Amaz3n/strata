import type { SupabaseClient } from "@supabase/supabase-js"

import { COMPANY_PAYABLE_LIMIT } from "@/lib/financials/vendor-bill-constants"
import { randomUUID } from "node:crypto"
import { findDuplicatePayable } from "@/lib/services/payable-duplicate-check"
import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAuthorization } from "@/lib/services/authorization"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { vendorBillStatusUpdateSchema, vendorBillCreateSchema, type VendorBillStatusUpdate, type VendorBillCreate } from "@/lib/validation/vendor-bills"
import { getComplianceRules } from "@/lib/services/compliance"
import { propagateApprovalToLedger, voidBillableCostsForVendorBill } from "@/lib/services/cost-plus"
import { voidJobCostEntriesForVendorBill } from "@/lib/services/job-cost-actuals"
import { enqueueBillPaymentSync, enqueueVendorBillSync, voidBillPaymentInAccounting } from "@/lib/services/accounting-sync"
import { isSyncableVendorBillStatus } from "@/lib/financials/ledger-status"
import { APPROVAL_GATE_REASONS, loadApprovalGateSettings } from "@/lib/financials/approval-gates"
import { isCostDrivenBillingModel } from "@/lib/financials/billing-model"
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { ACTIVE_RUN_ITEM_STATUSES } from "@/lib/services/org-payables"
import { accountingReference, buildAccountingCoding, readCodingSource, type CodingSource } from "@/lib/services/accounting-coding"
import { assertBillReleasable, type PaymentReleaseEvidence } from "@/lib/services/payment-holds"
import { requireRecentPaymentStepUp } from "@/lib/services/payment-step-up"
import { evaluateAndAutoApproveVendorBill } from "@/lib/services/invoice-auto-approval"
import { learnCodingRule, recordCodingTouch, suggestCoding, type CodingLineSplit } from "@/lib/services/books/coding-rules"
import { readLineMatchAssessment, type PayableLineMatchAssessment } from "@/lib/financials/payable-line-match"
import { readEvenFlowAssessment, type EvenFlowPriceAssessment } from "@/lib/financials/even-flow-price-anomaly"
import { readBillScheduleAssessment, type BillScheduleAssessment } from "@/lib/financials/bill-schedule-crosscheck"
import { sendManualPaymentRemittanceAdvice } from "@/lib/services/vendor-remittance"
import { assertPayableApprovalPeriodOpen, notifyPayableApprovalDecision } from "@/lib/services/payable-approval-gate"

export type VendorBillStatus = "pending" | "approved" | "partial" | "paid" | "rejected"

/** Hard bound on the project payables query — lists that can grow unbounded get a cap. */
const PROJECT_PAYABLES_FETCH_LIMIT = 500
const BULK_APPROVAL_LIMIT = 500
export type PayableKind = "bill" | "vendor_credit"

export interface VendorBillPaymentSummary {
  id: string
  amount_cents: number
  method?: string
  reference?: string
  received_at?: string
  provider?: string
  status?: string
  qbo_id?: string
  vendor_credit_applied?: boolean
}

export interface VendorBillSummary {
  id: string
  org_id: string
  project_id: string
  project_name?: string
  commitment_id?: string
  commitment_title?: string
  commitment_total_cents?: number
  /** Sum of all bills (net of credits) recorded against the same commitment. */
  commitment_billed_cents?: number
  company_id?: string
  company_name?: string
  bill_number?: string
  status: VendorBillStatus | string
  bill_date?: string
  due_date?: string
  total_cents?: number
  currency: string
  submitted_by_contact_id?: string
  file_id?: string
  created_at: string
  updated_at?: string
  payment_reference?: string
  payment_method?: string
  preferred_payment_method?: "ach" | "check" | "wire" | "card" | "other"
  payment_memo?: string
  /** Who moves the money: Arc's rail, or the builder paying it themselves. */
  payment_channel?: "arc" | "external"
  preferred_funding_source_id?: string
  payment_schedule?: "on_approval" | "scheduled"
  scheduled_payment_date?: string
  preferred_approver_ids?: string[]
  paid_at?: string
  approved_at?: string
  approved_by?: string
  paid_cents?: number
  retainage_percent?: number
  retainage_cents?: number
  early_pay_discount_percent?: number
  early_pay_discount_days?: number
  lien_waiver_status?: string
  lien_waiver_received_at?: string
  rejected_at?: string
  rejected_by?: string
  rejection_reason?: string
  over_budget?: boolean
  actual_cost_code_id?: string
  actual_cost_code_code?: string
  actual_cost_code_name?: string
  qbo_id?: string
  qbo_synced_at?: string
  qbo_sync_status?: string
  qbo_sync_error?: string
  qbo_expense_account_id?: string
  qbo_expense_account_name?: string
  qbo_ap_account_id?: string
  qbo_ap_account_name?: string
  qbo_vendor_id?: string
  qbo_vendor_name?: string
  accounting_dimensions?: Record<string, { id: string; name: string }>
  company_qbo_vendor_id?: string | null
  company_qbo_vendor_name?: string | null
  actual_lines?: VendorBillActualLine[]
  /** This bill's portion attributed to the viewing project (multi-project bills). Defaults to total_cents. */
  project_amount_cents?: number
  /** True when the bill's lines span more than one project. */
  is_shared?: boolean
  /** Every project this bill touches (incl. the viewing one), with that project's share. */
  shared_projects?: VendorBillProjectShare[]
  payable_type: PayableKind
  qbo_pushable: boolean
  /** True when this payable originated from a QuickBooks import (QBO owns the record). */
  imported_from_qbo: boolean
  payments: VendorBillPaymentSummary[]
  /** Creation workspace state. Drafts are captured but intentionally not approvable. */
  is_draft: boolean
  coding_source?: CodingSource
  coding_confidence?: number
  /** The learned rule that coded this payable, when one did. */
  coding_rule_id?: string
  /** Vision-extraction confidence from the scan that created this payable. */
  extraction_confidence?: "high" | "medium" | "low"
  /** Advisory line-level match against the commitment, when one has been run. */
  line_match?: PayableLineMatchAssessment
  /** Advisory price comparison against sibling lots of the same house plan. */
  even_flow_price?: EvenFlowPriceAssessment
  /** Advisory crosscheck of the bill's date against the project schedule. */
  bill_schedule?: BillScheduleAssessment
}

export interface BulkVendorBillApprovalItem {
  id: string
  expected_updated_at?: string
}

/**
 * Approve a review queue as one database transaction. Validation, row locking,
 * status changes, audit evidence, events, and durable projection jobs either all
 * commit or none do. Ledger/accounting projections are idempotent and are also
 * attempted immediately so the normal UI does not wait for the worker.
 */
export async function approveVendorBillsAtomic(items: BulkVendorBillApprovalItem[], orgId?: string): Promise<{ approvedCount: number }> {
  const parsed = z
    .array(z.object({ id: z.string().uuid(), expected_updated_at: z.string().datetime({ offset: true }).optional() }))
    .min(1)
    .max(BULK_APPROVAL_LIMIT)
    .parse(items)
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length) throw new Error("Bulk approval contains duplicate payables")

  const context = await requireOrgContext(orgId)
  const service = createServiceSupabaseClient()
  const { data: bills, error } = await service
    .from("vendor_bills")
    .select("id,project_id,bill_date,metadata")
    .eq("org_id", context.orgId)
    .in(
      "id",
      parsed.map((item) => item.id),
    )
  if (error || (bills?.length ?? 0) !== parsed.length) throw new Error("One or more payables could not be found")
  if ((bills ?? []).some((bill) => (bill.metadata as Record<string, unknown> | null)?.creation_state === "draft")) {
    throw new Error("Complete every payable draft before bulk approval")
  }
  const projectIds = Array.from(new Set((bills ?? []).map((bill) => bill.project_id)))
  if (projectIds.some((projectId) => !projectId)) throw new Error("Every payable in a bulk approval must belong to a project")
  for (const projectId of projectIds as string[]) {
    await requireAuthorization({
      permission: "bill.approve",
      userId: context.userId,
      orgId: context.orgId,
      projectId,
      supabase: context.supabase,
      logDecision: true,
      resourceType: "project",
      resourceId: projectId,
    })
  }
  const outsideDesignatedRoute = (bills ?? []).some((bill) => {
    const metadata = (bill.metadata as Record<string, unknown> | null) ?? {}
    const ids = Array.isArray(metadata.preferred_approver_ids)
      ? metadata.preferred_approver_ids.filter((value): value is string => typeof value === "string")
      : []
    return ids.length > 0 && !ids.includes(context.userId)
  })
  if (outsideDesignatedRoute) {
    throw new Error("One or more payables are waiting for their designated approver")
  }

  // Same closed-period rule the single-bill and cost-inbox paths enforce.
  // Approving in a batch was the one way to post cost into a locked period.
  for (const bill of bills ?? []) {
    await assertPayableApprovalPeriodOpen({
      supabase: context.supabase,
      orgId: context.orgId,
      projectId: bill.project_id,
      billDate: bill.bill_date,
    })
  }

  const { data, error: rpcError } = await service.rpc("approve_vendor_bills_atomic", { p_org_id: context.orgId, p_actor_id: context.userId, p_items: parsed })
  if (rpcError) throw new Error(rpcError.message)

  // Fast path. The transaction inserted one durable outbox job per bill, so a
  // temporary projection failure here is retried without weakening approval.
  await Promise.allSettled(
    parsed.map(async (item) => {
      await propagateApprovalToLedger({ source: "vendor_bill", sourceId: item.id, orgId: context.orgId })
      await enqueueVendorBillSync(item.id, context.orgId)
      // The vendor hears the outcome whether their invoice was approved on its
      // own or as one of fifty. Only the single-bill path used to say anything.
      await notifyPayableApprovalDecision({ orgId: context.orgId, billId: item.id, kind: "approved" })
    }),
  )
  return { approvedCount: Number((data as Record<string, unknown> | null)?.approved_count ?? parsed.length) }
}

export const vendorBillSelect = `
  id, org_id, project_id, commitment_id, company_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, accounting_coding, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, early_pay_discount_percent, early_pay_discount_days, lien_waiver_status, lien_waiver_received_at, rejected_at, rejected_by, rejection_reason, qbo_id, qbo_synced_at, qbo_sync_status, qbo_sync_error, qbo_expense_account_id, qbo_expense_account_name, qbo_ap_account_id, qbo_ap_account_name, qbo_vendor_id, qbo_vendor_name,
  project:projects(id, name),
  company:companies!vendor_bills_company_id_fkey(id, name, qbo_vendor_id, qbo_vendor_name),
  commitment:commitments(id, title, total_cents, company:companies(id, name, qbo_vendor_id, qbo_vendor_name))
`

export interface VendorBillProjectShare {
  id: string
  name?: string
  amount_cents: number
}

export interface VendorBillActualLine {
  id?: string
  cost_code_id: string | null
  budget_line_id?: string | null
  cost_code_code?: string
  cost_code_name?: string
  description?: string
  amount_cents: number
  project_id?: string | null
  project_name?: string
  billable_to_customer: boolean
  qbo_expense_account_id?: string
  qbo_expense_account_name?: string
  qbo_ap_account_id?: string
  qbo_ap_account_name?: string
  qbo_vendor_id?: string
  qbo_vendor_name?: string
  accounting_dimensions?: Record<string, { id: string; name: string }>
}

function linesHaveQboExpenseCoding(lines: Array<{ qbo_expense_account_id?: string | null }>) {
  return lines.length > 0 && lines.every((line) => Boolean(line.qbo_expense_account_id))
}

// Returns the single value shared by every line, or undefined when the lines disagree
// (or none have a value). Used to surface per-line QBO coding as a bill-level chip.
function pickSharedLineValue(values: Array<string | null | undefined>): string | undefined {
  const distinct = new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))
  return distinct.size === 1 ? [...distinct][0] : undefined
}

interface CodingLesson {
  costCodeId: string | null
  budgetLineId: string | null
  /** Set only when the bill genuinely splits across more than one code. */
  lineSplits: CodingLineSplit[] | null
}

/**
 * What a saved bill teaches about how this vendor should be coded.
 *
 * Lines that agree on a code teach that code, however many of them there are.
 * Lines that disagree teach the split — weighted by share of the bill, in basis
 * points, so the pattern reapplies to a different total next month. A split is
 * only worth remembering when every line is coded and the amounts are positive;
 * a half-coded bill is a bill someone abandoned, not a pattern.
 */
function buildCodingLesson(
  lines: Array<{ cost_code_id?: string | null; budget_line_id?: string | null; amount_cents: number; description?: string | null }>,
): CodingLesson {
  if (lines.length === 0) return { costCodeId: null, budgetLineId: null, lineSplits: null }

  const codeOf = (line: { cost_code_id?: string | null; budget_line_id?: string | null }) => line.cost_code_id ?? line.budget_line_id ?? null
  const distinct = new Set(lines.map(codeOf))
  if (distinct.size === 1) {
    const [only] = [...distinct]
    return {
      costCodeId: only === null ? null : (lines[0].cost_code_id ?? null),
      budgetLineId: only === null ? null : (lines[0].budget_line_id ?? null),
      lineSplits: null,
    }
  }

  if (lines.some((line) => codeOf(line) === null || line.amount_cents <= 0)) {
    return { costCodeId: null, budgetLineId: null, lineSplits: null }
  }

  // Merge lines sharing a code before weighting: two rows on the same code are
  // one leg of the split, not two.
  const byCode = new Map<string, { costCodeId: string | null; budgetLineId: string | null; amountCents: number; description: string | null }>()
  for (const line of lines) {
    const key = `${line.cost_code_id ?? ""}:${line.budget_line_id ?? ""}`
    const entry = byCode.get(key)
    if (entry) {
      entry.amountCents += line.amount_cents
      entry.description = entry.description ?? line.description?.trim() ?? null
    } else {
      byCode.set(key, {
        costCodeId: line.cost_code_id ?? null,
        budgetLineId: line.budget_line_id ?? null,
        amountCents: line.amount_cents,
        description: line.description?.trim() || null,
      })
    }
  }
  if (byCode.size < 2) return { costCodeId: null, budgetLineId: null, lineSplits: null }

  const total = [...byCode.values()].reduce((sum, entry) => sum + entry.amountCents, 0)
  if (total <= 0) return { costCodeId: null, budgetLineId: null, lineSplits: null }

  const entries = [...byCode.values()]
  const splits: CodingLineSplit[] = entries.map((entry) => ({
    costCodeId: entry.costCodeId,
    budgetLineId: entry.budgetLineId,
    weightBp: Math.round((entry.amountCents / total) * 10_000),
    description: entry.description,
  }))
  // Weights must sum to exactly 10000 or the rule is discarded on read; the
  // rounding remainder lands on the largest leg, where it is least visible.
  const drift = 10_000 - splits.reduce((sum, split) => sum + split.weightBp, 0)
  if (drift !== 0) {
    let largestIndex = 0
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index].amountCents > entries[largestIndex].amountCents) largestIndex = index
    }
    splits[largestIndex].weightBp += drift
  }

  return { costCodeId: null, budgetLineId: null, lineSplits: splits }
}

/**
 * Apply a learned split to a real amount. Basis-point weights never divide a
 * total cleanly, so the remainder lands on the largest leg and the legs sum to
 * the total exactly — a coded bill that misses its own total cannot be approved.
 */
function splitAmountByWeights(
  totalCents: number,
  splits: CodingLineSplit[],
): Array<{ costCodeId: string | null; budgetLineId: string | null; amountCents: number; description: string | null }> {
  const allocated = splits.map((split) => ({
    costCodeId: split.costCodeId,
    budgetLineId: split.budgetLineId,
    amountCents: Math.round((totalCents * split.weightBp) / 10_000),
    description: split.description,
  }))
  const drift = totalCents - allocated.reduce((sum, entry) => sum + entry.amountCents, 0)
  if (drift !== 0 && allocated.length > 0) {
    let largestIndex = 0
    for (let index = 1; index < allocated.length; index += 1) {
      if (Math.abs(allocated[index].amountCents) > Math.abs(allocated[largestIndex].amountCents)) largestIndex = index
    }
    allocated[largestIndex].amountCents += drift
  }
  return allocated
}

async function buildBillLinesFromCommitment({
  supabase,
  orgId,
  commitmentId,
  billAmountCents,
  projectId,
  fallbackDescription,
}: {
  supabase: SupabaseClient
  orgId: string
  commitmentId: string
  billAmountCents: number
  projectId: string | null
  fallbackDescription: string
}) {
  const { data: lines, error } = await supabase
    .from("commitment_lines")
    .select("cost_code_id, budget_line_id, description, quantity, unit_cost_cents, scheduled_value_cents, sort_order")
    .eq("org_id", orgId)
    .eq("commitment_id", commitmentId)
    .order("sort_order", { ascending: true })

  if (error) {
    throw new Error(`Failed to inherit commitment coding: ${error.message}`)
  }

  const commitmentLines = lines ?? []
  if (commitmentLines.length === 0) return null

  const basis = commitmentLines.map((line) => {
    const scheduled = Number(line.scheduled_value_cents ?? 0)
    const lineTotal = Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1))
    return Math.max(0, scheduled || lineTotal)
  })
  const basisTotal = basis.reduce((sum, amount) => sum + amount, 0)
  if (basisTotal <= 0) return null

  let allocated = 0
  return commitmentLines.map((line, index) => {
    const amountCents = index === commitmentLines.length - 1 ? billAmountCents - allocated : Math.round((basis[index] / basisTotal) * billAmountCents)
    allocated += amountCents
    return {
      cost_code_id: line.cost_code_id ?? null,
      budget_line_id: line.budget_line_id ?? null,
      description: line.description?.trim() || fallbackDescription,
      amount_cents: amountCents,
      project_id: projectId,
      billable_to_customer: undefined,
      qbo_expense_account_id: undefined,
      qbo_expense_account_name: undefined,
      qbo_ap_account_id: undefined,
      qbo_ap_account_name: undefined,
      qbo_vendor_id: undefined,
      qbo_vendor_name: undefined,
      // Inherited from the commitment's scope, which carries no accounting dimensions.
      accounting_dimensions: undefined,
    }
  })
}

export function mapVendorBill(row: any, billLines?: any[], viewProjectId?: string, paymentRows?: any[]): VendorBillSummary {
  const metadata = row?.metadata ?? {}
  const payableType: PayableKind = metadata.source === "vendor_credit" ? "vendor_credit" : "bill"
  const company = row?.company ?? row?.commitment?.company ?? {}
  const expenseAccount = accountingReference(row?.accounting_coding, "expense_account")
  const apAccount = accountingReference(row?.accounting_coding, "ap_account")
  const counterparty = accountingReference(row?.accounting_coding, "counterparty")
  const lines = Array.isArray(billLines) ? billLines : []
  const actualLines = lines.map((line) => ({
    id: line.id ?? undefined,
    cost_code_id: line.cost_code_id,
    budget_line_id: line.budget_line_id ?? null,
    cost_code_code: line.cost_code?.code ?? undefined,
    cost_code_name: line.cost_code?.name ?? undefined,
    description: line.description ?? undefined,
    amount_cents: (line.unit_cost_cents ?? 0) * (line.quantity ?? 1),
    project_id: line.project_id ?? null,
    project_name: line.project?.name ?? undefined,
    billable_to_customer: line.metadata?.billable_to_customer === true,
    qbo_expense_account_id: line.metadata?.qbo_expense_account_id ?? undefined,
    qbo_expense_account_name: line.metadata?.qbo_expense_account_name ?? undefined,
    qbo_ap_account_id: line.metadata?.qbo_ap_account_id ?? undefined,
    qbo_ap_account_name: line.metadata?.qbo_ap_account_name ?? undefined,
    qbo_vendor_id: line.metadata?.qbo_vendor_id ?? undefined,
    qbo_vendor_name: line.metadata?.qbo_vendor_name ?? undefined,
    accounting_dimensions:
      line.metadata?.accounting_dimensions && typeof line.metadata.accounting_dimensions === "object"
        ? line.metadata.accounting_dimensions
        : line.metadata?.qbo_class_id
          ? { class: { id: line.metadata.qbo_class_id, name: line.metadata.qbo_class_name ?? "Class" } }
          : undefined,
  }))
  const firstActualLine = actualLines[0]

  // For split bills the QBO coding lives on the lines, not the bill (the bill-level
  // qbo_*_account_id columns stay null). When the bill is being shown for a specific
  // project, derive the displayed account chips from that project's line(s) so the list
  // reflects the coding the user actually set and synced — instead of "Choose account".
  const viewLines = viewProjectId ? actualLines.filter((line) => (line.project_id ?? row.project_id) === viewProjectId) : actualLines
  const lineExpenseAccountId = pickSharedLineValue(viewLines.map((line) => line.qbo_expense_account_id))
  const lineExpenseAccountName = pickSharedLineValue(viewLines.map((line) => line.qbo_expense_account_name))
  const lineApAccountId = pickSharedLineValue(viewLines.map((line) => line.qbo_ap_account_id))
  const lineApAccountName = pickSharedLineValue(viewLines.map((line) => line.qbo_ap_account_name))

  // Group the bill's value by the project each line is allocated to (a line's
  // effective project is its own project_id, falling back to the bill's primary).
  // With no coded lines the whole bill belongs to the primary project.
  const shareByProject = new Map<string, { amount_cents: number; name?: string }>()
  if (actualLines.length > 0) {
    for (const line of actualLines) {
      const pid = line.project_id ?? row.project_id
      if (!pid) continue
      const existing = shareByProject.get(pid) ?? { amount_cents: 0, name: undefined }
      existing.amount_cents += line.amount_cents
      if (!existing.name) existing.name = line.project_id ? line.project_name : (row.project?.name ?? undefined)
      shareByProject.set(pid, existing)
    }
  } else if (row.project_id) {
    shareByProject.set(row.project_id, { amount_cents: row.total_cents ?? 0, name: row.project?.name ?? undefined })
  }
  const sharedProjects: VendorBillProjectShare[] = Array.from(shareByProject.entries()).map(([id, share]) => ({
    id,
    name: share.name,
    amount_cents: share.amount_cents,
  }))
  const isShared = sharedProjects.length > 1
  const viewProjectShare = viewProjectId ? shareByProject.get(viewProjectId)?.amount_cents : undefined
  const projectAmountCents = viewProjectShare ?? row.total_cents ?? undefined
  const paidCents = typeof row.paid_cents === "number" ? row.paid_cents : 0
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    project_name: row.project?.name ?? undefined,
    commitment_id: row.commitment_id ?? undefined,
    commitment_title: row.commitment?.title ?? undefined,
    commitment_total_cents: row.commitment?.total_cents ?? undefined,
    company_id: company.id ?? row.company_id ?? undefined,
    company_name: company.name ?? row.company?.name ?? undefined,
    bill_number: row.bill_number ?? undefined,
    status: row.status ?? "pending",
    bill_date: row.bill_date ?? undefined,
    due_date: row.due_date ?? undefined,
    total_cents: row.total_cents ?? undefined,
    currency: row.currency ?? "usd",
    submitted_by_contact_id: row.submitted_by_contact_id ?? undefined,
    file_id: row.file_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    payment_reference: row.payment_reference ?? metadata.payment_reference ?? undefined,
    payment_method: row.payment_method ?? metadata.payment_method ?? undefined,
    preferred_payment_method:
      metadata.preferred_payment_method === "ach" ||
      metadata.preferred_payment_method === "check" ||
      metadata.preferred_payment_method === "wire" ||
      metadata.preferred_payment_method === "card" ||
      metadata.preferred_payment_method === "other"
        ? metadata.preferred_payment_method
        : undefined,
    payment_memo: typeof metadata.payment_memo === "string" ? metadata.payment_memo : undefined,
    payment_channel: metadata.payment_channel === "external" ? "external" : metadata.payment_channel === "arc" ? "arc" : undefined,
    preferred_funding_source_id: typeof metadata.preferred_funding_source_id === "string" ? metadata.preferred_funding_source_id : undefined,
    payment_schedule: metadata.payment_schedule === "scheduled" ? "scheduled" : metadata.payment_schedule === "on_approval" ? "on_approval" : undefined,
    scheduled_payment_date: typeof metadata.scheduled_payment_date === "string" ? metadata.scheduled_payment_date : undefined,
    preferred_approver_ids: Array.isArray(metadata.preferred_approver_ids)
      ? metadata.preferred_approver_ids.filter((value: unknown): value is string => typeof value === "string")
      : undefined,
    paid_at: row.paid_at ?? metadata.paid_at ?? undefined,
    approved_at: row.approved_at ?? metadata.approved_at ?? undefined,
    approved_by: row.approved_by ?? metadata.approved_by ?? undefined,
    paid_cents: paidCents,
    retainage_percent: row.retainage_percent ?? undefined,
    retainage_cents: row.retainage_cents ?? undefined,
    early_pay_discount_percent: row.early_pay_discount_percent == null ? undefined : Number(row.early_pay_discount_percent),
    early_pay_discount_days: row.early_pay_discount_days == null ? undefined : Number(row.early_pay_discount_days),
    lien_waiver_status: row.lien_waiver_status ?? undefined,
    lien_waiver_received_at: row.lien_waiver_received_at ?? undefined,
    rejected_at: row.rejected_at ?? undefined,
    rejected_by: row.rejected_by ?? undefined,
    rejection_reason: row.rejection_reason ?? undefined,
    over_budget: typeof metadata.over_budget === "boolean" ? metadata.over_budget : undefined,
    actual_cost_code_id: firstActualLine?.cost_code_id ?? undefined,
    actual_cost_code_code: firstActualLine?.cost_code_code ?? undefined,
    actual_cost_code_name: firstActualLine?.cost_code_name ?? undefined,
    qbo_id: row.qbo_id ?? undefined,
    qbo_synced_at: row.qbo_synced_at ?? undefined,
    qbo_sync_status: row.qbo_sync_status ?? undefined,
    qbo_sync_error: row.qbo_sync_error ?? undefined,
    qbo_expense_account_id: expenseAccount?.id ?? row.qbo_expense_account_id ?? metadata.qbo_expense_account_id ?? lineExpenseAccountId ?? undefined,
    qbo_expense_account_name: expenseAccount?.name ?? row.qbo_expense_account_name ?? metadata.qbo_expense_account_name ?? lineExpenseAccountName ?? undefined,
    qbo_ap_account_id: apAccount?.id ?? row.qbo_ap_account_id ?? metadata.qbo_ap_account_id ?? lineApAccountId ?? undefined,
    qbo_ap_account_name: apAccount?.name ?? row.qbo_ap_account_name ?? metadata.qbo_ap_account_name ?? lineApAccountName ?? undefined,
    qbo_vendor_id: counterparty?.id ?? company.qbo_vendor_id ?? row.qbo_vendor_id ?? metadata.qbo_vendor_id ?? undefined,
    qbo_vendor_name: counterparty?.name ?? company.qbo_vendor_name ?? row.qbo_vendor_name ?? metadata.qbo_vendor_name ?? undefined,
    company_qbo_vendor_id: company.qbo_vendor_id ?? undefined,
    company_qbo_vendor_name: company.qbo_vendor_name ?? undefined,
    actual_lines: actualLines,
    project_amount_cents: projectAmountCents,
    is_shared: isShared,
    shared_projects: sharedProjects,
    payable_type: payableType,
    qbo_pushable: payableType === "bill",
    imported_from_qbo: metadata.imported_from_qbo === true,
    is_draft: metadata.creation_state === "draft",
    coding_source: readCodingSource(metadata.coding_source) ?? undefined,
    coding_confidence: typeof metadata.coding_confidence === "number" ? metadata.coding_confidence : undefined,
    coding_rule_id: typeof metadata.coding_rule_id === "string" ? metadata.coding_rule_id : undefined,
    extraction_confidence:
      metadata.extraction_confidence === "high" || metadata.extraction_confidence === "medium" || metadata.extraction_confidence === "low"
        ? metadata.extraction_confidence
        : undefined,
    line_match: readLineMatchAssessment(metadata) ?? undefined,
    even_flow_price: readEvenFlowAssessment(metadata) ?? undefined,
    bill_schedule: readBillScheduleAssessment(metadata) ?? undefined,
    payments: (paymentRows ?? []).map((payment) => {
      const paymentMetadata = (payment.metadata as Record<string, any> | null) ?? {}
      return {
        id: payment.id,
        amount_cents: Number(payment.amount_cents ?? 0),
        method: payment.method ?? undefined,
        reference: payment.reference ?? undefined,
        received_at: payment.received_at ?? undefined,
        provider: payment.provider ?? undefined,
        status: payment.status ?? undefined,
        qbo_id: typeof paymentMetadata.qbo_id === "string" ? paymentMetadata.qbo_id : undefined,
        vendor_credit_applied: paymentMetadata.vendor_credit_applied === true,
      }
    }),
  }
}

async function replaceBillLineCoding(
  supabase: SupabaseClient,
  {
    orgId,
    billId,
    lines,
  }: {
    orgId: string
    billId: string
    lines: Array<{
      cost_code_id: string | null
      budget_line_id?: string | null
      description: string
      amount_cents: number
      project_id?: string | null
      billable_to_customer?: boolean
      qbo_expense_account_id?: string
      qbo_expense_account_name?: string
      qbo_ap_account_id?: string
      qbo_ap_account_name?: string
      qbo_vendor_id?: string
      qbo_vendor_name?: string
      accounting_dimensions?: Record<string, { id: string; name: string }>
    }>
  },
) {
  if (lines.length === 0) return

  const projectIds = Array.from(new Set(lines.map((line) => line.project_id).filter((id): id is string => typeof id === "string" && id.length > 0)))
  const { data: projectSettings, error: projectSettingsError } =
    projectIds.length === 0
      ? { data: [], error: null }
      : await supabase.from("project_financial_settings").select("project_id, billing_model").eq("org_id", orgId).in("project_id", projectIds)

  if (projectSettingsError) {
    throw new Error(`Failed to load project billing settings: ${projectSettingsError.message}`)
  }
  const billingModelByProject = new Map((projectSettings ?? []).map((settings) => [settings.project_id, settings.billing_model]))

  const costCodeIds = Array.from(new Set(lines.map((line) => line.cost_code_id))).filter((id): id is string => typeof id === "string" && id.length > 0)

  if (costCodeIds.length > 0) {
    const { data: costCodes, error: costCodeError } = await supabase.from("cost_codes").select("id").eq("org_id", orgId).in("id", costCodeIds)

    if (costCodeError || (costCodes ?? []).length !== costCodeIds.length) {
      throw new Error("Cost code not found")
    }
  }

  const { error: deleteError } = await supabase.from("bill_lines").delete().eq("org_id", orgId).eq("bill_id", billId)

  if (deleteError) {
    throw new Error(`Failed to update bill coding: ${deleteError.message}`)
  }

  const rows = lines.map((line, index) => {
    const billingModel = billingModelByProject.get(line.project_id ?? "")
    const costDriven = Boolean(billingModel && isCostDrivenBillingModel(billingModel as any))
    return {
      org_id: orgId,
      bill_id: billId,
      cost_code_id: line.cost_code_id,
      budget_line_id: line.budget_line_id ?? null,
      project_id: line.project_id ?? null,
      description: line.description,
      quantity: 1,
      unit: "LS",
      unit_cost_cents: line.amount_cents,
      sort_order: index,
      metadata: {
        source: "ap_review",
        billable_to_customer: costDriven && line.billable_to_customer !== false,
        qbo_expense_account_id: line.qbo_expense_account_id,
        qbo_expense_account_name: line.qbo_expense_account_name,
        qbo_ap_account_id: line.qbo_ap_account_id,
        qbo_ap_account_name: line.qbo_ap_account_name,
        qbo_vendor_id: line.qbo_vendor_id,
        qbo_vendor_name: line.qbo_vendor_name,
        accounting_dimensions: line.accounting_dimensions,
        qbo_class_id: line.accounting_dimensions?.class?.id,
        qbo_class_name: line.accounting_dimensions?.class?.name,
      },
    }
  })

  const { error: insertError } = await supabase.from("bill_lines").insert(rows)

  if (insertError) {
    throw new Error(`Failed to update bill coding: ${insertError.message}`)
  }
}

export async function listVendorBillsForCompany(companyId: string, orgId?: string): Promise<VendorBillSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "bill.read",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "company",
    resourceId: companyId,
  })

  const { data: commitments, error: commitmentError } = await supabase.from("commitments").select("id").eq("org_id", resolvedOrgId).eq("company_id", companyId)

  if (commitmentError) {
    throw new Error(`Failed to load commitments: ${commitmentError.message}`)
  }

  // A payable reaches a company two ways: through a commitment, or by naming
  // the company directly. Resolving only through commitments hid every bill
  // created from the desk, the portal or email ingest — which is most of them —
  // and returned an empty tab for any vendor without a contract.
  const commitmentIds = (commitments ?? []).map((row) => row.id).filter(Boolean)
  const orFilter = commitmentIds.length > 0
    ? `company_id.eq.${companyId},commitment_id.in.(${commitmentIds.join(",")})`
    : `company_id.eq.${companyId}`

  const { data, error } = await supabase
    .from("vendor_bills")
    .select(vendorBillSelect)
    .eq("org_id", resolvedOrgId)
    .or(orFilter)
    .order("created_at", { ascending: false })
    .limit(COMPANY_PAYABLE_LIMIT)

  if (error) {
    throw new Error(`Failed to list vendor bills: ${error.message}`)
  }

  // Hydrated, not raw-mapped: the company tab shows recorded payments, and
  // `mapVendorBill` alone leaves `payments` permanently empty.
  return hydrateVendorBills(supabase, resolvedOrgId, data ?? [])
}

/**
 * Hydrate raw `vendor_bills` rows into summaries: coded lines, recorded payments and
 * billed-to-date per commitment. Shared by the project list and the org-wide payables
 * desk so both see the same shape — one round of lookups for the whole page of bills.
 *
 * `viewProjectId` is the project the bills are being read *for* (drives each bill's
 * share of a multi-project split). Omit it org-wide, where no single project is the lens.
 */
export async function hydrateVendorBills(supabase: SupabaseClient, orgId: string, rows: any[], viewProjectId?: string): Promise<VendorBillSummary[]> {
  const billIds = rows.map((bill) => bill.id).filter(Boolean)
  if (billIds.length === 0) return []

  // Billed-to-date per commitment so the workspace can show remaining contract
  // value at coding/approval time.
  const commitmentIds = Array.from(new Set(rows.map((bill) => bill.commitment_id).filter(Boolean)))

  const [commitmentBillsResult, billLinesResult, paymentsResult] = await Promise.all([
    commitmentIds.length === 0
      ? Promise.resolve({ data: [] as any[], error: null })
      : supabase.from("vendor_bills").select("commitment_id, total_cents").eq("org_id", orgId).in("commitment_id", commitmentIds),
    supabase
      .from("bill_lines")
      .select(
        "id, bill_id, project_id, cost_code_id, budget_line_id, description, unit_cost_cents, quantity, metadata, cost_code:cost_codes(id, code, name), project:projects(id, name)",
      )
      .eq("org_id", orgId)
      .in("bill_id", billIds)
      .order("sort_order", { ascending: true }),
    supabase
      .from("payments")
      .select("id, bill_id, amount_cents, method, reference, received_at, provider, status, metadata")
      .eq("org_id", orgId)
      .in("bill_id", billIds)
      .eq("status", "succeeded")
      .order("received_at", { ascending: false }),
  ])

  if (commitmentBillsResult.error) {
    throw new Error(`Failed to load commitment billing totals: ${commitmentBillsResult.error.message}`)
  }
  if (billLinesResult.error) {
    throw new Error(`Failed to load bill coding: ${billLinesResult.error.message}`)
  }
  if (paymentsResult.error) {
    throw new Error(`Failed to load bill payments: ${paymentsResult.error.message}`)
  }

  const billedByCommitment = new Map<string, number>()
  for (const row of commitmentBillsResult.data ?? []) {
    billedByCommitment.set(row.commitment_id, (billedByCommitment.get(row.commitment_id) ?? 0) + Number(row.total_cents ?? 0))
  }

  const linesByBillId = new Map<string, any[]>()
  for (const line of billLinesResult.data ?? []) {
    const current = linesByBillId.get(line.bill_id) ?? []
    current.push(line)
    linesByBillId.set(line.bill_id, current)
  }

  const paymentsByBillId = new Map<string, any[]>()
  for (const payment of paymentsResult.data ?? []) {
    const current = paymentsByBillId.get(payment.bill_id) ?? []
    current.push(payment)
    paymentsByBillId.set(payment.bill_id, current)
  }

  return rows.map((bill) => {
    const summary = mapVendorBill(bill, linesByBillId.get(bill.id), viewProjectId, paymentsByBillId.get(bill.id))
    if (summary.commitment_id) {
      summary.commitment_billed_cents = billedByCommitment.get(summary.commitment_id)
    }
    return summary
  })
}

export async function listVendorBillsForProject(projectId: string, orgId?: string): Promise<VendorBillSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "bill.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  // Multi-project bills: include bills whose primary project is elsewhere but
  // which have at least one line allocated to this project. Bills already on
  // this project are excluded here because `project_id.eq` below finds them —
  // carrying them in the id list only inflated the request URL.
  const { data: allocatedRows, error: allocatedError } = await supabase
    .from("bill_lines")
    .select("bill_id,bill:vendor_bills!inner(project_id)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .neq("bill.project_id", projectId)
    .limit(2_000)

  if (allocatedError) {
    throw new Error(`Failed to resolve allocated bills: ${allocatedError.message}`)
  }

  const allocatedBillIds = Array.from(new Set((allocatedRows ?? []).map((row: any) => row.bill_id).filter(Boolean)))

  const baseSelect = supabase.from("vendor_bills").select(vendorBillSelect).eq("org_id", resolvedOrgId)

  const scoped =
    allocatedBillIds.length > 0 ? baseSelect.or(`project_id.eq.${projectId},id.in.(${allocatedBillIds.join(",")})`) : baseSelect.eq("project_id", projectId)

  const { data, error } = await scoped
    .order("due_date", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(PROJECT_PAYABLES_FETCH_LIMIT)

  if (error) {
    throw new Error(`Failed to list vendor bills: ${error.message}`)
  }

  return hydrateVendorBills(supabase, resolvedOrgId, data ?? [], projectId)
}

export interface VendorBillsPage {
  items: VendorBillSummary[]
  page: number
  pageSize: number
  total: number
  pageCount: number
}

export async function listVendorBillsPageForProject(
  projectId: string,
  input: { page?: number; pageSize?: number; queue?: string; search?: string } = {},
  orgId?: string,
): Promise<VendorBillsPage> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "bill.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })
  const page = Math.max(1, Math.floor(input.page ?? 1))
  const pageSize = Math.min(100, Math.max(10, Math.floor(input.pageSize ?? 50)))
  const queue = String(input.queue ?? "needs_review")
  const search = String(input.search ?? "")
    .trim()
    .slice(0, 120)
    .replace(/[,%()]/g, " ")
    .trim()

  // Only bills that live on ANOTHER project but have a line coded to this one.
  // The old query pulled every bill line on the project, which meant the id list
  // was dominated by bills already matched by `project_id.eq` — building an `.or()`
  // URL of thousands of UUIDs to re-select rows the other half of the filter had
  // already found. On a busy project that URL exceeded PostgREST's limit and the
  // page simply failed.
  const { data: allocatedRows, error: allocatedError } = await supabase
    .from("bill_lines")
    .select("bill_id,bill:vendor_bills!inner(project_id)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .neq("bill.project_id", projectId)
    .limit(2_000)
  if (allocatedError) throw new Error(`Failed to resolve allocated bills: ${allocatedError.message}`)
  const allocatedBillIds = Array.from(new Set((allocatedRows ?? []).map((row: any) => row.bill_id).filter(Boolean)))
  let query = supabase.from("vendor_bills").select(vendorBillSelect, { count: "exact" }).eq("org_id", resolvedOrgId)
  query = allocatedBillIds.length > 0 ? query.or(`project_id.eq.${projectId},id.in.(${allocatedBillIds.join(",")})`) : query.eq("project_id", projectId)
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  if (queue === "drafts") query = query.eq("metadata->>creation_state", "draft")
  else {
    if (queue !== "all") {
      query = query
        .or("metadata->>creation_state.is.null,metadata->>creation_state.neq.draft")
        // Vendor credits are money coming back, not an obligation to pay. The
        // org desk has always excluded them from its working tabs; this list
        // did not, so a credit sat in "Ready to pay" with a negative balance.
        .or("metadata->>source.is.null,metadata->>source.neq.vendor_credit")
    }
    if (queue === "paid") query = query.eq("status", "paid")
    else if (queue === "payable") {
      // "Ready to pay" means nobody has claimed it yet. A payable already
      // inside an active payment run is in flight, and offering it for payment
      // a second time is how a bill gets paid twice.
      query = query.in("status", ["approved", "partial"])
      const { data: claimedRows } = await supabase
        .from("payment_run_items")
        .select("bill_id")
        .eq("org_id", resolvedOrgId)
        .in("status", ACTIVE_RUN_ITEM_STATUSES)
        .limit(1_000)
      const claimedIds = Array.from(
        new Set((claimedRows ?? []).map((row) => row.bill_id).filter((id): id is string => typeof id === "string")),
      )
      if (claimedIds.length > 0) query = query.not("id", "in", `(${claimedIds.join(",")})`)
    } else if (queue === "needs_review") query = query.eq("status", "pending")
    else if (queue === "overdue") query = query.neq("status", "paid").lt("due_date", today)
    else if (queue === "due_soon") query = query.neq("status", "paid").gte("due_date", today).lte("due_date", soon)
  }
  if (search) query = query.or(`bill_number.ilike.%${search}%,qbo_vendor_name.ilike.%${search}%`)
  const { data, error, count } = await query
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)
  if (error) throw new Error(`Failed to list vendor bills: ${error.message}`)
  return {
    items: await hydrateVendorBills(supabase, resolvedOrgId, data ?? [], projectId),
    page,
    pageSize,
    total: count ?? 0,
    pageCount: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
  }
}

/**
 * The controls a recorded external payment now carries, mirroring the
 * electronic path as closely as a single-step action can.
 *
 * Full dual approval would mean routing checks through payment runs, which is
 * the same change that unlocks true joint checks — a real feature, not a
 * tightening. What is achievable here without inventing a lifecycle is genuine
 * separation of duties: the person releasing the money is not the person who
 * approved the obligation.
 */
/** Whether anyone other than this user could record the payment instead. */
async function orgHasAnotherPaymentReleaser(orgId: string, userId: string) {
  const service = createServiceSupabaseClient()
  const { data: roleRows } = await service.from("role_permissions").select("role_id").eq("permission_key", "payment.release")
  const roleIds = (roleRows ?? []).map((row) => row.role_id).filter(Boolean)
  if (roleIds.length === 0) return false
  const { count } = await service
    .from("memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "active")
    .in("role_id", roleIds)
    .neq("user_id", userId)
  return (count ?? 0) > 0
}

async function assertExternalPaymentControls(input: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  userId: string
  bill: { id: string; approved_by?: string | null; total_cents?: number | null; metadata?: Record<string, unknown> | null }
  amountCents: number
  checkNumber: string | null
  /** Other obligation decisions that must be independent of the releaser. */
  separationActorIds?: Array<string | null | undefined>
}) {
  const service = createServiceSupabaseClient()
  const { data: policy } = await service
    .from("payment_rail_policies")
    .select("enabled,approval_mode,per_payment_limit_cents")
    .eq("org_id", input.orgId)
    .maybeSingle()

  // A duplicate check number is the most common AP data error there is, and the
  // unique index will reject it anyway — catching it here turns a constraint
  // violation into a sentence that names the other payment.
  if (input.checkNumber) {
    // `limit(1)` rather than `maybeSingle()`: two prior payments sharing a
    // check number made `maybeSingle()` throw a row-count error instead of
    // reporting the duplicate it was looking for — the worst outcome of the
    // three. Any match at all is the answer.
    const { data: existingChecks, error: existingCheckError } = await service
      .from("payments")
      .select("id,bill_id,amount_cents")
      .eq("org_id", input.orgId)
      .eq("check_number", input.checkNumber.trim())
      .neq("status", "canceled")
      .limit(1)
    if (existingCheckError) {
      throw new Error(`Unable to check this check number for duplicates: ${existingCheckError.message}`)
    }
    if ((existingChecks ?? []).length > 0) {
      throw new Error(`Check number ${input.checkNumber.trim()} is already recorded against another payment. Void that one first if this is a correction.`)
    }
  }

  // CONTROL INTENT — dual control for auto-approved payables. Auto-approval
  // leaves `approved_by` null (the approver was a rule, not a person), which
  // would let the `approved_by === userId` equality checks below pass
  // trivially: one person could configure a rule, let it approve their bill,
  // and record the payment alone. When the bill carries the auto-approval
  // markers and the org actually has another payment releaser, the person
  // recording the payment must be independent of the bill — not the person who
  // created or edited it, and not the person who manages the rule that
  // approved it.
  const billMetadata = input.bill.metadata ?? {}
  const autoApprovedRuleId = typeof billMetadata.auto_approved_rule_id === "string" ? billMetadata.auto_approved_rule_id : null
  const wasAutoApproved = billMetadata.auto_approved === true || autoApprovedRuleId !== null
  if (wasAutoApproved && (await orgHasAnotherPaymentReleaser(input.orgId, input.userId))) {
    const { data: auditRows } = await service
      .from("audit_log")
      .select("actor_user_id")
      .eq("org_id", input.orgId)
      .eq("entity_type", "vendor_bill")
      .eq("entity_id", input.bill.id)
      .in("action", ["insert", "update"])
    const touchedBy = new Set((auditRows ?? []).map((row) => row.actor_user_id).filter(Boolean))
    let ruleManagerId: string | null = null
    if (autoApprovedRuleId) {
      const { data: rule } = await service
        .from("invoice_auto_approval_rules")
        .select("created_by")
        .eq("org_id", input.orgId)
        .eq("id", autoApprovedRuleId)
        .maybeSingle()
      ruleManagerId = rule?.created_by ?? null
    }
    if (touchedBy.has(input.userId) || ruleManagerId === input.userId) {
      throw new Error(
        "This payable was approved automatically, so someone who did not create or edit it — and does not manage its auto-approval rule — has to record the payment.",
      )
    }
  }

  // An org that never configured the electronic rail has not chosen an approval
  // mode, so the mode-dependent rules below have nothing to read. Separation of
  // duties is not mode-dependent, though, and defaulting it off for exactly the
  // orgs that pay by check aimed the control model at the lower-risk payments.
  //
  // It is applied here only when the org actually has someone else who could
  // release the payment. A two-person rule in a one-person AP department is not
  // a control, it is a wall — and small residential builders where the owner
  // both approves and pays are a real, supported way to run.
  const approvalActors = new Set(
    [input.bill.approved_by, ...(input.separationActorIds ?? [])].filter(
      (actorId): actorId is string => typeof actorId === "string",
    ),
  )
  if (!policy) {
    if (approvalActors.has(input.userId)) {
      if (await orgHasAnotherPaymentReleaser(input.orgId, input.userId)) {
        throw new Error("You approved this payable or credit, so someone else has to record its payment.")
      }
    }
    return
  }

  if (policy.approval_mode === "dual" && approvalActors.has(input.userId)) {
    throw new Error("You approved this payable or credit, so someone else has to record its payment. Your organization requires two people to release money.")
  }

  // Step-up on the same amounts that would trigger it electronically. A check is
  // not a lower-assurance instrument just because Arc did not print it.
  //
  // Not gated on `policy.enabled`: an org that has written down a per-payment
  // limit has stated the amount above which one person acting alone is too much
  // authority, and that judgement does not depend on whether the electronic
  // rail happens to be switched on. An org with no policy row at all has stated
  // nothing and is left to the separation-of-duties rule above — imposing a
  // second factor on a builder who never opted into payments would lock them
  // out of a workflow they already had.
  const limitCents = policy.per_payment_limit_cents == null ? null : Number(policy.per_payment_limit_cents)
  if (limitCents != null && input.amountCents > limitCents) {
    await requireRecentPaymentStepUp()
  }
}

const reverseManualPaymentSchema = z.object({
  paymentId: z.string().uuid("Invalid payment"),
  /** Omit to reverse whatever is left of the payment. */
  amountCents: z.number().int().positive().optional(),
  reason: z.string().trim().min(8, "Say why this payment is being reversed").max(500),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
})

export interface ManualPaymentReversalResult {
  reversalId: string
  billId: string
  billStatus: string
  paidCents: number
  amountCents: number
}

/**
 * Undo a payment somebody recorded by hand — the wrong amount, the wrong
 * payable, a check that never went out.
 *
 * This is the missing half of the manual payment lifecycle. Until now the only
 * reversal in AP was `record_ap_payment_reversal_atomic`, reachable solely from
 * a provider webhook, so a bookkeeper's typo was permanent while an ACH return
 * was not. `updateVendorBillStatus` even refuses to unapprove a paid payable
 * with "Reverse the payment first" — an instruction nothing could carry out.
 *
 * Rail payments are deliberately excluded: reversing a real ACH debit inside
 * Arc without the provider agreeing would make the subledger disagree with the
 * bank. Those still return through the provider.
 */
export async function reverseManualBillPayment(
  input: z.input<typeof reverseManualPaymentSchema>,
  orgId?: string,
): Promise<ManualPaymentReversalResult> {
  const parsed = reverseManualPaymentSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const service = createServiceSupabaseClient()

  const { data: payment, error: paymentError } = await service
    .from("payments")
    .select("id, bill_id, project_id, amount_cents, provider, status, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.paymentId)
    .maybeSingle()
  if (paymentError) throw new Error(`Unable to load the payment: ${paymentError.message}`)
  if (!payment || !payment.bill_id) throw new Error("Payment not found")

  // Reversing a payment releases the payable back to payable state, so it is
  // governed by the same permission as releasing money in the first place.
  await requireAuthorization({
    permission: "payment.release",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: payment.bill_id,
  })

  const { data: bill } = await service
    .from("vendor_bills")
    .select("id, status, paid_cents, total_cents, metadata, approved_by")
    .eq("org_id", resolvedOrgId)
    .eq("id", payment.bill_id)
    .maybeSingle()

  // Same control weight as recording the payment: an amount large enough to
  // need a second factor on the way out needs one on the way back.
  await assertExternalPaymentControls({
    supabase,
    orgId: resolvedOrgId,
    userId,
    bill: {
      id: String(payment.bill_id),
      approved_by: bill?.approved_by ?? null,
      total_cents: bill?.total_cents ?? null,
      metadata: (bill?.metadata as Record<string, unknown> | null) ?? null,
    },
    amountCents: parsed.amountCents ?? Number(payment.amount_cents ?? 0),
    checkNumber: null,
  })

  const { data: result, error: rpcError } = await service.rpc("reverse_manual_ap_payment_atomic", {
    p_org_id: resolvedOrgId,
    p_payment_id: parsed.paymentId,
    p_actor_id: userId,
    p_amount_cents: parsed.amountCents ?? null,
    p_reason: parsed.reason,
    p_idempotency_key: parsed.idempotencyKey ?? randomUUID(),
  })
  if (rpcError || !result || typeof result !== "object") {
    throw new Error(`Failed to reverse the payment: ${rpcError?.message ?? "No reversal result was returned"}`)
  }

  const billId = String(Reflect.get(result, "bill_id"))
  const billStatus = String(Reflect.get(result, "bill_status"))
  const paidCents = Number(Reflect.get(result, "paid_cents") ?? 0)
  const reversalId = String(Reflect.get(result, "id"))
  const amountCents = Number(Reflect.get(result, "amount_cents") ?? 0)

  // Throwing, not swallowed: if the accounting system still shows the payment
  // Arc has just reversed, the two disagree about cash and a human has to know.
  await voidBillPaymentInAccounting({ orgId: resolvedOrgId, paymentId: parsed.paymentId, reason: parsed.reason })

  await Promise.all([
    recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "vendor_bill_payment_reversed",
      entityType: "vendor_bill",
      entityId: billId,
      payload: {
        project_id: payment.project_id ?? null,
        payment_id: parsed.paymentId,
        reversal_id: reversalId,
        amount_cents: amountCents,
        bill_status: billStatus,
        paid_cents: paidCents,
        reason: parsed.reason,
      },
    }),
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "update",
      entityType: "vendor_bill",
      entityId: billId,
      before: { status: bill?.status ?? null, paid_cents: bill?.paid_cents ?? null },
      after: { status: billStatus, paid_cents: paidCents, reversal_id: reversalId },
    }),
  ])

  return { reversalId, billId, billStatus, paidCents, amountCents }
}

export async function updateVendorBillStatus({
  billId,
  input,
  orgId,
}: {
  billId: string
  input: VendorBillStatusUpdate
  orgId?: string
}): Promise<VendorBillSummary> {
  const parsed = vendorBillStatusUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: existingError } = await supabase
    .from("vendor_bills")
    .select(
      "id, org_id, project_id, commitment_id, company_id, bill_number, bill_date, due_date, status, total_cents, currency, file_id, metadata, accounting_coding, updated_at, approved_at, approved_by, paid_at, paid_cents, retainage_percent, retainage_cents, lien_waiver_status, qbo_sync_status, qbo_sync_error, qbo_expense_account_id, qbo_expense_account_name, qbo_ap_account_id, qbo_ap_account_name, qbo_vendor_id, qbo_vendor_name",
    )
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Vendor bill not found")
  }
  let replayedPayment: { bill_id: string | null; amount_cents: number | null } | null = null
  if (parsed.payment_idempotency_key) {
    const service = createServiceSupabaseClient()
    const { data: replay } = await service
      .from("payments")
      .select("bill_id,amount_cents")
      .eq("org_id", resolvedOrgId)
      .eq("idempotency_key", `manual-ap:${billId}:${parsed.payment_idempotency_key}`)
      .maybeSingle()
    if (replay) {
      if (replay.bill_id !== billId || (parsed.payment_amount_cents != null && Number(replay.amount_cents) !== parsed.payment_amount_cents)) {
        throw new Error("Payment idempotency key was already used for different contents")
      }
      replayedPayment = replay
    }
  }
  // Claim the row before doing anything else. Coding edits below replace
  // `bill_lines`, and `bill_lines_touch_books_parent` bumps the parent's
  // `updated_at` — so a guard applied to the final update would be comparing
  // against a token this very call had already invalidated, failing every
  // coded save after the lines were replaced and the cost ledger voided.
  // Claiming first makes the check atomic and aborts a genuine conflict while
  // the payable is still untouched.
  if (!replayedPayment && parsed.expected_updated_at) {
    const { data: claimed, error: claimError } = await supabase
      .from("vendor_bills")
      .update({ updated_at: new Date().toISOString() })
      .eq("org_id", resolvedOrgId)
      .eq("id", billId)
      .eq("updated_at", parsed.expected_updated_at)
      .select("updated_at")
      .maybeSingle()
    if (claimError) throw new Error(`Unable to open this payable for editing: ${claimError.message}`)
    if (!claimed) {
      throw new Error("This payable changed since you opened it. Refresh and review the latest values before saving.")
    }
  }
  const existingMetadata = (existing.metadata as Record<string, any> | null) ?? {}
  const isVendorCredit = existingMetadata.source === "vendor_credit"

  if (parsed.status === "approved" && existingMetadata.creation_state === "draft") {
    throw new Error("Complete the payable draft before approval")
  }

  // Approving is what posts the payable into the cost ledger, so it is a
  // posting into the bill date's accounting period. Only the cost inbox used to
  // check this, which meant the same payable could be approved into a locked
  // period or not depending on which screen you used.
  const isEnteringApproval = parsed.status === "approved" && existing.status !== "approved"
  if (isEnteringApproval) {
    await assertPayableApprovalPeriodOpen({
      supabase,
      orgId: resolvedOrgId,
      projectId: existing.project_id,
      billDate: parsed.bill_date ?? existing.bill_date ?? existing.due_date,
    })
  }

  if (isVendorCredit && parsed.status !== existing.status) {
    throw new Error("Vendor credits do not have a payment status lifecycle")
  }
  if (isVendorCredit && (parsed.payment_amount_cents !== undefined || parsed.payment_method !== undefined || parsed.payment_reference !== undefined)) {
    throw new Error("Payments cannot be recorded against a vendor credit")
  }

  // Reversing an approval is an approval decision, not an edit. Routing it to
  // `bill.write` let anyone who could correct a bill number also undo the
  // control that released money against it.
  const isUnapproval = !isVendorCredit && parsed.status === "pending" && ["approved", "partial", "paid"].includes(String(existing.status))

  const requiredPermission = isVendorCredit
    ? "bill.write"
    : parsed.status === "approved" || parsed.status === "rejected" || isUnapproval
      ? "bill.approve"
      : parsed.status === "paid" || parsed.status === "partial"
        ? "payment.release"
        : "bill.write"

  await requireAuthorization({
    permission: requiredPermission,
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: billId,
  })

  // A replay is still an invocation of the money-moving endpoint. Authorize it
  // exactly like the original attempt before returning the already-committed
  // result; idempotency must not become a read-side permission bypass.
  if (replayedPayment) {
    const service = createServiceSupabaseClient()
    const { data: current } = await service.from("vendor_bills").select(vendorBillSelect).eq("org_id", resolvedOrgId).eq("id", billId).maybeSingle()
    if (!current) throw new Error("Payment was recorded but the payable could not be reloaded")
    return mapVendorBill(current)
  }

  // A waiver status can unblock money. It is therefore a hold override, not a
  // general bill edit, even when no payment is recorded in the same request.
  if (parsed.lien_waiver_status !== undefined && parsed.lien_waiver_status !== existing.lien_waiver_status) {
    await requireAuthorization({
      permission: "payment.override_hold",
      userId,
      orgId: resolvedOrgId,
      projectId: existing.project_id,
      supabase,
      logDecision: true,
      resourceType: "vendor_bill",
      resourceId: billId,
    })
  }

  // A submitted payable's route is narrower than the role permission. The role
  // says who may ever approve bills; this frozen list says who was selected to
  // decide this one. Bills created before explicit routing have no list and keep
  // the legacy permission-only behavior.
  if (parsed.status === "approved" || parsed.status === "rejected") {
    const designatedApproverIds = Array.isArray(existingMetadata.preferred_approver_ids)
      ? existingMetadata.preferred_approver_ids.filter((value: unknown): value is string => typeof value === "string")
      : []
    if (designatedApproverIds.length > 0 && !designatedApproverIds.includes(userId)) {
      throw new Error("This payable is waiting for its designated approver.")
    }
  }

  if (
    (parsed.status === "paid" || parsed.status === "partial") &&
    existing.status !== "approved" &&
    existing.status !== "partial" &&
    existing.status !== "paid"
  ) {
    throw new Error("Bill must be approved before it can be marked paid")
  }

  // Money already left. Reverting the status would void the job-cost entries and
  // the billable costs while the payment rows stay exactly where they are, so
  // the ledger would stop agreeing with the bank over a click nobody thought was
  // destructive. Reversing a payment is its own operation.
  if (isUnapproval) {
    const { count: settledPayments, error: settledError } = await supabase
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("bill_id", billId)
      .in("status", ["succeeded", "completed"])
    if (settledError) throw new Error(`Unable to check recorded payments: ${settledError.message}`)
    if ((settledPayments ?? 0) > 0) {
      throw new Error("This payable has recorded payments, so it cannot be returned to pending. Reverse the payment first.")
    }
  }

  if (parsed.status === "rejected") {
    if (!parsed.rejection_reason) {
      throw new Error("Tell the vendor why this payable was rejected")
    }
    if (existing.status !== "pending") {
      throw new Error("Only a payable still awaiting approval can be rejected")
    }
  }

  if (existing.status === "rejected" && parsed.status !== "rejected" && parsed.status !== "pending") {
    throw new Error("Reopen this rejected payable before approving or paying it")
  }

  // The release gate was already shared with the electronic path. What was not
  // shared is everything around it: an ACH payment needed two designated
  // approvers, a fresh two-factor challenge and a frozen evidence snapshot,
  // while the same money recorded as a check needed one person and free text.
  // In construction the check payments carry the higher lien risk, so the
  // control model was pointing the wrong way.
  let externalReleaseEvidence: PaymentReleaseEvidence | null = null
  if (parsed.status === "paid" || parsed.status === "partial") {
    // `payment_channel` is a gate in both directions or it is not a gate. The
    // run preparer already refuses an `external` payable; a payable routed to
    // the rail must likewise not be quietly settled by hand, or the two paths
    // disagree about which one owns the money. Changing the channel is now an
    // ordinary edit, so redirecting a payable is a deliberate, audited act.
    const declaredChannel = parsed.payment_channel ?? existingMetadata.payment_channel
    if (declaredChannel === "arc") {
      throw new Error(
        "This payable is set to be paid through Arc. Change its payment method to “Paid outside Arc” before recording an external payment.",
      )
    }
    externalReleaseEvidence = await assertBillReleasable(billId, resolvedOrgId)
    await assertExternalPaymentControls({
      supabase,
      orgId: resolvedOrgId,
      userId,
      bill: existing,
      // `remainingCents` is computed further down; the outstanding balance is
      // derivable here from the row already in hand.
      amountCents:
        parsed.payment_amount_cents ??
        payableOutstandingCents({
          total_cents: existing.total_cents ?? 0,
          paid_cents: typeof existing.paid_cents === "number" ? existing.paid_cents : 0,
          retainage_cents: existing.retainage_cents ?? 0,
        }),
      checkNumber: parsed.check_number ?? null,
    })
  }

  if (parsed.status === "partial" && parsed.payment_amount_cents == null && existing.status !== "partial") {
    throw new Error("Payment amount required to mark bill as partial")
  }

  // Build update object with column values.
  const updateData: any = { status: parsed.status }
  if (existingMetadata.creation_state === "draft" && parsed.actual_lines?.length) {
    updateData.metadata = { ...existingMetadata, creation_state: "ready" }
  }
  if (parsed.bill_number !== undefined) {
    updateData.bill_number = parsed.bill_number
  }
  if (parsed.bill_date !== undefined) {
    updateData.bill_date = parsed.bill_date
  }
  if (parsed.due_date !== undefined) {
    updateData.due_date = parsed.due_date
  }
  const totalCents = existing.total_cents ?? 0
  const existingPaid = typeof existing.paid_cents === "number" ? existing.paid_cents : 0
  const remainingCents = payableOutstandingCents({ total_cents: totalCents, paid_cents: existingPaid, retainage_cents: existing.retainage_cents ?? 0 })

  if (parsed.payment_reference) {
    updateData.payment_reference = parsed.payment_reference
  }

  if (parsed.payment_method) {
    updateData.payment_method = parsed.payment_method
  }

  // Tracks whether any field that QuickBooks cares about (expense/AP account, vendor) changed.
  // Used below to re-push the recode to an already-linked QBO bill even when the bill isn't
  // transitioning into an approved/paid status (e.g. recoding a still-pending imported bill).
  let qboCodingChanged = false

  if (parsed.qbo_expense_account_id !== undefined) {
    updateData.qbo_expense_account_id = parsed.qbo_expense_account_id || null
    updateData.qbo_expense_account_name = parsed.qbo_expense_account_name || null
    if (!isVendorCredit && existing.qbo_expense_account_id !== parsed.qbo_expense_account_id) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
      qboCodingChanged = true
    }
  }

  if (parsed.qbo_ap_account_id !== undefined) {
    updateData.qbo_ap_account_id = parsed.qbo_ap_account_id || null
    updateData.qbo_ap_account_name = parsed.qbo_ap_account_name || null
    if (!isVendorCredit && existing.qbo_ap_account_id !== parsed.qbo_ap_account_id) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
      qboCodingChanged = true
    }
  }

  if (parsed.company_id !== undefined) {
    updateData.company_id = parsed.company_id
    if (parsed.company_id) {
      const { data: comp } = await supabase.from("companies").select("qbo_vendor_id, qbo_vendor_name, name").eq("id", parsed.company_id).maybeSingle()
      if (comp) {
        updateData.qbo_vendor_id = comp.qbo_vendor_id ?? null
        updateData.qbo_vendor_name = comp.qbo_vendor_name ?? comp.name ?? null
      }
    } else {
      updateData.qbo_vendor_id = null
      updateData.qbo_vendor_name = null
    }
    if (!isVendorCredit && existing.company_id !== parsed.company_id) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
      qboCodingChanged = true
    }
  }

  if (parsed.qbo_vendor_id !== undefined) {
    updateData.qbo_vendor_id = parsed.qbo_vendor_id || null
    updateData.qbo_vendor_name = parsed.qbo_vendor_name || null
    if (!isVendorCredit && existing.qbo_vendor_id !== parsed.qbo_vendor_id) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
      qboCodingChanged = true
    }
  }

  const existingExpenseAccount = accountingReference(existing.accounting_coding, "expense_account")
  const existingApAccount = accountingReference(existing.accounting_coding, "ap_account")
  const existingCounterparty = accountingReference(existing.accounting_coding, "counterparty")
  updateData.accounting_coding = buildAccountingCoding({
    expenseAccountId: updateData.qbo_expense_account_id ?? existingExpenseAccount?.id ?? existing.qbo_expense_account_id,
    expenseAccountName: updateData.qbo_expense_account_name ?? existingExpenseAccount?.name ?? existing.qbo_expense_account_name,
    apAccountId: updateData.qbo_ap_account_id ?? existingApAccount?.id ?? existing.qbo_ap_account_id,
    apAccountName: updateData.qbo_ap_account_name ?? existingApAccount?.name ?? existing.qbo_ap_account_name,
    counterpartyId: updateData.qbo_vendor_id ?? existingCounterparty?.id ?? existing.qbo_vendor_id,
    counterpartyName: updateData.qbo_vendor_name ?? existingCounterparty?.name ?? existing.qbo_vendor_name,
  })

  if (parsed.status === "approved" && !existing.approved_at) {
    updateData.approved_at = new Date().toISOString()
    updateData.approved_by = userId
  }

  if (parsed.status === "rejected") {
    updateData.rejected_at = new Date().toISOString()
    updateData.rejected_by = userId
    updateData.rejection_reason = parsed.rejection_reason
  }

  // Reopening clears the rejection rather than leaving a stale reason attached to
  // a payable that is live again.
  if (existing.status === "rejected" && parsed.status === "pending") {
    updateData.rejected_at = null
    updateData.rejected_by = null
    updateData.rejection_reason = null
  }

  if (parsed.status === "approved" && parsed.lien_waiver_status === undefined) {
    const rules = await getComplianceRules(resolvedOrgId).catch(() => ({
      require_lien_waiver: false,
      block_payment_on_missing_docs: true,
      warn_subcontract_execution_on_missing_docs: true,
      block_subcontract_execution_on_missing_docs: false,
    }))

    if (rules.require_lien_waiver && existing.lien_waiver_status !== "received") {
      updateData.lien_waiver_status = "requested"
      updateData.lien_waiver_received_at = null
    } else if (!rules.require_lien_waiver && !existing.lien_waiver_status) {
      updateData.lien_waiver_status = "not_required"
      updateData.lien_waiver_received_at = null
    }
  }

  const explicitLines = parsed.actual_lines && parsed.actual_lines.length > 0 ? parsed.actual_lines : null

  let actualLines = explicitLines
    ? explicitLines.map((line) => ({
        cost_code_id: line.cost_code_id ?? null,
        budget_line_id: line.budget_line_id ?? null,
        description: line.description?.trim() || (existing.bill_number ? `Bill ${existing.bill_number}` : "Vendor bill"),
        amount_cents: line.amount_cents,
        project_id: line.project_id ?? existing.project_id ?? null,
        billable_to_customer: line.billable_to_customer,
        qbo_expense_account_id: line.qbo_expense_account_id ?? parsed.qbo_expense_account_id ?? existing.qbo_expense_account_id ?? undefined,
        qbo_expense_account_name: line.qbo_expense_account_name ?? parsed.qbo_expense_account_name ?? existing.qbo_expense_account_name ?? undefined,
        qbo_ap_account_id: line.qbo_ap_account_id ?? parsed.qbo_ap_account_id ?? existing.qbo_ap_account_id ?? undefined,
        qbo_ap_account_name: line.qbo_ap_account_name ?? parsed.qbo_ap_account_name ?? existing.qbo_ap_account_name ?? undefined,
        qbo_vendor_id: line.qbo_vendor_id ?? parsed.qbo_vendor_id ?? existing.qbo_vendor_id ?? undefined,
        qbo_vendor_name: line.qbo_vendor_name ?? parsed.qbo_vendor_name ?? existing.qbo_vendor_name ?? undefined,
        accounting_dimensions: line.accounting_dimensions,
      }))
    : []

  const targetStatus = parsed.status ?? existing.status
  const isApprovedOrReleased = ["approved", "partial", "paid"].includes(targetStatus)

  // The coding as it stands *before* this edit, read while `bill_lines` still
  // holds it. Without it a touch cannot tell "the person recoded this bill"
  // from "the person saved this bill", and the rule engine cannot tell whether
  // it was confirmed or contradicted — the two defects that made the zero-touch
  // metric unreadable and retired rules on sight.
  const codingMayChange = Boolean(explicitLines) || Boolean(parsed.cost_code_id) || isApprovedOrReleased || qboCodingChanged
  let priorCoding: CodingLesson = { costCodeId: null, budgetLineId: null, lineSplits: null }
  if (codingMayChange) {
    const { data: priorLines, error: priorLinesError } = await supabase
      .from("bill_lines")
      .select("cost_code_id, budget_line_id, unit_cost_cents, quantity, description")
      .eq("org_id", resolvedOrgId)
      .eq("bill_id", billId)
    if (priorLinesError) throw new Error(`Failed to load current bill coding: ${priorLinesError.message}`)
    priorCoding = buildCodingLesson(
      (priorLines ?? []).map((line) => ({
        cost_code_id: line.cost_code_id,
        budget_line_id: line.budget_line_id,
        description: line.description,
        amount_cents: Math.round(Number(line.quantity ?? 1) * Number(line.unit_cost_cents ?? 0)),
      })),
    )
  }

  // When no explicit per-line coding is supplied we may still need to synthesize a single
  // full-total line — e.g. a quick approve from the list, or assigning one cost code to an
  // uncoded bill. Crucially, we must NOT do this when the bill is already split across
  // multiple lines, or we'd silently collapse the split back onto the bill's primary project.
  if (!explicitLines && (parsed.cost_code_id || isApprovedOrReleased)) {
    const { data: currentLines } = await supabase.from("bill_lines").select("id").eq("org_id", resolvedOrgId).eq("bill_id", billId)

    const existingLineCount = currentLines?.length ?? 0
    // Only (re)build a single line when the bill isn't already split: an uncoded bill (0 lines),
    // or recoding the lone line when an explicit cost code is being assigned.
    const shouldSynthesizeSingleLine = existingLineCount === 0 || (existingLineCount === 1 && Boolean(parsed.cost_code_id))

    if (shouldSynthesizeSingleLine) {
      const fallbackDescription = existing.bill_number ? `Bill ${existing.bill_number}` : "Vendor bill"
      const inheritedLines =
        !parsed.cost_code_id && existing.commitment_id
          ? await buildBillLinesFromCommitment({
              supabase,
              orgId: resolvedOrgId,
              commitmentId: existing.commitment_id,
              billAmountCents: totalCents,
              projectId: existing.project_id ?? null,
              fallbackDescription,
            })
          : null

      actualLines =
        inheritedLines && inheritedLines.length > 0
          ? inheritedLines
          : [
              {
                cost_code_id: parsed.cost_code_id ?? null,
                budget_line_id: null,
                description: fallbackDescription,
                amount_cents: totalCents,
                project_id: existing.project_id ?? null,
                billable_to_customer: undefined,
                qbo_expense_account_id: parsed.qbo_expense_account_id ?? existing.qbo_expense_account_id ?? undefined,
                qbo_expense_account_name: parsed.qbo_expense_account_name ?? existing.qbo_expense_account_name ?? undefined,
                qbo_ap_account_id: parsed.qbo_ap_account_id ?? existing.qbo_ap_account_id ?? undefined,
                qbo_ap_account_name: parsed.qbo_ap_account_name ?? existing.qbo_ap_account_name ?? undefined,
                qbo_vendor_id: parsed.qbo_vendor_id ?? existing.qbo_vendor_id ?? undefined,
                qbo_vendor_name: parsed.qbo_vendor_name ?? existing.qbo_vendor_name ?? undefined,
                // Dimensions live on the line, not the bill header, so a line Arc
                // synthesizes for an uncoded bill has none to inherit.
                accounting_dimensions: undefined,
              },
            ]
    }
  }

  if (actualLines.length > 0) {
    const hasInvalidSign = isVendorCredit ? actualLines.some((line) => line.amount_cents > 0) : actualLines.some((line) => line.amount_cents < 0)
    if (hasInvalidSign) {
      throw new Error(isVendorCredit ? "Vendor credit lines cannot be positive" : "Bill lines cannot be negative")
    }
    const actualTotal = actualLines.reduce((sum, line) => sum + line.amount_cents, 0)
    if (actualTotal !== totalCents) {
      throw new Error("Bill coding must equal the bill amount")
    }

    if (!isVendorCredit && isApprovedOrReleased && !updateData.qbo_expense_account_id && linesHaveQboExpenseCoding(actualLines)) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
    }

    if (["approved", "partial", "paid"].includes(String(existing.status))) {
      await voidBillableCostsForVendorBill({ billId, orgId: resolvedOrgId })
      await voidJobCostEntriesForVendorBill({ billId, orgId: resolvedOrgId })
    }

    await replaceBillLineCoding(supabase, { orgId: resolvedOrgId, billId, lines: actualLines })
  }

  if (!isVendorCredit && isApprovedOrReleased && existing.project_id) {
    const approvalSettings = await loadApprovalGateSettings({ supabase, orgId: resolvedOrgId, projectId: existing.project_id })

    if (approvalSettings.cost_codes_enabled) {
      let linesForApproval: Array<{ cost_code_id?: string | null }> = actualLines
      if (linesForApproval.length === 0) {
        const { data: currentLines, error: currentLinesError } = await supabase
          .from("bill_lines")
          .select("cost_code_id")
          .eq("org_id", resolvedOrgId)
          .eq("bill_id", billId)
        if (currentLinesError) throw new Error(`Failed to validate vendor bill cost codes: ${currentLinesError.message}`)
        linesForApproval = currentLines ?? []
      }

      if (linesForApproval.length === 0 || linesForApproval.some((line: any) => !line.cost_code_id)) {
        throw new Error(APPROVAL_GATE_REASONS.vendorBillLineMissingCostCode)
      }
    }
  }

  const shouldProcessPayment = parsed.status === "paid" || (parsed.status === "partial" && parsed.payment_amount_cents != null)
  let recordedPaymentId: string | null = null
  let paymentAmountCents: number | null = null

  if (shouldProcessPayment) {
    let paymentAmount = parsed.payment_amount_cents
    if (paymentAmount == null && parsed.status === "paid") {
      paymentAmount = remainingCents
    }

    if (paymentAmount == null) {
      throw new Error("Payment amount required for partial payments")
    }

    if (paymentAmount <= 0 && remainingCents > 0) {
      throw new Error("Payment amount must be positive")
    }

    if (paymentAmount > remainingCents) {
      throw new Error("Payment amount exceeds remaining balance")
    }

    paymentAmountCents = paymentAmount
    // Header/coding edits are saved before the money transaction. The RPC below
    // owns the status projection so this update can never clobber a concurrent
    // payment roll-up with a stale read.
    updateData.status = existing.status
  }

  if (parsed.early_pay_discount_percent !== undefined) {
    updateData.early_pay_discount_percent = parsed.early_pay_discount_percent
  }
  if (parsed.early_pay_discount_days !== undefined) {
    updateData.early_pay_discount_days = parsed.early_pay_discount_days
  }

  if (parsed.retainage_percent != null) {
    updateData.retainage_percent = parsed.retainage_percent
    updateData.retainage_cents = Math.round((totalCents * parsed.retainage_percent) / 100)
  }

  if (parsed.lien_waiver_status) {
    updateData.lien_waiver_status = parsed.lien_waiver_status
    updateData.lien_waiver_received_at = parsed.lien_waiver_status === "received" ? new Date().toISOString() : null
  }

  // Payment preferences live in metadata. Merged onto whatever this update has
  // already staged there so a channel change and an `over_budget` recompute in
  // the same save do not overwrite one another.
  const paymentPreferenceEntries: Array<[string, unknown]> = []
  if (parsed.payment_channel !== undefined) paymentPreferenceEntries.push(["payment_channel", parsed.payment_channel])
  if (parsed.preferred_payment_method !== undefined) {
    paymentPreferenceEntries.push(["preferred_payment_method", parsed.preferred_payment_method])
  }
  if (parsed.payment_memo !== undefined) paymentPreferenceEntries.push(["payment_memo", parsed.payment_memo])
  if (parsed.preferred_funding_source_id !== undefined) {
    paymentPreferenceEntries.push(["preferred_funding_source_id", parsed.preferred_funding_source_id])
  }
  if (parsed.payment_schedule !== undefined) paymentPreferenceEntries.push(["payment_schedule", parsed.payment_schedule])
  if (parsed.scheduled_payment_date !== undefined) {
    paymentPreferenceEntries.push(["scheduled_payment_date", parsed.scheduled_payment_date])
  }
  if (parsed.preferred_approver_ids !== undefined) {
    paymentPreferenceEntries.push(["preferred_approver_ids", parsed.preferred_approver_ids])
  }
  if (paymentPreferenceEntries.length > 0) {
    const nextMetadata: Record<string, unknown> = { ...existingMetadata, ...(updateData.metadata ?? {}) }
    for (const [key, value] of paymentPreferenceEntries) {
      if (value === null) delete nextMetadata[key]
      else nextMetadata[key] = value
    }
    updateData.metadata = nextMetadata
  }

  // `over_budget` was frozen at creation, which let a payable keep warning (or
  // keep quiet) long after sibling bills or line recoding changed the answer.
  // Recompute on every edit; the helper stays warning-tier metadata as before.
  if (existing.commitment_id && !isVendorCredit) {
    const overBudget = await computeCommitmentOverBudget(supabase, {
      orgId: resolvedOrgId,
      commitmentId: existing.commitment_id,
      totalCents,
      excludeBillId: billId,
    })
    if (overBudget !== (existingMetadata.over_budget === true)) {
      updateData.metadata = { ...existingMetadata, ...(updateData.metadata ?? {}), over_budget: overBudget }
    }
  }

  // No `updated_at` guard here: the claim at the top of this function already
  // took the row, and the coding write above has since moved the token.
  const updateResult = await supabase
    .from("vendor_bills")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .select(vendorBillSelect)
    .maybeSingle()
  let data = updateResult.data
  const error = updateResult.error

  if (error || !data) {
    throw new Error(`Failed to update vendor bill: ${error?.message ?? "the payable could not be saved"}`)
  }

  let finalStatus = updateData.status ?? parsed.status

  try {
    if (["approved", "partial", "paid"].includes(String(finalStatus))) {
      await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId })
    }

    if (["approved", "partial", "paid"].includes(String(existing.status)) && finalStatus === "pending") {
      await voidBillableCostsForVendorBill({ billId, orgId: resolvedOrgId })
      await voidJobCostEntriesForVendorBill({ billId, orgId: resolvedOrgId })
    }
  } catch (error) {
    await supabase
      .from("vendor_bills")
      .update({
        status: existing.status,
        approved_at: existing.approved_at ?? null,
        approved_by: existing.approved_by ?? null,
        paid_at: existing.paid_at ?? null,
        paid_cents: existing.paid_cents ?? null,
        qbo_sync_status: existing.qbo_sync_status ?? null,
        qbo_sync_error: existing.qbo_sync_error ?? null,
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", billId)

    const message = error instanceof Error ? error.message : String(error ?? "Unknown error")
    throw new Error(`Vendor bill status was not saved because the project cost ledger could not be updated: ${message}`)
  }

  if (shouldProcessPayment && paymentAmountCents != null && paymentAmountCents > 0) {
    const service = createServiceSupabaseClient()
    const releaseEvidence = externalReleaseEvidence
      ? {
          holds: externalReleaseEvidence.holdEvaluation,
          waiver: externalReleaseEvidence.waiverEvidence,
          construction: externalReleaseEvidence.constructionEvidence,
          subtier_waivers_required: externalReleaseEvidence.subtierWaiversRequired,
          captured_at: externalReleaseEvidence.capturedAt,
          recorded_by: userId,
        }
      : null
    const paymentIdempotencyKey = `manual-ap:${billId}:${parsed.payment_idempotency_key ?? randomUUID()}`
    const { data: paymentResult, error: paymentError } = await service.rpc("record_manual_ap_payment_atomic", {
      p_org_id: resolvedOrgId,
      p_bill_id: billId,
      p_actor_id: userId,
      p_amount_cents: paymentAmountCents,
      p_currency: existing.currency ?? "usd",
      p_method: parsed.payment_method ?? "check",
      p_reference: parsed.payment_reference ?? null,
      p_check_number: parsed.check_number ?? null,
      p_received_at: parsed.payment_date ? `${parsed.payment_date}T12:00:00.000Z` : new Date().toISOString(),
      p_release_evidence: releaseEvidence,
      p_idempotency_key: paymentIdempotencyKey,
    })
    if (paymentError || !paymentResult || typeof paymentResult !== "object") {
      throw new Error(`Failed to record bill payment: ${paymentError?.message ?? "No payment result was returned"}`)
    }
    recordedPaymentId = String(Reflect.get(paymentResult, "payment_id"))
    const refreshed = await service.from("vendor_bills").select(vendorBillSelect).eq("org_id", resolvedOrgId).eq("id", billId).maybeSingle()
    if (refreshed.error || !refreshed.data) throw new Error(`Payment was recorded but the payable could not be reloaded: ${refreshed.error?.message}`)
    data = refreshed.data
    finalStatus = String(data.status)
  }

  // Push to the accounting system when either (a) the bill enters a syncable state, or (b) its
  // accounting coding (expense/AP account, vendor) changed and the bill is already linked to an
  // external record — so recoding a still-pending or imported bill flows the new account back.
  // The syncable set is declared once in `lib/financials/ledger-status.ts`; it is deliberately a
  // different question from `PAYABLE_VENDOR_BILL_STATUSES`, so read the note there before editing.
  // enqueueVendorBillSync is the durable, deduped path: it respects auto-sync, skips inbound-only
  // imports (isSyncPushBlocked), and is drained with retries by the process-outbox cron.
  const billLinkedToQbo = Boolean(data.qbo_id)
  const shouldEnqueueForStatus = isSyncableVendorBillStatus(finalStatus)
  const shouldEnqueueForRecode = billLinkedToQbo && qboCodingChanged
  if (shouldEnqueueForStatus || shouldEnqueueForRecode) {
    await enqueueVendorBillSync(billId, resolvedOrgId)
  }
  if (recordedPaymentId) {
    await enqueueBillPaymentSync(recordedPaymentId, resolvedOrgId)
    // Best effort by design: the money is already recorded, and a mail failure
    // must not undo it. The vendor being told is not conditional on the rail.
    await sendManualPaymentRemittanceAdvice({ orgId: resolvedOrgId, paymentId: recordedPaymentId }).catch((error) =>
      console.warn("Vendor remittance advice was not sent", error),
    )
  }

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "vendor_bill", entityId: billId, before: existing, after: data })

  // Approval and rejection are their own events. Collapsing them into
  // `vendor_bill_updated` — which has no recipient set and is not a notification
  // type — is why a submitter was never told either way, and why a rejected
  // invoice could only be discovered by asking.
  const lifecycleEventType =
    finalStatus === "paid"
      ? "vendor_bill_paid"
      : finalStatus === "rejected"
        ? "vendor_bill_rejected"
        : finalStatus === "approved" && existing.status !== "approved"
          ? "vendor_bill_approved"
          : "vendor_bill_updated"

  const lifecycleEvent = await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: lifecycleEventType,
    entityType: "vendor_bill",
    entityId: billId,
    payload: {
      status: finalStatus,
      project_id: existing.project_id,
      company_id: existing.company_id,
      bill_number: existing.bill_number,
      amount_cents: existing.total_cents,
      submitted_by_user_id: typeof existingMetadata.submitted_by_user_id === "string" ? existingMetadata.submitted_by_user_id : undefined,
      rejection_reason: finalStatus === "rejected" ? parsed.rejection_reason : undefined,
      cost_code_id: parsed.cost_code_id,
      actual_lines: parsed.actual_lines,
      payment_reference: parsed.payment_reference,
      payment_method: parsed.payment_method,
      payment_date: parsed.payment_date,
      payment_amount_cents: parsed.payment_amount_cents,
      lien_waiver_status: parsed.lien_waiver_status,
      retainage_percent: parsed.retainage_percent,
      qbo_expense_account_id: parsed.qbo_expense_account_id,
      qbo_ap_account_id: parsed.qbo_ap_account_id,
      qbo_vendor_id: parsed.qbo_vendor_id,
    },
  })

  // The vendor on the payable hears the outcome directly, whether they uploaded
  // the invoice or the builder entered it. Best effort: the decision is already
  // recorded and is not undone by a mail failure.
  if (lifecycleEventType === "vendor_bill_approved" || lifecycleEventType === "vendor_bill_rejected") {
    await notifyPayableApprovalDecision({
      orgId: resolvedOrgId,
      billId,
      kind: lifecycleEventType === "vendor_bill_approved" ? "approved" : "rejected",
      reason: parsed.rejection_reason ?? null,
      eventId: lifecycleEvent.id,
    })
  }

  // What this bill teaches the rule engine. A single line teaches its code; a
  // bill whose lines all carry the same code teaches that code just as well.
  // Bills that genuinely split across codes used to teach nothing at all, which
  // is backwards — a vendor who always splits the same way is the most
  // predictable vendor there is, so the split itself is the lesson.
  const learnedLine = actualLines.length === 1 ? actualLines[0] : null
  const codingLesson = buildCodingLesson(actualLines)
  const codingWasTouched = Boolean(learnedLine?.cost_code_id || codingLesson.costCodeId || codingLesson.lineSplits || parsed.cost_code_id || qboCodingChanged)
  if (codingWasTouched) {
    const nextCostCodeId = learnedLine?.cost_code_id ?? codingLesson.costCodeId ?? parsed.cost_code_id ?? null
    const nextBudgetLineId = learnedLine?.budget_line_id ?? codingLesson.budgetLineId ?? null
    const appliedRuleId = typeof existingMetadata.coding_rule_id === "string" ? existingMetadata.coding_rule_id : null
    await recordCodingTouch({
      entityType: "vendor_bill",
      entityId: billId,
      changes: [
        { field: "cost_code", previousValue: priorCoding.costCodeId, nextValue: nextCostCodeId },
        { field: "budget_line", previousValue: priorCoding.budgetLineId, nextValue: nextBudgetLineId },
      ],
      codingSource: readCodingSource(existingMetadata.coding_source),
      codingRuleId: appliedRuleId,
      projectId: existing.project_id,
      orgId: resolvedOrgId,
    })
    await learnCodingRule({
      companyId: parsed.company_id ?? existing.company_id,
      vendorName: parsed.qbo_vendor_name ?? existing.qbo_vendor_name,
      costCodeId: nextCostCodeId,
      budgetLineId: nextBudgetLineId,
      lineSplits: codingLesson.lineSplits,
      accountingCoding: updateData.accounting_coding,
      appliedRuleId,
      projectId: existing.project_id,
      orgId: resolvedOrgId,
    })
  }

  await evaluateAndAutoApproveVendorBill({ orgId: resolvedOrgId, billId: data.id as string }).catch((error) =>
    console.warn("Invoice auto-approval evaluation failed", error),
  )

  return mapVendorBill(data)
}

export async function createProjectVendorBill({
  projectId,
  input,
  orgId,
}: {
  projectId: string
  input: VendorBillCreate
  orgId?: string
}): Promise<VendorBillSummary> {
  const parsed = vendorBillCreateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  let commitment: { id: string; total_cents: number | null; company_id?: string | null } | null = null
  if (parsed.commitment_id) {
    const { data, error: commitmentError } = await supabase
      .from("commitments")
      .select("id, total_cents, company_id")
      .eq("id", parsed.commitment_id)
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .maybeSingle()

    if (commitmentError || !data) {
      throw new Error("Commitment not found")
    }
    commitment = data
  }

  let companyId: string | null = parsed.company_id ?? commitment?.company_id ?? null
  if (companyId) {
    const { data: company, error: companyError } = await supabase.from("companies").select("id").eq("org_id", resolvedOrgId).eq("id", companyId).maybeSingle()
    if (companyError || !company) {
      throw new Error("Arc vendor not found")
    }
  } else if (!parsed.commitment_id && parsed.vendor_name?.trim()) {
    const { data: company } = await supabase
      .from("companies")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .ilike("name", parsed.vendor_name.trim())
      .is("metadata->>archived_at", null)
      .limit(1)
      .maybeSingle()
    companyId = (company?.id as string | undefined) ?? null
  }

  const vendorName = parsed.vendor_name?.trim() || parsed.qbo_vendor_name?.trim() || null
  const explicitLines = parsed.actual_lines ?? []
  if (explicitLines.some((line) => line.project_id && line.project_id !== projectId)) {
    throw new Error("Create the payable first before splitting it across projects")
  }
  if (explicitLines.length > 0 && explicitLines.reduce((sum, line) => sum + line.amount_cents, 0) !== parsed.total_cents) {
    throw new Error("Payable coding lines must add up to the invoice total")
  }
  const firstExplicitLine = explicitLines[0]
  const explicitAccountingCoding = firstExplicitLine
    ? buildAccountingCoding({
        expenseAccountId: firstExplicitLine.qbo_expense_account_id,
        expenseAccountName: firstExplicitLine.qbo_expense_account_name,
        apAccountId: firstExplicitLine.qbo_ap_account_id,
        apAccountName: firstExplicitLine.qbo_ap_account_name,
        classId: firstExplicitLine.accounting_dimensions?.class?.id,
        className: firstExplicitLine.accounting_dimensions?.class?.name,
        counterpartyId: parsed.qbo_vendor_id,
        counterpartyName: parsed.qbo_vendor_name || parsed.vendor_name,
      })
    : null
  const codingSuggestion =
    explicitLines.length === 0 ? await suggestCoding({ companyId, vendorName, memo: parsed.description, projectId, orgId: resolvedOrgId }) : null

  const duplicate = await findDuplicatePayable({
    supabase,
    orgId: resolvedOrgId,
    billNumber: parsed.bill_number,
    companyId,
    totalCents: parsed.total_cents,
    billDate: parsed.bill_date ?? null,
    vendorAliases: { accountingVendorId: parsed.qbo_vendor_id ?? null, vendorName },
  })
  if (duplicate) {
    throw new Error(duplicate.reason)
  }

  const isOverBudget =
    parsed.commitment_id && commitment
      ? await computeCommitmentOverBudget(supabase, { orgId: resolvedOrgId, commitmentId: parsed.commitment_id, totalCents: parsed.total_cents })
      : false

  const { data, error } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: resolvedOrgId,
      project_id: projectId,
      commitment_id: parsed.commitment_id ?? null,
      company_id: companyId,
      bill_number: parsed.bill_number.trim(),
      total_cents: parsed.total_cents,
      currency: "usd",
      status: "pending",
      bill_date: parsed.bill_date,
      tax_jurisdiction_id: parsed.tax_jurisdiction_id ?? null,
      tax_included_cents: parsed.tax_included_cents ?? 0,
      use_tax_accrued_cents: parsed.use_tax_accrued_cents ?? 0,
      due_date: parsed.due_date ?? null,
      file_id: parsed.file_id ?? null,
      submitted_by_contact_id: null,
      metadata: {
        description: parsed.description,
        submitted_by_user_id: userId,
        vendor_name: vendorName ?? undefined,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        internal_upload: true,
        over_budget: isOverBudget,
        creation_state: parsed.creation_state,
        preferred_payment_method: parsed.preferred_payment_method ?? undefined,
        payment_memo: parsed.payment_memo ?? undefined,
        payment_channel: parsed.payment_channel ?? undefined,
        preferred_funding_source_id: parsed.preferred_funding_source_id ?? undefined,
        payment_schedule: parsed.payment_schedule ?? undefined,
        scheduled_payment_date: parsed.payment_schedule === "scheduled" ? (parsed.scheduled_payment_date ?? undefined) : undefined,
        preferred_approver_ids: parsed.preferred_approver_ids?.length ? parsed.preferred_approver_ids : undefined,
        coding_source: parsed.coding_source ?? (codingSuggestion?.autoApply ? "rule" : undefined),
        coding_rule_id: codingSuggestion?.ruleId,
        coding_confidence: parsed.coding_confidence ?? codingSuggestion?.confidence,
      },
      accounting_coding:
        explicitAccountingCoding ??
        (codingSuggestion?.autoApply
          ? codingSuggestion.accountingCoding
          : buildAccountingCoding({ counterpartyId: parsed.qbo_vendor_id, counterpartyName: parsed.qbo_vendor_name || parsed.vendor_name })),
      retainage_percent: parsed.retainage_percent ?? null,
      retainage_cents: parsed.retainage_percent ? Math.round((parsed.total_cents * parsed.retainage_percent) / 100) : 0,
      early_pay_discount_percent: parsed.early_pay_discount_percent ?? null,
      early_pay_discount_days: parsed.early_pay_discount_days ?? null,
      lien_waiver_status: parsed.lien_waiver_status ?? "not_required",
      qbo_vendor_id: parsed.qbo_vendor_id || null,
      qbo_vendor_name: parsed.qbo_vendor_name || parsed.vendor_name || null,
    })
    .select(vendorBillSelect)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create vendor bill: ${error?.message}`)
  }

  if (explicitLines.length > 0) {
    await replaceBillLineCoding(supabase, {
      orgId: resolvedOrgId,
      billId: data.id as string,
      lines: explicitLines.map((line) => ({
        cost_code_id: line.cost_code_id ?? null,
        budget_line_id: line.budget_line_id ?? null,
        description: line.description?.trim() || parsed.description?.trim() || `Bill ${parsed.bill_number.trim()}`,
        amount_cents: line.amount_cents,
        project_id: projectId,
        billable_to_customer: line.billable_to_customer,
        qbo_expense_account_id: line.qbo_expense_account_id,
        qbo_expense_account_name: line.qbo_expense_account_name,
        qbo_ap_account_id: line.qbo_ap_account_id,
        qbo_ap_account_name: line.qbo_ap_account_name,
      })),
    })
    if (parsed.creation_state === "ready") {
      // Split bills teach their split; single-code bills teach their code.
      const lesson = buildCodingLesson(explicitLines)
      if (explicitLines.length === 1 || lesson.costCodeId || lesson.budgetLineId || lesson.lineSplits) {
        await learnCodingRule({
          companyId,
          vendorName,
          costCodeId: explicitLines.length === 1 ? (firstExplicitLine.cost_code_id ?? null) : lesson.costCodeId,
          budgetLineId: explicitLines.length === 1 ? (firstExplicitLine.budget_line_id ?? null) : lesson.budgetLineId,
          lineSplits: lesson.lineSplits,
          accountingCoding: explicitAccountingCoding ?? undefined,
          projectId,
          orgId: resolvedOrgId,
        })
      }
    }
  } else if (codingSuggestion?.autoApply && (codingSuggestion.costCodeId || codingSuggestion.lineSplits)) {
    const description = parsed.description?.trim() || `Bill ${parsed.bill_number.trim()}`
    // A remembered split reapplies by weight, not by last month's dollars, so
    // the legs always add back to this bill's exact total.
    const lines = codingSuggestion.lineSplits
      ? splitAmountByWeights(parsed.total_cents, codingSuggestion.lineSplits).map((split) => ({
          cost_code_id: split.costCodeId,
          budget_line_id: split.budgetLineId,
          description: split.description ?? description,
          amount_cents: split.amountCents,
          project_id: projectId,
        }))
      : [
          {
            cost_code_id: codingSuggestion.costCodeId,
            budget_line_id: codingSuggestion.budgetLineId,
            description,
            amount_cents: parsed.total_cents,
            project_id: projectId,
          },
        ]
    await replaceBillLineCoding(supabase, { orgId: resolvedOrgId, billId: data.id as string, lines })
  }

  if (parsed.file_id) {
    try {
      await attachFileWithServiceRole({
        orgId: resolvedOrgId,
        fileId: parsed.file_id,
        projectId,
        entityType: "vendor_bill",
        entityId: data.id as string,
        linkRole: "invoice",
        createdBy: userId,
      })
    } catch (error) {
      console.warn("Failed to attach file", error)
    }
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "vendor_bill",
    entityId: data.id as string,
    before: null,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "vendor_bill_submitted",
    entityType: "vendor_bill",
    entityId: data.id as string,
    payload: {
      project_id: projectId,
      commitment_id: parsed.commitment_id ?? null,
      total_cents: parsed.total_cents,
      bill_number: parsed.bill_number,
      approver_ids: parsed.preferred_approver_ids ?? [],
      internal_upload: true,
      creation_state: parsed.creation_state,
      over_budget: isOverBudget,
      coding_rule_id: codingSuggestion?.ruleId,
      coding_auto_applied: codingSuggestion?.autoApply ?? false,
      coding_source: parsed.coding_source ?? (codingSuggestion?.autoApply ? "rule" : null),
    },
  })

  if (parsed.creation_state === "ready") {
    await evaluateAndAutoApproveVendorBill({ orgId: resolvedOrgId, billId: data.id as string }).catch((error) =>
      console.warn("Invoice auto-approval evaluation failed", error),
    )
  }

  return mapVendorBill(data)
}

export interface ProjectVendorCreditInput {
  projectId: string
  companyId: string
  commitmentId?: string | null
  billNumber: string
  billDate: string
  description: string
  lines: Array<{ description: string; amount_cents: number; cost_code_id?: string | null }>
  metadata?: Record<string, unknown>
}

/**
 * Creates a vendor credit on the same payable and bill-line rails as ordinary
 * vendor bills. Credits are positive business amounts at the call site and
 * negative accounting amounts here; no warranty-specific AP tables are used.
 */
export async function createProjectVendorCredit(input: ProjectVendorCreditInput, orgId?: string): Promise<VendorBillSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId: resolvedOrgId,
    projectId: input.projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: input.projectId,
  })
  // A credit extinguishes a real vendor obligation just like cash. Until there
  // is a separate routed credit-approval UI, creating an immediately usable
  // credit is an approval decision and requires the corresponding permission.
  await requireAuthorization({
    permission: "bill.approve",
    userId,
    orgId: resolvedOrgId,
    projectId: input.projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: input.projectId,
  })
  if (!input.lines.length || input.lines.some((line) => !Number.isInteger(line.amount_cents) || line.amount_cents >= 0)) {
    throw new Error("Vendor credit lines must be negative")
  }
  const totalCents = input.lines.reduce((sum, line) => sum + line.amount_cents, 0)
  const [{ data: company }, { data: commitment }, duplicate] = await Promise.all([
    supabase.from("companies").select("id").eq("org_id", resolvedOrgId).eq("id", input.companyId).maybeSingle(),
    input.commitmentId
      ? supabase.from("commitments").select("id,project_id,company_id").eq("org_id", resolvedOrgId).eq("id", input.commitmentId).maybeSingle()
      : Promise.resolve({ data: null }),
    findDuplicatePayable({ supabase, orgId: resolvedOrgId, billNumber: input.billNumber, companyId: input.companyId, totalCents }),
  ])
  if (!company) throw new Error("Arc vendor not found")
  if (input.commitmentId && (!commitment || commitment.project_id !== input.projectId)) throw new Error("Commitment not found")
  if (duplicate) throw new Error(duplicate.reason)
  const { data, error } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: resolvedOrgId,
      project_id: input.projectId,
      commitment_id: input.commitmentId ?? null,
      company_id: input.companyId,
      bill_number: input.billNumber,
      total_cents: totalCents,
      currency: "usd",
      status: "approved",
      bill_date: input.billDate,
      metadata: { source: "vendor_credit", description: input.description, ...input.metadata },
      approved_at: new Date().toISOString(),
      approved_by: userId,
    })
    .select(vendorBillSelect)
    .single()
  if (error || !data) throw new Error(`Failed to create vendor credit: ${error?.message}`)
  const { error: lineError } = await supabase
    .from("bill_lines")
    .insert(
      input.lines.map((line, index) => ({
        org_id: resolvedOrgId,
        bill_id: data.id,
        project_id: input.projectId,
        cost_code_id: line.cost_code_id ?? null,
        description: line.description,
        quantity: 1,
        unit: "LS",
        unit_cost_cents: line.amount_cents,
        sort_order: index,
        metadata: { source: "vendor_credit", ...input.metadata },
      })),
    )
  if (lineError) {
    await supabase.from("vendor_bills").delete().eq("org_id", resolvedOrgId).eq("id", data.id)
    throw new Error(`Failed to create vendor credit lines: ${lineError.message}`)
  }
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "vendor_bill", entityId: data.id, after: data })
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "vendor_credit_created",
    entityType: "vendor_bill",
    entityId: data.id,
    payload: { project_id: input.projectId, commitment_id: input.commitmentId ?? null, total_cents: totalCents },
  })
  await enqueueVendorBillSync(data.id, resolvedOrgId)
  return mapVendorBill(data)
}

/** Apply an Arc vendor credit to a regular bill and mirror recovery to warranty. */
export async function applyVendorCreditToBill({
  creditBillId,
  billId,
  amountCents,
  idempotencyKey,
  orgId,
}: {
  creditBillId: string
  billId: string
  amountCents: number
  idempotencyKey: string
  orgId?: string
}): Promise<{ paymentId: string; appliedCents: number }> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("Credit amount must be positive")
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const service = createServiceSupabaseClient()
  const [{ data: credit }, { data: bill }] = await Promise.all([
    supabase.from("vendor_bills").select("id,project_id,company_id,total_cents,status,approved_by,metadata").eq("org_id", resolvedOrgId).eq("id", creditBillId).maybeSingle(),
    supabase
      .from("vendor_bills")
      .select("id,project_id,company_id,total_cents,paid_cents,status,currency,retainage_cents,approved_by,metadata")
      .eq("org_id", resolvedOrgId)
      .eq("id", billId)
      .maybeSingle(),
  ])
  if (!credit || (credit.metadata as Record<string, unknown> | null)?.source !== "vendor_credit") throw new Error("Vendor credit not found")
  if (credit.status !== "approved" || !credit.approved_by) throw new Error("Vendor credit must be approved before it can be applied")
  if (!bill || (bill.metadata as Record<string, unknown> | null)?.source === "vendor_credit") throw new Error("Target bill not found")
  if (credit.company_id !== bill.company_id) throw new Error("A vendor credit can only be applied to the same vendor")
  await requireAuthorization({
    permission: "payment.release",
    userId,
    orgId: resolvedOrgId,
    projectId: bill.project_id,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: billId,
  })
  const creditIdempotencyKey = `vendor-credit:${creditBillId}:${idempotencyKey}`
  const { data: replay } = await service
    .from("payments")
    .select("id,bill_id,amount_cents")
    .eq("org_id", resolvedOrgId)
    .eq("idempotency_key", creditIdempotencyKey)
    .maybeSingle()
  if (replay) {
    if (replay.bill_id !== billId || Number(replay.amount_cents) !== amountCents) {
      throw new Error("Credit idempotency key was already used for different contents")
    }
    return { paymentId: replay.id, appliedCents: Number(replay.amount_cents) }
  }
  const releaseEvidence = await assertBillReleasable(billId, resolvedOrgId)
  await assertExternalPaymentControls({
    supabase,
    orgId: resolvedOrgId,
    userId,
    bill,
    amountCents,
    checkNumber: null,
    separationActorIds: [credit.approved_by],
  })
  const frozenEvidence = {
    holds: releaseEvidence.holdEvaluation,
    waiver: releaseEvidence.waiverEvidence,
    construction: releaseEvidence.constructionEvidence,
    subtier_waivers_required: releaseEvidence.subtierWaiversRequired,
    captured_at: releaseEvidence.capturedAt,
    recorded_by: userId,
  }
  const { data: result, error } = await service.rpc("apply_vendor_credit_atomic", {
    p_org_id: resolvedOrgId,
    p_credit_bill_id: creditBillId,
    p_bill_id: billId,
    p_actor_id: userId,
    p_amount_cents: amountCents,
    p_idempotency_key: creditIdempotencyKey,
    p_release_evidence: frozenEvidence,
  })
  if (error || !result || typeof result !== "object") throw new Error(`Failed to apply vendor credit: ${error?.message ?? "No result was returned"}`)
  const paymentId = String(Reflect.get(result, "payment_id"))
  const appliedCents = Number(Reflect.get(result, "applied_cents"))
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "vendor_credit_applied",
    entityType: "vendor_bill",
    entityId: creditBillId,
    payload: { project_id: bill.project_id, bill_id: billId, amount_cents: amountCents },
  })
  await enqueueBillPaymentSync(paymentId, resolvedOrgId)
  await sendManualPaymentRemittanceAdvice({ orgId: resolvedOrgId, paymentId }).catch((notificationError) =>
    console.warn("Vendor credit remittance advice was not sent", notificationError),
  )
  return { paymentId, appliedCents }
}

export async function getVendorCreditApplicationWorkspace(creditBillId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: credit } = await supabase
    .from("vendor_bills")
    .select("id,project_id,company_id,total_cents,currency,status,approved_by,metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", creditBillId)
    .maybeSingle()
  if (!credit || (credit.metadata as Record<string, unknown> | null)?.source !== "vendor_credit") throw new Error("Vendor credit not found")
  await requireAuthorization({ permission: "bill.read", userId, orgId: resolvedOrgId, projectId: credit.project_id, supabase, resourceType: "vendor_bill", resourceId: creditBillId, logDecision: false })
  const service = createServiceSupabaseClient()
  const [applications, bills] = await Promise.all([
    service.from("payments").select("id,bill_id,amount_cents,received_at,status").eq("org_id", resolvedOrgId).eq("metadata->>vendor_credit_id", creditBillId).eq("metadata->>vendor_credit_applied", "true").not("status", "in", "(canceled,refunded)"),
    service.from("vendor_bills").select("id,bill_number,description,total_cents,paid_cents,retainage_cents,status,due_date,project:projects(name)").eq("org_id", resolvedOrgId).eq("company_id", credit.company_id).in("status", ["approved", "partial"]).or("metadata->>source.is.null,metadata->>source.neq.vendor_credit").order("due_date", { ascending: true, nullsFirst: false }).limit(250),
  ])
  if (applications.error) throw new Error(`Failed to load credit applications: ${applications.error.message}`)
  if (bills.error) throw new Error(`Failed to load bills for credit: ${bills.error.message}`)
  const appliedCents = (applications.data ?? []).reduce((sum, payment) => sum + Number(payment.amount_cents), 0)
  return {
    creditId: creditBillId,
    approved: credit.status === "approved" && Boolean(credit.approved_by),
    totalCents: Math.abs(Number(credit.total_cents ?? 0)),
    appliedCents,
    availableCents: Math.max(Math.abs(Number(credit.total_cents ?? 0)) - appliedCents, 0),
    applications: applications.data ?? [],
    bills: (bills.data ?? []).map((bill) => {
      const project = Array.isArray(bill.project) ? bill.project[0] : bill.project
      const dueCents = Math.max(Number(bill.total_cents ?? 0) - Number(bill.retainage_cents ?? 0), 0)
      return { id: bill.id, billNumber: bill.bill_number, label: bill.description || bill.bill_number || "Vendor bill", projectName: project?.name ?? "Unassigned project", dueDate: bill.due_date, balanceCents: Math.max(dueCents - Number(bill.paid_cents ?? 0), 0) }
    }).filter((bill) => bill.balanceCents > 0),
  }
}

function normalizeVendorName(value?: string | null) {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? ""
}

async function getApprovedCommitmentChangeOrderTotalCents(supabase: SupabaseClient, orgId: string, commitmentId: string) {
  const { data, error } = await supabase
    .from("commitment_change_orders")
    .select("total_cents")
    .eq("org_id", orgId)
    .eq("commitment_id", commitmentId)
    .eq("status", "approved")

  if (error) {
    throw new Error(`Failed to load commitment change orders: ${error.message}`)
  }

  return (data ?? []).reduce((sum: number, row: any) => sum + (row.total_cents ?? 0), 0)
}

/**
 * Whether billing `totalCents` against this commitment exceeds the approved
 * commitment plus its approved change orders. Warning-tier metadata only — it
 * informs review, it never blocks. Recomputed on every payable edit (not just
 * at creation) because sibling bills arriving later change the answer; a stale
 * `over_budget: false` frozen at creation is worse than no flag at all.
 * Rejected bills are not obligations and do not count against the commitment.
 */
export async function computeCommitmentOverBudget(
  supabase: SupabaseClient,
  { orgId, commitmentId, totalCents, excludeBillId }: { orgId: string; commitmentId: string; totalCents: number; excludeBillId?: string },
): Promise<boolean> {
  const [{ data: commitment }, { data: existingBills }, approvedChangeOrdersCents] = await Promise.all([
    supabase.from("commitments").select("total_cents").eq("org_id", orgId).eq("id", commitmentId).maybeSingle(),
    supabase.from("vendor_bills").select("id, total_cents, status").eq("org_id", orgId).eq("commitment_id", commitmentId),
    getApprovedCommitmentChangeOrderTotalCents(supabase, orgId, commitmentId),
  ])
  const billedCents = (existingBills ?? [])
    .filter((row: any) => row.id !== excludeBillId && String(row.status) !== "rejected")
    .reduce((sum: number, row: any) => sum + Number(row.total_cents ?? 0), 0)
  return billedCents + totalCents > Number(commitment?.total_cents ?? 0) + approvedChangeOrdersCents
}

/**
 * Create a vendor bill from the sub portal.
 * This function bypasses normal org context since it's called from a portal token.
 */
export async function createVendorBillFromPortal({
  input,
  orgId,
  projectId,
  companyId,
  portalTokenId,
}: {
  input: VendorBillCreate
  orgId: string
  projectId: string
  companyId: string
  portalTokenId: string
}): Promise<VendorBillSummary> {
  const parsed = vendorBillCreateSchema.parse(input)
  const supabase = createServiceSupabaseClient()
  const commitmentId = parsed.commitment_id
  if (!commitmentId) {
    throw new Error("Commitment is required")
  }

  // Verify the commitment belongs to this org, project, and company
  const { data: commitment, error: commitmentError } = await supabase
    .from("commitments")
    .select("id, org_id, project_id, company_id, title, status, total_cents")
    .eq("id", commitmentId)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("company_id", companyId)
    .maybeSingle()

  if (commitmentError || !commitment) {
    throw new Error("Commitment not found or does not belong to your company")
  }

  if (commitment.status !== "approved") {
    throw new Error("Can only submit invoices against approved contracts")
  }

  // Warn if over budget (but still allow submission)
  const isOverBudget = await computeCommitmentOverBudget(supabase, { orgId, commitmentId, totalCents: parsed.total_cents })

  // The same duplicate check every other intake path runs. This one was
  // missing it, which made the portal — where a subcontractor resubmitting an
  // invoice they think was lost is the single most likely source of a
  // duplicate — the one door with no check on it.
  const duplicate = await findDuplicatePayable({
    supabase,
    orgId,
    billNumber: parsed.bill_number,
    companyId,
    totalCents: parsed.total_cents,
    billDate: parsed.bill_date,
  })
  if (duplicate) {
    throw new Error(
      "This invoice looks like one you have already submitted. Check your submitted invoices, or contact the builder if you think this is a different one.",
    )
  }

  // Create the vendor bill
  const { data, error } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: orgId,
      project_id: projectId,
      commitment_id: commitmentId,
      // The vendor is known here with more certainty than on any other intake
      // path — they authenticated as this company to submit. Omitting it made
      // portal bills unpayable electronically, invisible to 1099 totals, and the
      // only bills the duplicate-number trigger could not check.
      company_id: companyId,
      bill_number: parsed.bill_number,
      total_cents: parsed.total_cents,
      currency: "usd",
      status: "pending",
      bill_date: parsed.bill_date,
      due_date: parsed.due_date ?? null,
      file_id: parsed.file_id ?? null,
      metadata: {
        description: parsed.description,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        submitted_via_portal: true,
        portal_token_id: portalTokenId,
        over_budget: isOverBudget,
      },
    })
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create vendor bill: ${error?.message}`)
  }

  if (parsed.file_id) {
    try {
      await attachFileWithServiceRole({
        orgId,
        fileId: parsed.file_id,
        projectId,
        entityType: "vendor_bill",
        entityId: data.id as string,
        linkRole: "invoice",
        createdBy: null,
      })
    } catch (error) {
      console.warn("Failed to attach vendor bill file to file_links", error)
    }
  }

  // Record event for activity feed
  await recordEvent({
    orgId,
    eventType: "vendor_bill_submitted",
    entityType: "vendor_bill",
    entityId: data.id as string,
    payload: {
      company_id: companyId,
      project_id: projectId,
      commitment_id: parsed.commitment_id,
      total_cents: parsed.total_cents,
      bill_number: parsed.bill_number,
      submitted_via_portal: true,
      over_budget: isOverBudget,
    },
  })

  await evaluateAndAutoApproveVendorBill({ orgId, billId: data.id as string }).catch((error) => console.warn("Invoice auto-approval evaluation failed", error))

  return mapVendorBill(data)
}

export async function deleteVendorBill({ billId, orgId }: { billId: string; orgId?: string }): Promise<{ projectId: string | null }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // 1. Fetch the existing bill
  const { data: existing, error: existingError } = await supabase
    .from("vendor_bills")
    .select("id, org_id, project_id, bill_number, status, paid_cents, qbo_id, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Vendor bill not found")
  }

  const existingMetadata = (existing.metadata as Record<string, any> | null) ?? {}

  // 2. Authorization check (bill.write)
  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id ?? undefined,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: billId,
  })

  // 3. Restriction checks
  if (existing.qbo_id) {
    // Bills imported FROM QuickBooks are owned by QBO — deleting the Arc copy
    // would not touch QBO, and the usual reason to delete one is a wrong project.
    // Point the user at Reassign instead of the (here misleading) "disconnect in QBO" path.
    if (existingMetadata.imported_from_qbo === true) {
      throw new Error('This bill was imported from QuickBooks. To move it to the correct project, use "Reassign" instead of deleting it here.')
    }
    throw new Error("Bills synced to QuickBooks cannot be deleted. Disconnect or delete them in QuickBooks first.")
  }

  // A payable that money has touched is evidence, not a draft. Deleting one that
  // an active run is about to pay would strand that run's frozen item against a
  // bill that no longer exists, and deleting one already paid would erase the
  // record the payment answers to.
  if (existing.status === "paid" || existing.status === "partial" || Number(existing.paid_cents ?? 0) > 0) {
    throw new Error("This payable has recorded payments and cannot be deleted.")
  }
  const { data: activeRunItems, error: activeRunError } = await supabase
    .from("payment_run_items")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("bill_id", billId)
    .in("status", ["draft", "pending_approval", "approved", "processing", "partially_paid"])
    .limit(1)
  if (activeRunError) throw new Error(`Unable to validate in-flight payments: ${activeRunError.message}`)
  if ((activeRunItems ?? []).length > 0) {
    throw new Error("This payable belongs to an active payment run. Cancel that run before deleting it.")
  }

  // Fetch related billable costs
  const { data: costs, error: costsError } = await supabase
    .from("billable_costs")
    .select("status")
    .eq("org_id", resolvedOrgId)
    .eq("source_type", "vendor_bill_line")
    .eq("metadata->>bill_id", billId)

  if (costsError) {
    throw new Error(`Failed to load billable costs: ${costsError.message}`)
  }

  const hasBilledOrLockedCosts = (costs ?? []).some((cost) => cost.status === "billed" || cost.status === "locked")
  if (hasBilledOrLockedCosts) {
    throw new Error("This bill cannot be deleted because its costs have already been billed or locked.")
  }

  // 4. Cleanup related polymorphic records
  // Fetch line IDs
  const { data: lines, error: linesError } = await supabase.from("bill_lines").select("id").eq("org_id", resolvedOrgId).eq("bill_id", billId)

  if (linesError) {
    throw new Error(`Failed to load bill lines: ${linesError.message}`)
  }

  const lineIds = (lines ?? []).map((line) => line.id).filter(Boolean)

  if (lineIds.length > 0) {
    // Delete open/voided billable costs
    const { error: deleteCostsError } = await supabase
      .from("billable_costs")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq("source_type", "vendor_bill_line")
      .in("source_id", lineIds)

    if (deleteCostsError) {
      throw new Error(`Failed to delete billable costs: ${deleteCostsError.message}`)
    }
  }

  // The subledger is not a cache to be swept: `job_cost_entries` is voided, never
  // deleted, and only `lib/services/job-cost-actuals.ts` knows that. Deleting the
  // rows here erased the trace that cost was ever posted against this project.
  await voidJobCostEntriesForVendorBill({ billId, orgId: resolvedOrgId, supabase })

  // Delete file links
  await supabase.from("file_links").delete().eq("org_id", resolvedOrgId).eq("entity_type", "vendor_bill").eq("entity_id", billId)

  // 5. Delete the vendor bill (bill_lines will be deleted automatically due to cascade constraint)
  const { error: deleteBillError } = await supabase.from("vendor_bills").delete().eq("org_id", resolvedOrgId).eq("id", billId)

  if (deleteBillError) {
    throw new Error(`Failed to delete vendor bill: ${deleteBillError.message}`)
  }

  // 6. Record activity event & audit log
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "vendor_bill_deleted",
    entityType: "vendor_bill",
    entityId: billId,
    payload: { bill_number: existing.bill_number, project_id: existing.project_id },
  })

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "delete", entityType: "vendor_bill", entityId: billId, before: existing })

  return { projectId: existing.project_id }
}

/**
 * Move a QuickBooks-imported payable (regular bill or vendor credit) to a
 * different project. Re-posts the job-cost ledger so reports stay correct.
 *
 * Vendor credits that have already been *applied* to a bill (which records a
 * payment-settlement link) are blocked, because moving them would break that
 * application. A regular bill's own payment simply moves with the bill.
 */
export async function reassignImportedPayable({
  billId,
  targetProjectId,
  orgId,
}: {
  billId: string
  targetProjectId: string
  orgId?: string
}): Promise<{ previousProjectId: string; projectId: string }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: existingError } = await supabase
    .from("vendor_bills")
    .select("id, org_id, project_id, bill_number, total_cents, status, metadata, qbo_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()

  if (existingError || !existing) throw new Error("Payable not found")
  const metadata = (existing.metadata as Record<string, any> | null) ?? {}
  const isVendorCredit = metadata.source === "vendor_credit"
  const payableLabel = isVendorCredit ? "vendor credit" : "bill"
  if (metadata.imported_from_qbo !== true || !existing.qbo_id) {
    throw new Error("Only payables imported from QuickBooks can be reassigned")
  }
  if (!existing.project_id) throw new Error(`This ${payableLabel} is missing its current project`)
  if (existing.project_id === targetProjectId) {
    return { previousProjectId: existing.project_id, projectId: targetProjectId }
  }

  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: billId,
  })
  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId: resolvedOrgId,
    projectId: targetProjectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: targetProjectId,
  })

  const { data: targetProject, error: targetProjectError } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", targetProjectId)
    .maybeSingle()
  if (targetProjectError || !targetProject) throw new Error("Target project not found")

  const { count: paymentCount, error: paymentsError } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("bill_id", billId)
  if (paymentsError) throw new Error(`Failed to check payable dependencies: ${paymentsError.message}`)
  if (isVendorCredit && (paymentCount ?? 0) > 0) {
    throw new Error("This vendor credit cannot be reassigned because it is already applied to a bill")
  }

  const previousProjectId = existing.project_id
  await voidJobCostEntriesForVendorBill({ billId, orgId: resolvedOrgId })

  const { error: lineUpdateError } = await supabase.from("bill_lines").update({ project_id: targetProjectId }).eq("org_id", resolvedOrgId).eq("bill_id", billId)
  if (lineUpdateError) {
    await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId })
    throw new Error(`Failed to reassign ${payableLabel} lines: ${lineUpdateError.message}`)
  }

  const { error: billUpdateError } = await supabase
    .from("vendor_bills")
    .update({
      project_id: targetProjectId,
      commitment_id: null,
      metadata: { ...metadata, reassigned_from_project_id: previousProjectId, reassigned_at: new Date().toISOString(), reassigned_by: userId },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)

  if (billUpdateError) {
    await supabase.from("bill_lines").update({ project_id: previousProjectId }).eq("org_id", resolvedOrgId).eq("bill_id", billId)
    await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId })
    throw new Error(`Failed to reassign ${payableLabel}: ${billUpdateError.message}`)
  }

  // Imported bills now land `pending` until approved in Arc; a pending payable
  // has no ledger presence, so reassigning it must not post job costs early.
  const hasLedgerPresence = ["approved", "partial", "paid"].includes(String(existing.status))
  if (hasLedgerPresence) {
    try {
      await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId })
    } catch (error) {
      await supabase.from("vendor_bills").update({ project_id: previousProjectId, metadata }).eq("org_id", resolvedOrgId).eq("id", billId)
      await supabase.from("bill_lines").update({ project_id: previousProjectId }).eq("org_id", resolvedOrgId).eq("bill_id", billId)
      await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId }).catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`This ${payableLabel} was not reassigned because job costs could not be updated: ${message}`)
    }
  }

  // A regular bill's payment(s) belong to the bill and should follow it to the
  // new project. (Applied vendor credits are blocked above, so this only runs
  // for ordinary bills.)
  if (!isVendorCredit && (paymentCount ?? 0) > 0) {
    const { error: paymentMoveError } = await supabase
      .from("payments")
      .update({ project_id: targetProjectId })
      .eq("org_id", resolvedOrgId)
      .eq("bill_id", billId)
    if (paymentMoveError) {
      console.warn("Payable reassigned but its payment project could not be moved", paymentMoveError)
    }
  }

  const { error: fileLinksError } = await supabase
    .from("file_links")
    .update({ project_id: targetProjectId })
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", "vendor_bill")
    .eq("entity_id", billId)
  if (fileLinksError) {
    console.warn("Payable reassigned but its file links could not be moved", fileLinksError)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "vendor_bill",
    entityId: billId,
    before: existing,
    after: { ...existing, project_id: targetProjectId },
  })
  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: isVendorCredit ? "vendor_credit_reassigned" : "vendor_bill_reassigned",
    entityType: "vendor_bill",
    entityId: billId,
    payload: { qbo_id: existing.qbo_id, previous_project_id: previousProjectId, project_id: targetProjectId, total_cents: existing.total_cents },
  })

  return { previousProjectId, projectId: targetProjectId }
}
