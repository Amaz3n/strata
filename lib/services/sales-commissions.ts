import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { readClosedSettlementEvidence } from "@/lib/financials/closing-settlement-evidence"
import {
  commissionApprovalRefusal,
  commissionPlanRefusal,
  commissionUnwindPlan,
  deriveCommissionObligations,
  estimateCommissions,
  type CommissionKind,
  type CommissionPayoutChannel,
  type CommissionPlanLine,
  type CommissionPlanStatus,
} from "@/lib/financials/sales-commissions"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import { booksDigest } from "@/lib/services/books/hash"
import { postBooksJournalEntryForService, reverseBooksJournalEntryForService } from "@/lib/services/books/ledger"
import { buildPostingKey, type JournalEntryDraft } from "@/lib/services/books/types"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { ensureVendorRoleWithClient } from "@/lib/services/party-roles"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  approveCommissionPlanSchema,
  commissionPayeeSearchSchema,
  markPayrollCommissionPaidSchema,
  proposeCommissionPlanSchema,
} from "@/lib/validation/sales-commissions"

// Commission plans and obligations are deliberately NOT registered in
// lib/services/search-index.ts: comp is private, and global search would show
// a consultant's terms to anyone who can search.

const PLAN_SELECT = "id, org_id, project_id, contract_id, revision, status, coop_broker, line_count, proposed_by, proposed_at, approved_by, approved_at, approval_note, ended_at, end_reason"
const LINE_SELECT = "id, plan_id, line_no, kind, payout_channel, payee_company_id, payee_user_id, agent_name, basis, rate_bps, flat_cents, payee_company:companies(name), payee_user:app_users(full_name, email)"
const OBLIGATION_SELECT = "id, closing_id, plan_line_id, line_no, kind, payout_channel, payee_company_id, payee_user_id, basis_price_cents, rate_bps, flat_cents, amount_cents, status, vendor_bill_id, reversal_credit_bill_id, adjusts_obligation_id, payroll_reference, paid_on, end_reason, created_at"

/** Payment-run states in which a bill will still be paid (mirrors apply_vendor_credit_atomic). */
const ACTIVE_RUN_ITEM_STATUSES = ["draft", "pending_approval", "approved", "processing", "partially_paid"]

/** Rows the payroll export returns at once; the cap is reported, never silent. */
const PAYROLL_EXPORT_CAP = 200

type Context = { supabase: SupabaseClient; orgId: string; userId: string }

export type CommissionPlanLineView = CommissionPlanLine & {
  payeeCompanyId: string | null
  payeeUserId: string | null
  payeeName: string
  agentName: string | null
  estimateCents: number
}

export type CommissionPlanView = {
  id: string
  revision: number
  status: CommissionPlanStatus
  coopBroker: "none" | "broker"
  lineCount: number
  /** Lines this viewer may not read (another consultant's comp). */
  hiddenLineCount: number
  proposedBy: string
  proposedByName: string | null
  proposedAt: string
  approvedByName: string | null
  approvedAt: string | null
  approvalNote: string | null
  lines: CommissionPlanLineView[]
}

export type AgreementCommissionView = {
  contractId: string
  projectId: string
  contractStatus: string
  /** Agreement plus buyer-signed change orders: the basis an estimate is computed on. */
  authorizedPriceCents: number
  plan: CommissionPlanView | null
  estimateTotalCents: number
  canManage: boolean
  canApprove: boolean
  /** Why this viewer cannot approve the waiting plan; null when they can or nothing waits. */
  approvalRefusal: string | null
  signingRefusal: string | null
}

export type CommissionPayableState = "pending_ap" | "approved" | "paid" | "partial" | "rejected" | "accrued" | "paid_payroll" | "cleared" | "reversed"

export type CommissionObligationView = {
  id: string
  lineNo: number
  kind: CommissionKind
  payoutChannel: CommissionPayoutChannel
  payeeName: string
  basisPriceCents: number
  rateBps: number | null
  flatCents: number | null
  amountCents: number
  status: "open" | "cleared" | "reversed"
  state: CommissionPayableState
  billId: string | null
  billNumber: string | null
  paidCents: number
  creditBillId: string | null
  /** What the payee still owes back after a reversal (open vendor credit, or payroll deduction not yet taken). */
  clawbackOpenCents: number
  payrollReference: string | null
  endReason: string | null
  adjustment: boolean
}

export type ClosingCommissionsView = AgreementCommissionView & {
  closingId: string
  closingStatus: string
  obligations: CommissionObligationView[]
  /** Commissions owed by the closing that this viewer cannot see. */
  hiddenObligationCount: number
  closingRefusal: string | null
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

function isBooksPosting(settings: { workspace_enabled?: boolean | null; arc_ledger_mode?: string | null } | null) {
  return Boolean(settings?.workspace_enabled && settings.arc_ledger_mode !== "disabled")
}

const lineRowSchema = z.object({
  id: z.string(),
  plan_id: z.string(),
  line_no: z.number().int(),
  kind: z.enum(["coop_broker", "sales_consultant"]),
  payout_channel: z.enum(["accounts_payable", "payroll"]),
  payee_company_id: z.string().nullable(),
  payee_user_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  basis: z.enum(["percent_of_authorized_price", "flat"]),
  rate_bps: z.number().int().nullable(),
  flat_cents: z.coerce.number().int().nullable(),
  payee_company: z.union([z.object({ name: z.string().nullable() }), z.array(z.object({ name: z.string().nullable() }))]).nullable().optional(),
  payee_user: z.union([
    z.object({ full_name: z.string().nullable(), email: z.string().nullable() }),
    z.array(z.object({ full_name: z.string().nullable(), email: z.string().nullable() })),
  ]).nullable().optional(),
})

const planRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  contract_id: z.string(),
  revision: z.number().int(),
  status: z.enum(["proposed", "approved", "superseded", "void"]),
  coop_broker: z.enum(["none", "broker"]),
  line_count: z.number().int(),
  proposed_by: z.string(),
  proposed_at: z.string(),
  approved_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  approval_note: z.string().nullable(),
})

type LineRow = z.infer<typeof lineRowSchema>
type PlanRow = z.infer<typeof planRowSchema>

function payeeName(row: LineRow) {
  const company = relationOne(row.payee_company)?.name
  const user = relationOne(row.payee_user)
  if (row.kind === "coop_broker") return company ?? "Brokerage"
  const person = user?.full_name || user?.email || "Sales consultant"
  return company ? `${person} · ${company}` : person
}

function toPlanLine(row: LineRow): CommissionPlanLine {
  return { id: row.id, lineNo: row.line_no, kind: row.kind, payoutChannel: row.payout_channel, basis: row.basis, rateBps: row.rate_bps, flatCents: row.flat_cents }
}

async function userNames(service: SupabaseClient, ids: string[]) {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (!unique.length) return new Map<string, string>()
  const { data, error } = await service.from("app_users").select("id, full_name, email").in("id", unique)
  if (error) throw new Error(`Unable to read people: ${error.message}`)
  return new Map((data ?? []).map((row) => [String(row.id), String(row.full_name || row.email || "Member")]))
}

/**
 * Agreement plus buyer-signed change orders, before settlement freezes it: the
 * newest signed version, or a draft's own price before anything is signed.
 */
async function readAuthorizedPriceCents(context: Context, contract: { id: string; total_cents: number | null }) {
  const { data, error } = await context.supabase.from("purchase_agreement_authorized_terms").select("authorized_total_cents")
    .eq("org_id", context.orgId).eq("contract_id", contract.id).maybeSingle()
  if (error) throw new Error(`Unable to read the agreement's authorized price: ${error.message}`)
  return Number(data?.authorized_total_cents ?? contract.total_cents ?? 0)
}

async function readLivePlan(supabase: SupabaseClient, orgId: string, contractId: string): Promise<PlanRow | null> {
  const { data, error } = await supabase.from("sales_commission_plans").select(PLAN_SELECT)
    .eq("org_id", orgId).eq("contract_id", contractId).in("status", ["proposed", "approved"]).maybeSingle()
  if (error) throw new Error(`Unable to read the agreement's commission terms: ${error.message}`)
  return data ? planRowSchema.parse(data) : null
}

async function readVisibleLines(supabase: SupabaseClient, orgId: string, planId: string) {
  const { data, error } = await supabase.from("sales_commission_plan_lines").select(LINE_SELECT)
    .eq("org_id", orgId).eq("plan_id", planId).order("line_no")
  if (error) throw new Error(`Unable to read commission lines: ${error.message}`)
  return z.array(lineRowSchema).parse(data ?? [])
}

async function buildAgreementView(context: Context, contractId: string): Promise<AgreementCommissionView> {
  const { data: contract, error } = await context.supabase.from("contracts").select("id, project_id, status, total_cents")
    .eq("org_id", context.orgId).eq("id", contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (error || !contract) throw new Error("Purchase agreement not found")
  await requireAuthorization({ permission: "sales.read", userId: context.userId, orgId: context.orgId, projectId: contract.project_id,
    supabase: context.supabase, resourceType: "contract", resourceId: contract.id })
  const permissionContext = { orgId: context.orgId, userId: context.userId, supabase: context.supabase }
  const [authorizedPriceCents, plan, canManage, canApprove] = await Promise.all([
    readAuthorizedPriceCents(context, contract),
    readLivePlan(context.supabase, context.orgId, contract.id),
    hasPermission("sales.commission_manage", permissionContext),
    hasPermission("sales.commission_approve", permissionContext),
  ])
  const lines = plan ? await readVisibleLines(context.supabase, context.orgId, plan.id) : []
  const names = await userNames(createServiceSupabaseClient(), plan ? [plan.proposed_by, plan.approved_by ?? ""] : [])
  const estimates = estimateCommissions(lines.map((row) => toPlanLine(row)), authorizedPriceCents)
  const estimateByLine = new Map(estimates.lines.map((line) => [line.lineNo, line.amountCents]))
  const planView: CommissionPlanView | null = plan ? {
    id: plan.id,
    revision: plan.revision,
    status: plan.status,
    coopBroker: plan.coop_broker,
    lineCount: plan.line_count,
    hiddenLineCount: plan.line_count - lines.length,
    proposedBy: plan.proposed_by,
    proposedByName: names.get(plan.proposed_by) ?? null,
    proposedAt: plan.proposed_at,
    approvedByName: plan.approved_by ? names.get(plan.approved_by) ?? null : null,
    approvedAt: plan.approved_at,
    approvalNote: plan.approval_note,
    lines: lines.map((row) => ({ ...toPlanLine(row), payeeCompanyId: row.payee_company_id, payeeUserId: row.payee_user_id,
      payeeName: payeeName(row), agentName: row.agent_name, estimateCents: estimateByLine.get(row.line_no) ?? 0 })),
  } : null
  const approvalRefusal = plan?.status === "proposed"
    ? commissionApprovalRefusal({ actorUserId: context.userId, proposedBy: plan.proposed_by, lineCount: plan.line_count,
      payeeUserIds: lines.map((row) => row.payee_user_id), canApprove: canApprove && plan.line_count === lines.length })
    : null
  return {
    contractId: contract.id,
    projectId: contract.project_id,
    contractStatus: String(contract.status),
    authorizedPriceCents,
    plan: planView,
    estimateTotalCents: estimates.totalCents,
    canManage,
    canApprove,
    approvalRefusal,
    signingRefusal: commissionPlanRefusal(plan, "signing"),
  }
}

/** The agreement's commission terms, with an estimate on today's authorized price. */
export async function getAgreementCommissionPlan(contractId: string, orgId?: string): Promise<AgreementCommissionView> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  return buildAgreementView(context, z.string().uuid().parse(contractId))
}

/**
 * Propose (or revise) the agreement's commission terms. A revision supersedes the
 * live plan and needs approval again; it is refused once the home has closed.
 * With no lines this is the explicit "no commissions" declaration and stands at once.
 */
export async function proposeCommissionPlan(input: unknown, orgId?: string): Promise<AgreementCommissionView> {
  const parsed = proposeCommissionPlanSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.commission_manage", context)
  const { data: contract, error } = await context.supabase.from("contracts").select("id, project_id, status")
    .eq("org_id", context.orgId).eq("id", parsed.contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (error || !contract) throw new Error("Purchase agreement not found")
  await requireAuthorization({ permission: "sales.commission_manage", userId: context.userId, orgId: context.orgId,
    projectId: contract.project_id, supabase: context.supabase, resourceType: "contract", resourceId: contract.id, logDecision: true })
  const before = await readLivePlan(context.supabase, context.orgId, contract.id)
  if (before) {
    const visible = await readVisibleLines(context.supabase, context.orgId, before.id)
    if (visible.length !== before.line_count) throw new Error("This plan includes commission terms you cannot see; ask a sales manager to revise it")
  }
  const lines = parsed.plan.lines.map((line) => ({
    kind: line.kind,
    payout_channel: line.kind === "coop_broker" ? "accounts_payable" : line.payoutChannel,
    payee_company_id: line.payeeCompanyId,
    payee_user_id: line.kind === "sales_consultant" ? line.payeeUserId : null,
    agent_name: line.kind === "coop_broker" ? line.agentName : null,
    basis: line.basis,
    rate_bps: line.rateBps,
    flat_cents: line.flatCents,
  }))
  const { data: planId, error: proposeError } = await context.supabase.rpc("propose_sales_commission_plan", {
    p_org_id: context.orgId, p_contract_id: contract.id, p_coop_broker: parsed.plan.coopBroker, p_lines: lines, p_reason: parsed.reason ?? null,
  })
  if (proposeError || typeof planId !== "string") throw new Error(proposeError?.message ?? "The commission terms were not saved")
  const none = lines.length === 0
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: none ? "sales_commission_none_declared" : before ? "sales_commission_plan_revised" : "sales_commission_plan_proposed",
      entityType: "sales_commission_plan", entityId: planId, payload: { contract_id: contract.id, project_id: contract.project_id, line_count: lines.length, superseded_plan_id: before?.id ?? null } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "sales_commission_plan", entityId: planId,
      before: before ? { id: before.id, status: before.status, revision: before.revision } : null,
      after: { contract_id: contract.id, coop_broker: parsed.plan.coopBroker, line_count: lines.length } }),
  ])
  return buildAgreementView(context, contract.id)
}

/**
 * A second person approves the terms. Never the proposer and never a payee; the
 * database enforces the same rule. Approving does not release cash: settlement
 * creates pending payables that AP approves.
 */
export async function approveCommissionPlan(input: unknown, orgId?: string): Promise<AgreementCommissionView> {
  const parsed = approveCommissionPlanSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.commission_approve", context)
  const { data, error } = await context.supabase.from("sales_commission_plans").select(PLAN_SELECT)
    .eq("org_id", context.orgId).eq("id", parsed.planId).maybeSingle()
  if (error || !data) throw new Error("Commission terms not found")
  const plan = planRowSchema.parse(data)
  await requireAuthorization({ permission: "sales.commission_approve", userId: context.userId, orgId: context.orgId,
    projectId: plan.project_id, supabase: context.supabase, resourceType: "sales_commission_plan", resourceId: plan.id, logDecision: true })
  if (plan.status !== "proposed") throw new Error("These commission terms are no longer waiting for approval")
  const lines = await readVisibleLines(context.supabase, context.orgId, plan.id)
  const refusal = commissionApprovalRefusal({ actorUserId: context.userId, proposedBy: plan.proposed_by, lineCount: plan.line_count,
    payeeUserIds: lines.map((row) => row.payee_user_id), canApprove: lines.length === plan.line_count })
  if (refusal) throw new Error(refusal)
  const { data: approved, error: approveError } = await context.supabase.from("sales_commission_plans")
    .update({ status: "approved", approved_by: context.userId, approved_at: new Date().toISOString(), approval_note: parsed.note || null })
    .eq("org_id", context.orgId).eq("id", plan.id).eq("status", "proposed").select("id").maybeSingle()
  if (approveError) throw new Error(approveError.message)
  if (!approved) throw new Error("These commission terms changed while you were deciding. Review them and try again.")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "sales_commission_plan_approved", entityType: "sales_commission_plan", entityId: plan.id,
      payload: { contract_id: plan.contract_id, project_id: plan.project_id, proposed_by: plan.proposed_by } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "sales_commission_plan", entityId: plan.id,
      before: { status: "proposed" }, after: { status: "approved", approved_by: context.userId, approval_note: parsed.note || null } }),
  ])
  return buildAgreementView(context, plan.contract_id)
}

/**
 * The signing hold: an agreement goes out for signature only with approved
 * commission terms (or an explicit "none"). Returns the reason to hold, or null.
 * Reads through the caller's client; signing already requires sales.manage.
 */
export async function commissionSigningRefusal(supabase: SupabaseClient, orgId: string, contractId: string): Promise<string | null> {
  return commissionPlanRefusal(await readLivePlan(supabase, orgId, contractId), "signing")
}

/**
 * The closing gate: the home's active agreement needs approved commission terms
 * (or an explicit "none") before it settles. Null when there is nothing to hold;
 * a home without exactly one active agreement is refused by settlement itself.
 */
export async function closingCommissionRefusal(supabase: SupabaseClient, orgId: string, projectId: string): Promise<string | null> {
  const { data, error } = await supabase.from("contracts").select("id").eq("org_id", orgId).eq("project_id", projectId)
    .eq("contract_type", "purchase_agreement").eq("status", "active").order("id").limit(2)
  if (error) throw new Error(`Unable to verify the agreement's commission terms: ${error.message}`)
  if (data?.length !== 1) return null
  return commissionPlanRefusal(await readLivePlan(supabase, orgId, String(data[0].id)), "closing")
}

function accrualDraft(obligation: { id: string; project_id: string; amount_cents: number; line_no: number }, date: string, clawback: boolean): JournalEntryDraft {
  const amount = Math.abs(obligation.amount_cents)
  const dimensions = { sales_commission_obligation_id: obligation.id, cost_type: "Sales commission" }
  const expense = { accountCode: SYSTEM_ACCOUNT_CODES.salesCommissions, projectId: obligation.project_id, dimensions, description: clawback ? "Sales commission clawback" : "Sales commission accrued for payroll" }
  const accrued = { accountCode: SYSTEM_ACCOUNT_CODES.accruedCommissions, projectId: obligation.project_id, dimensions, description: expense.description }
  const base = clawback ? `sales_commission_clawback:${obligation.id}` : `sales_commission_accrual:${obligation.id}`
  return {
    entryDate: date,
    entryKind: "operational",
    memo: clawback ? `Sales commission clawback, line ${obligation.line_no}` : `Sales commission accrued, line ${obligation.line_no}`,
    postingKey: buildPostingKey(base, { projectionVersion: 1 }),
    projectionVersion: 1,
    policyVersion: 1,
    sourceType: clawback ? "sales_commission_clawback" : "sales_commission_accrual",
    sourceId: obligation.id,
    lines: clawback
      ? [{ ...accrued, debitCents: amount, creditCents: 0 }, { ...expense, debitCents: 0, creditCents: amount }]
      : [{ ...expense, debitCents: amount, creditCents: 0 }, { ...accrued, debitCents: 0, creditCents: amount }],
  }
}

const obligationRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  line_no: z.number().int(),
  payout_channel: z.enum(["accounts_payable", "payroll"]),
  payee_company_id: z.string().nullable(),
  amount_cents: z.coerce.number().int(),
  status: z.enum(["open", "cleared", "reversed"]),
  vendor_bill_id: z.string().nullable(),
  adjusts_obligation_id: z.string().nullable(),
})

/**
 * Settlement's commission step, run inside `recoverClosingCompletion` on the
 * first settle and on every retry. The closing's caller is already authorized to
 * settle (closing.manage + payment.release). Derives each approved line from the
 * recorded settlement, writes obligations and pending AP bills once per closing
 * and line, and accrues payroll-channel comp in Books. A closing whose agreement
 * never had terms (recorded before commission control) owes nothing here.
 */
export async function ensureSalesCommissionPayables(input: { orgId: string; userId: string; closingId: string }) {
  const service = createServiceSupabaseClient()
  const { data: closing, error } = await service.from("closings").select("id, project_id, status, actual_date, settlement")
    .eq("org_id", input.orgId).eq("id", input.closingId).maybeSingle()
  if (error || !closing) throw new Error("Closing not found")
  if (closing.status !== "closed" || !closing.actual_date) throw new Error("Commissions are recorded only for a recorded closing")
  const settlement = readClosedSettlementEvidence(closing.settlement)
  const { data: planData, error: planError } = await service.from("sales_commission_plans").select(PLAN_SELECT)
    .eq("org_id", input.orgId).eq("contract_id", settlement.contractId).in("status", ["proposed", "approved"]).maybeSingle()
  if (planError) throw new Error(`Unable to read the agreement's commission terms: ${planError.message}`)
  if (!planData) return []
  const plan = planRowSchema.parse(planData)
  if (plan.status !== "approved") throw new Error("Approve the agreement's commission terms, then retry completion")
  const [lines, existing] = await Promise.all([
    readVisibleLines(service, input.orgId, plan.id),
    service.from("sales_commission_obligations").select("id").eq("org_id", input.orgId).eq("closing_id", closing.id).is("adjusts_obligation_id", null),
  ])
  if (existing.error) throw new Error(`Unable to read recorded commissions: ${existing.error.message}`)
  const derived = deriveCommissionObligations({ closingId: closing.id, plan: { id: plan.id, revision: plan.revision }, lines: lines.map(toPlanLine), settlement })
  const rows = derived.map((row) => ({ plan_line_id: row.planLineId, basis_price_cents: row.basisPriceCents, amount_cents: row.amountCents, evidence_digest: booksDigest(row.evidence) }))
  const { data: recorded, error: recordError } = await service.rpc("record_sales_commission_payables", {
    p_org_id: input.orgId, p_closing_id: closing.id, p_actor_id: input.userId, p_rows: rows,
  })
  if (recordError) throw new Error(`Closing is recorded; retry completion after resolving commissions: ${recordError.message}`)
  const obligations = z.array(obligationRowSchema).parse(recorded ?? [])
  const payeeCompanies = Array.from(new Set(obligations.flatMap((row) => row.payee_company_id ? [row.payee_company_id] : [])))
  // Money owed makes the brokerage a vendor, so it shows on vendor ledgers and payment setup.
  for (const companyId of payeeCompanies) await ensureVendorRoleWithClient(service, input.orgId, companyId, input.userId)
  const { data: books, error: booksError } = await service.from("books_settings").select("workspace_enabled, arc_ledger_mode").eq("org_id", input.orgId).maybeSingle()
  if (booksError) throw new Error(`Unable to verify Books posture: ${booksError.message}`)
  if (isBooksPosting(books)) {
    for (const row of obligations.filter((item) => item.payout_channel === "payroll")) {
      await postBooksJournalEntryForService(accrualDraft(row, String(closing.actual_date), false), input.orgId)
    }
  }
  if ((existing.data ?? []).length === 0 && obligations.length > 0) {
    await Promise.all([
      recordEvent({ orgId: input.orgId, actorId: input.userId, eventType: "sales_commission_payables_created", entityType: "closing", entityId: closing.id,
        payload: { project_id: closing.project_id, obligation_count: obligations.length, total_cents: obligations.reduce((sum, row) => sum + row.amount_cents, 0) } }),
      ...obligations.map((row) => recordAudit({ orgId: input.orgId, actorId: input.userId, action: "insert", entityType: "sales_commission_obligation", entityId: row.id,
        after: { closing_id: closing.id, amount_cents: row.amount_cents, payout_channel: row.payout_channel, vendor_bill_id: row.vendor_bill_id } })),
    ])
  }
  return obligations
}

/**
 * The closing reversal's commission step, run before the home goes back to
 * inventory. Refuses up front when any commission bill sits in a payment run, so
 * nothing is half-unwound; otherwise clears what was never paid and claws back
 * what was (`unwind_sales_commission`), reversing payroll accruals in Books.
 * Idempotent: a settled commission is skipped on replay.
 */
export async function unwindSalesCommissionsForClosing(input: { orgId: string; userId: string; closingId: string; reason: string; date: string }) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("sales_commission_obligations").select("id, project_id, line_no, payout_channel, payee_company_id, amount_cents, status, vendor_bill_id, adjusts_obligation_id")
    .eq("org_id", input.orgId).eq("closing_id", input.closingId).is("adjusts_obligation_id", null).eq("status", "open").order("line_no")
  if (error) throw new Error(`Unable to read the closing's commissions: ${error.message}`)
  const open = z.array(obligationRowSchema).parse(data ?? [])
  if (!open.length) return []
  const billIds = open.flatMap((row) => row.vendor_bill_id ? [row.vendor_bill_id] : [])
  if (billIds.length) {
    const { data: runItems, error: runError } = await service.from("payment_run_items").select("bill_id, run_id")
      .eq("org_id", input.orgId).in("bill_id", billIds).in("status", ACTIVE_RUN_ITEM_STATUSES)
    if (runError) throw new Error(`Unable to check payment runs: ${runError.message}`)
    const { data: bills, error: billError } = await service.from("vendor_bills").select("id, bill_number, total_cents, paid_cents, retainage_cents")
      .eq("org_id", input.orgId).in("id", billIds)
    if (billError) throw new Error(`Unable to read commission payables: ${billError.message}`)
    const inRun = new Set((runItems ?? []).map((row) => String(row.bill_id)))
    for (const bill of bills ?? []) {
      const plan = commissionUnwindPlan({ totalCents: Number(bill.total_cents ?? 0), paidCents: Number(bill.paid_cents ?? 0), retainageCents: Number(bill.retainage_cents ?? 0), inActiveRun: inRun.has(String(bill.id)) })
      if (plan.action === "refuse") throw new Error(`Commission payable ${bill.bill_number}: ${plan.reason}`)
    }
  }
  const { data: books, error: booksError } = await service.from("books_settings").select("workspace_enabled, arc_ledger_mode").eq("org_id", input.orgId).maybeSingle()
  if (booksError) throw new Error(`Unable to verify Books posture: ${booksError.message}`)
  const results: Array<{ obligationId: string; action: string }> = []
  for (const row of open) {
    const { data: outcome, error: unwindError } = await service.rpc("unwind_sales_commission", {
      p_org_id: input.orgId, p_obligation_id: row.id, p_actor_id: input.userId, p_reason: input.reason, p_date: input.date,
    })
    if (unwindError) throw new Error(`Unable to unwind commission line ${row.line_no}: ${unwindError.message}`)
    const result = z.object({ action: z.string(), adjustment_id: z.string().optional(), credit_bill_id: z.string().optional() }).parse(outcome)
    if (row.payout_channel === "payroll" && isBooksPosting(books)) {
      if (result.action === "cleared") {
        const { data: entry, error: entryError } = await service.from("journal_entries").select("id").eq("org_id", input.orgId)
          .eq("posting_key", buildPostingKey(`sales_commission_accrual:${row.id}`, { projectionVersion: 1 })).eq("status", "posted").maybeSingle()
        if (entryError) throw new Error(`Unable to read the commission accrual: ${entryError.message}`)
        if (entry) await reverseBooksJournalEntryForService({ entryId: String(entry.id), reversalDate: input.date, reason: `Closing reversed: ${input.reason}`.slice(0, 500), orgId: input.orgId })
      } else if (result.action === "reversed" && result.adjustment_id) {
        await postBooksJournalEntryForService(accrualDraft({ ...row, id: result.adjustment_id }, input.date, true), input.orgId)
      }
    }
    results.push({ obligationId: row.id, action: result.action })
    await Promise.all([
      recordEvent({ orgId: input.orgId, actorId: input.userId, eventType: result.action === "cleared" ? "sales_commission_cleared" : "sales_commission_reversed",
        entityType: "sales_commission_obligation", entityId: row.id, payload: { closing_id: input.closingId, credit_bill_id: result.credit_bill_id ?? null, adjustment_id: result.adjustment_id ?? null } }),
      recordAudit({ orgId: input.orgId, actorId: input.userId, action: "update", entityType: "sales_commission_obligation", entityId: row.id,
        before: { status: "open" }, after: { status: result.action === "cleared" ? "cleared" : "reversed", reason: input.reason } }),
    ])
  }
  return results
}

/** Payroll reports a commission (or a clawback deduction) as carried by one of its runs. */
export async function markPayrollCommissionPaid(input: unknown, orgId?: string) {
  const parsed = markPayrollCommissionPaidSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const { data: row, error } = await context.supabase.from("sales_commission_obligations").select("id, project_id, paid_on")
    .eq("org_id", context.orgId).eq("id", parsed.obligationId).maybeSingle()
  if (error || !row) throw new Error("Commission not found")
  await requireAuthorization({ permission: "payment.release", userId: context.userId, orgId: context.orgId, projectId: row.project_id,
    supabase: context.supabase, resourceType: "sales_commission_obligation", resourceId: row.id, logDecision: true })
  const { data, error: markError } = await createServiceSupabaseClient().rpc("mark_sales_commission_payroll_paid", {
    p_org_id: context.orgId, p_obligation_id: row.id, p_reference: parsed.payrollReference, p_paid_on: parsed.paidOn,
  })
  if (markError) throw new Error(markError.message)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "sales_commission_paid_by_payroll", entityType: "sales_commission_obligation", entityId: row.id,
      payload: { payroll_reference: parsed.payrollReference, paid_on: parsed.paidOn } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "sales_commission_obligation", entityId: row.id,
      before: { paid_on: row.paid_on }, after: { paid_on: parsed.paidOn, payroll_reference: parsed.payrollReference } }),
  ])
  return data
}

export type PayrollCommissionRow = {
  id: string
  projectId: string
  homeName: string
  closingId: string
  payeeUserId: string | null
  payeeName: string
  amountCents: number
  clawback: boolean
  createdAt: string
}

/** What the next payroll must carry: accrued comp and clawback deductions not yet marked paid. */
export async function listPayrollCommissionsDue(orgId?: string): Promise<{ rows: PayrollCommissionRow[]; truncated: boolean }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const { data, error } = await context.supabase.from("sales_commission_obligations")
    .select("id, project_id, closing_id, payee_user_id, amount_cents, adjusts_obligation_id, created_at")
    .eq("org_id", context.orgId).eq("payout_channel", "payroll").eq("status", "open").is("paid_on", null)
    .order("created_at").limit(PAYROLL_EXPORT_CAP + 1)
  if (error) throw new Error(`Unable to read payroll commissions: ${error.message}`)
  const rows = data ?? []
  const homeIds = Array.from(new Set(rows.map((row) => String(row.project_id))))
  const [names, homes] = await Promise.all([
    userNames(createServiceSupabaseClient(), rows.map((row) => String(row.payee_user_id ?? ""))),
    homeIds.length ? context.supabase.from("projects").select("id, name").eq("org_id", context.orgId).in("id", homeIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (homes.error) throw new Error(`Unable to read the homes: ${homes.error.message}`)
  const homeNames = new Map((homes.data ?? []).map((row) => [String(row.id), String(row.name)]))
  return {
    truncated: rows.length > PAYROLL_EXPORT_CAP,
    rows: rows.slice(0, PAYROLL_EXPORT_CAP).map((row) => ({
      id: String(row.id), projectId: String(row.project_id), homeName: homeNames.get(String(row.project_id)) ?? "Home", closingId: String(row.closing_id), payeeUserId: row.payee_user_id ?? null,
      payeeName: names.get(String(row.payee_user_id)) ?? "Sales consultant", amountCents: Number(row.amount_cents),
      clawback: row.adjusts_obligation_id !== null, createdAt: String(row.created_at),
    })),
  }
}

function payableState(row: { status: string; payout_channel: string; paid_on: string | null }, bill: { status: string } | undefined): CommissionPayableState {
  if (row.status === "cleared") return "cleared"
  if (row.status === "reversed") return "reversed"
  if (row.payout_channel === "payroll") return row.paid_on ? "paid_payroll" : "accrued"
  switch (bill?.status) {
    case "approved": return "approved"
    case "partial": return "partial"
    case "paid": return "paid"
    case "rejected": return "rejected"
    default: return "pending_ap"
  }
}

/** The closing workbench's commission band: terms, what settlement owes, and where each payable stands. */
export async function getClosingCommissions(projectId: string, orgId?: string): Promise<ClosingCommissionsView | null> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const parsedProjectId = z.string().uuid().parse(projectId)
  await requireAuthorization({ permission: "sales.read", userId: context.userId, orgId: context.orgId, projectId: parsedProjectId,
    supabase: context.supabase, resourceType: "project", resourceId: parsedProjectId })
  const [closingResult, contractResult] = await Promise.all([
    context.supabase.from("closings").select("id, status, settlement").eq("org_id", context.orgId).eq("project_id", parsedProjectId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    context.supabase.from("contracts").select("id, status").eq("org_id", context.orgId).eq("project_id", parsedProjectId)
      .eq("contract_type", "purchase_agreement").in("status", ["draft", "active"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  if (closingResult.error) throw new Error(`Unable to read the closing: ${closingResult.error.message}`)
  if (contractResult.error) throw new Error(`Unable to read the agreement: ${contractResult.error.message}`)
  const closing = closingResult.data
  if (!closing) return null
  const settledContractId = (closing.settlement as Record<string, unknown> | null)?.contractId
  const contractId = typeof settledContractId === "string" ? settledContractId : contractResult.data?.id
  if (!contractId) return null
  const agreement = await buildAgreementView(context, String(contractId))

  const service = createServiceSupabaseClient()
  const [visible, total] = await Promise.all([
    context.supabase.from("sales_commission_obligations").select(OBLIGATION_SELECT).eq("org_id", context.orgId).eq("closing_id", closing.id).order("line_no").order("created_at"),
    service.from("sales_commission_obligations").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("closing_id", closing.id),
  ])
  if (visible.error || total.error) throw new Error(`Unable to read the closing's commissions: ${(visible.error ?? total.error)?.message}`)
  const rows = visible.data ?? []
  const billIds = rows.flatMap((row) => [row.vendor_bill_id, row.reversal_credit_bill_id]).filter((id): id is string => typeof id === "string")
  const [bills, creditApplications] = billIds.length ? await Promise.all([
    service.from("vendor_bills").select("id, bill_number, status, total_cents, paid_cents").eq("org_id", context.orgId).in("id", billIds),
    service.from("payments").select("amount_cents, metadata").eq("org_id", context.orgId).in("metadata->>vendor_credit_id", billIds).not("status", "in", "(canceled,refunded)"),
  ]) : [{ data: [], error: null }, { data: [], error: null }]
  if (bills.error || creditApplications.error) throw new Error(`Unable to read commission payables: ${(bills.error ?? creditApplications.error)?.message}`)
  const billById = new Map((bills.data ?? []).map((bill) => [String(bill.id), bill]))
  const appliedByCredit = new Map<string, number>()
  for (const payment of creditApplications.data ?? []) {
    const creditId = String((payment.metadata as Record<string, unknown> | null)?.vendor_credit_id ?? "")
    appliedByCredit.set(creditId, (appliedByCredit.get(creditId) ?? 0) + Number(payment.amount_cents ?? 0))
  }
  const paidAdjustment = new Map(rows.filter((row) => row.adjusts_obligation_id).map((row) => [String(row.adjusts_obligation_id), row]))
  const lineNames = new Map((agreement.plan?.lines ?? []).map((line) => [line.id, line.payeeName]))
  const names = await userNames(service, rows.map((row) => String(row.payee_user_id ?? "")))
  const companyIds = Array.from(new Set(rows.flatMap((row) => row.payee_company_id ? [String(row.payee_company_id)] : [])))
  const companies = companyIds.length ? await service.from("companies").select("id, name").eq("org_id", context.orgId).in("id", companyIds) : { data: [], error: null }
  if (companies.error) throw new Error(`Unable to read commission payees: ${companies.error.message}`)
  const companyNames = new Map((companies.data ?? []).map((row) => [String(row.id), String(row.name)]))
  const obligations: CommissionObligationView[] = rows.map((row) => {
    const bill = row.vendor_bill_id ? billById.get(String(row.vendor_bill_id)) : undefined
    const credit = row.reversal_credit_bill_id ? billById.get(String(row.reversal_credit_bill_id)) : undefined
    const adjustment = row.adjusts_obligation_id !== null
    const clawbackOpenCents = credit
      ? Math.abs(Number(credit.total_cents ?? 0)) - (appliedByCredit.get(String(credit.id)) ?? 0)
      : row.status === "reversed" && row.payout_channel === "payroll"
        ? (paidAdjustment.get(String(row.id))?.paid_on ? 0 : Number(row.amount_cents))
        : 0
    return {
      id: String(row.id),
      lineNo: Number(row.line_no),
      kind: row.kind,
      payoutChannel: row.payout_channel,
      payeeName: lineNames.get(String(row.plan_line_id))
        ?? (row.payee_company_id ? companyNames.get(String(row.payee_company_id)) : undefined)
        ?? names.get(String(row.payee_user_id)) ?? "Payee",
      basisPriceCents: Number(row.basis_price_cents),
      rateBps: row.rate_bps === null ? null : Number(row.rate_bps),
      flatCents: row.flat_cents === null ? null : Number(row.flat_cents),
      amountCents: Number(row.amount_cents),
      status: row.status,
      state: payableState(row, bill),
      billId: row.vendor_bill_id ?? null,
      billNumber: bill?.bill_number ?? null,
      paidCents: Number(bill?.paid_cents ?? 0),
      creditBillId: row.reversal_credit_bill_id ?? null,
      clawbackOpenCents: Math.max(clawbackOpenCents, 0),
      payrollReference: row.payroll_reference ?? null,
      endReason: row.end_reason ?? null,
      adjustment,
    }
  })
  return {
    ...agreement,
    closingId: String(closing.id),
    closingStatus: String(closing.status),
    obligations,
    hiddenObligationCount: (total.count ?? 0) - rows.length,
    closingRefusal: closing.status === "closed" || closing.status === "cancelled" ? null : commissionPlanRefusal(
      agreement.plan ? { status: agreement.plan.status } : null, "closing"),
  }
}

export type CommissionPayeeOption = { id: string; name: string; detail: string }

/** Brokerages and consultants' companies, one bounded page at a time. */
export async function searchCommissionPayeeCompanies(input: unknown, orgId?: string) {
  const parsed = commissionPayeeSearchSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.commission_manage", context)
  const pageSize = 20
  let query = context.supabase.from("companies").select("id, name, email, phone").eq("org_id", context.orgId).is("archived_at", null)
  if (parsed.search) query = query.ilike("name", `%${parsed.search.replace(/[%_]/g, "")}%`)
  const { data, error } = await query.order("name").order("id").range((parsed.page - 1) * pageSize, parsed.page * pageSize)
  if (error) throw new Error(`Unable to search companies: ${error.message}`)
  const rows = data ?? []
  return {
    items: rows.slice(0, pageSize).map((row) => ({ id: String(row.id), name: String(row.name), detail: String(row.email || row.phone || "Company") })),
    nextCursor: null,
    nextPage: rows.length > pageSize ? parsed.page + 1 : null,
  }
}

/** Active members who can be paid a consultant's commission. */
export async function searchCommissionConsultants(input: unknown, orgId?: string) {
  const parsed = commissionPayeeSearchSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.commission_manage", context)
  const pageSize = 20
  const service = createServiceSupabaseClient()
  const { data: members, error } = await service.from("memberships").select("user_id").eq("org_id", context.orgId).eq("status", "active").limit(2000)
  if (error) throw new Error(`Unable to read members: ${error.message}`)
  const ids = (members ?? []).map((row) => String(row.user_id))
  if (!ids.length) return { items: [], nextCursor: null, nextPage: null }
  let query = service.from("app_users").select("id, full_name, email").in("id", ids)
  if (parsed.search) {
    const term = parsed.search.replace(/[%_,()]/g, "")
    query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%`)
  }
  const { data, error: userError } = await query.order("full_name").order("id").range((parsed.page - 1) * pageSize, parsed.page * pageSize)
  if (userError) throw new Error(`Unable to search members: ${userError.message}`)
  const rows = data ?? []
  return {
    items: rows.slice(0, pageSize).map((row) => ({ id: String(row.id), name: String(row.full_name || row.email), detail: String(row.email ?? "") })),
    nextCursor: null,
    nextPage: rows.length > pageSize ? parsed.page + 1 : null,
  }
}

