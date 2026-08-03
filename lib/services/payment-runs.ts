import "server-only"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { quoteApDisbursementFee, type ApFeePolicy } from "@/lib/payments/fee-engine"
import {
  assertDisbursementTransition,
  createPaymentRunContentHash,
  requiredApprovalCount,
  type PaymentApprovalMode,
} from "@/lib/payments/payment-domain"
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { isFeatureEnabledForOrg } from "@/lib/services/feature-flags"
import {
  assertUserMayApproveRun,
  getPaymentApprovalRouting,
  type PaymentApprovalRouting,
} from "@/lib/services/payment-approvers"
import { assertBillReleasable } from "@/lib/services/payment-holds"
import { postDisbursementSubmittedLedger } from "@/lib/services/payment-ledger"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { requireRecentPaymentStepUp } from "@/lib/services/payment-step-up"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  createPaymentRunSchema,
  decidePaymentRunSchema,
  type CreatePaymentRunInput,
  type DecidePaymentRunInput,
} from "@/lib/validation/fintech-payments"
import { z } from "zod"

const EXECUTION_FLAG = "fintech_ap_payments"
const PAYMENT_RUN_LIST_LIMIT = 100
const PAYMENT_RUN_ITEM_LIST_LIMIT = 1_000

interface PaymentRunReviewRow {
  id: string
  status: string
  currency: string
  payment_count: number
  vendor_amount_cents: number
  processor_fee_cents: number
  platform_fee_cents: number
  total_debit_cents: number
  approval_mode_snapshot: string
  required_approvals: number
  content_hash: string | null
  requested_by: string
  requested_at: string | null
  approved_at: string | null
  processing_started_at: string | null
  completed_at: string | null
  created_at: string
}

interface PaymentRunApprovalReviewRow {
  id: string
  run_id: string
  approver_id: string
  decision: string
  created_at: string
}

interface PaymentRunItemReviewRow {
  id: string
  run_id: string
  bill_id: string
  project_id: string | null
  vendor_amount_cents: number
  processor_fee_cents: number
  platform_fee_cents: number
  hold_snapshot: unknown
  waiver_snapshot: unknown
}

interface PaymentRunPayeeReviewRow {
  id: string
  run_item_id: string
  payee_name: string
  payee_kind: string
  method: string
  amount_cents: number
}

interface PaymentRunBillReviewRow {
  id: string
  bill_number: string | null
  company_id: string | null
}

interface PaymentRunNameRow {
  id: string
  name: string
}

async function loadApFeePolicy(orgId: string): Promise<ApFeePolicy> {
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()
  const [{ data: orgPolicy }, { data: platformPolicy }] = await Promise.all([
    supabase.from("payment_fee_policies").select("pass_through_processor_fees,processor_fee_bps,processor_fee_fixed_cents,processor_fee_cap_cents,ap_platform_fee_flat_cents,ap_platform_fee_bps").eq("org_id", orgId).lte("effective_from", now).is("effective_to", null).maybeSingle(),
    supabase.from("payment_fee_policies").select("pass_through_processor_fees,processor_fee_bps,processor_fee_fixed_cents,processor_fee_cap_cents,ap_platform_fee_flat_cents,ap_platform_fee_bps").is("org_id", null).lte("effective_from", now).is("effective_to", null).maybeSingle(),
  ])
  const policy = orgPolicy ?? platformPolicy
  if (!policy) throw new Error("AP provider pricing has not been approved and configured")
  if (policy.pass_through_processor_fees && policy.processor_fee_bps == null && policy.processor_fee_fixed_cents == null) {
    throw new Error("AP processor pass-through pricing is incomplete")
  }
  return {
    passThroughProcessorFees: Boolean(policy.pass_through_processor_fees),
    processorFeeBps: Number(policy.processor_fee_bps ?? 0),
    processorFeeFixedCents: Number(policy.processor_fee_fixed_cents ?? 0),
    processorFeeCapCents: policy.processor_fee_cap_cents == null ? null : Number(policy.processor_fee_cap_cents),
    platformFeeFlatCents: Number(policy.ap_platform_fee_flat_cents ?? 0),
    platformFeeBps: Number(policy.ap_platform_fee_bps ?? 0),
  }
}

async function loadPaymentPolicy(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("payment_rail_policies").select("enabled,approval_mode,per_payment_limit_cents,per_run_limit_cents,daily_limit_cents,waiver_jurisdiction,require_waiver_snapshot").eq("org_id", orgId).maybeSingle()
  if (error) throw new Error(`Unable to load payment policy: ${error.message}`)
  if (!data) throw new Error("Configure the organization's payment policy before creating a run")
  return data
}

function paymentRunHashValue(run: Record<string, unknown>, items: Array<Record<string, unknown>>) {
  return {
    funding_source_id: run.funding_source_id,
    currency: run.currency,
    approval_mode: run.approval_mode_snapshot,
    required_approvals: run.required_approvals,
    totals: {
      vendor_amount_cents: run.vendor_amount_cents,
      processor_fee_cents: run.processor_fee_cents,
      platform_fee_cents: run.platform_fee_cents,
      total_debit_cents: run.total_debit_cents,
    },
    items: [...items].sort((left, right) => String(left.id).localeCompare(String(right.id))).map((item) => ({
      id: item.id,
      bill_id: item.bill_id,
      relationship_id: item.relationship_id,
      gross_payment_cents: item.gross_payment_cents,
      retainage_held_cents: item.retainage_held_cents,
      vendor_amount_cents: item.vendor_amount_cents,
      processor_fee_cents: item.processor_fee_cents,
      platform_fee_cents: item.platform_fee_cents,
      total_debit_cents: item.total_debit_cents,
      allocation_snapshot: item.allocation_snapshot,
      hold_snapshot: item.hold_snapshot,
      waiver_snapshot: item.waiver_snapshot,
      payees: Array.isArray(item.payees)
        ? [...item.payees].sort((left, right) => String(left.id).localeCompare(String(right.id)))
        : item.payees,
    })),
  }
}

export async function createPaymentRun(input: CreatePaymentRunInput, orgId?: string) {
  const parsed = createPaymentRunSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const { data: existingRun } = await supabase.from("payment_runs")
    .select("id,status,total_debit_cents,required_approvals")
    .eq("org_id", context.orgId)
    .eq("idempotency_key", parsed.idempotency_key)
    .maybeSingle()
  if (existingRun) {
    return {
      id: existingRun.id,
      status: existingRun.status,
      totalDebitCents: Number(existingRun.total_debit_cents),
      requiredApprovals: Number(existingRun.required_approvals),
    }
  }
  const [policy, feePolicy] = await Promise.all([loadPaymentPolicy(context.orgId), loadApFeePolicy(context.orgId)])
  if (!policy.enabled) throw new Error("Electronic payments are not enabled for this organization")

  const { data: funding, error: fundingError } = await supabase.from("org_funding_sources").select("id,provider,provider_customer_id,provider_payment_method_id,status,verification_status,mandate_status,usable_after").eq("org_id", context.orgId).eq("id", parsed.funding_source_id).maybeSingle()
  if (fundingError || !funding) throw new Error("Funding source was not found")
  if (funding.status !== "active" || funding.verification_status !== "verified" || funding.mandate_status !== "accepted") throw new Error("Funding source is not active and verified")
  if (funding.usable_after && new Date(funding.usable_after) > new Date()) throw new Error("Funding source is still in its security cooling period")

  const billIds = parsed.items.map((item) => item.bill_id)
  const { data: bills, error: billsError } = await supabase.from("vendor_bills").select("id,org_id,project_id,company_id,status,total_cents,paid_cents,retainage_cents,currency,bill_number,lien_waiver_status").eq("org_id", context.orgId).in("id", billIds)
  if (billsError || !bills || bills.length !== billIds.length) throw new Error("One or more vendor bills were not found")
  const billById = new Map(bills.map((bill) => [bill.id, bill]))
  const companyIds = [...new Set(bills.map((bill) => bill.company_id).filter(Boolean))]
  const { data: relationships, error: relationshipsError } = await supabase.from("vendor_payment_relationships").select("id,company_id,status,recipient_account_id,recipient:payment_recipient_accounts(id,provider,provider_account_id,status,payouts_enabled,destination_locked_until)").eq("org_id", context.orgId).in("company_id", companyIds)
  if (relationshipsError) throw new Error(`Unable to load vendor payment relationships: ${relationshipsError.message}`)
  const relationshipByCompany = new Map((relationships ?? []).map((relationship) => [relationship.company_id, relationship]))
  const releaseEvidence = await Promise.all(parsed.items.map((item) => assertBillReleasable(item.bill_id, context.orgId)))
  const evidenceByBill = new Map(releaseEvidence.map((evidence) => [evidence.billId, evidence]))

  let vendorAmountCents = 0
  let processorFeeCents = 0
  let platformFeeCents = 0
  const preparedItems = parsed.items.map((item) => {
    const bill = billById.get(item.bill_id)
    if (!bill || !bill.company_id) throw new Error("Every electronic payable must identify a vendor company")
    if (!["approved", "partial"].includes(bill.status)) throw new Error(`Bill ${bill.bill_number ?? bill.id} is not approved for payment`)
    const relationship = relationshipByCompany.get(bill.company_id)
    const recipient = Array.isArray(relationship?.recipient) ? relationship.recipient[0] : relationship?.recipient
    if (!relationship || relationship.status !== "active" || !recipient || recipient.status !== "ready" || !recipient.payouts_enabled) {
      throw new Error(`Vendor for bill ${bill.bill_number ?? bill.id} is not ready for electronic payment`)
    }
    if (recipient.destination_locked_until && new Date(recipient.destination_locked_until) > new Date()) throw new Error("Vendor payout destination is in a security cooling period")
    if (item.payees.some((payee) => payee.method !== "ach")) {
      throw new Error("Record external and joint checks through the existing external-payment workflow; electronic runs contain ACH payees only")
    }
    const outstandingCents = payableOutstandingCents({ total_cents: Number(bill.total_cents ?? 0), paid_cents: Number(bill.paid_cents ?? 0), retainage_cents: Number(bill.retainage_cents ?? 0) })
    if (item.amount_cents > outstandingCents) throw new Error(`Payment for bill ${bill.bill_number ?? bill.id} exceeds its outstanding balance`)
    if (policy.per_payment_limit_cents && item.amount_cents > Number(policy.per_payment_limit_cents)) throw new Error(`Payment for bill ${bill.bill_number ?? bill.id} exceeds the organization's per-payment limit`)
    const fee = quoteApDisbursementFee({ vendorAmountCents: item.amount_cents, policy: feePolicy })
    vendorAmountCents += fee.vendorAmountCents
    processorFeeCents += fee.processorFeeCents
    platformFeeCents += fee.platformFeeCents
    return {
      bill,
      relationship,
      evidence: evidenceByBill.get(item.bill_id),
      input: item,
      fee,
      recipient,
      outstandingCents,
    }
  })
  const totalDebitCents = vendorAmountCents + processorFeeCents + platformFeeCents
  if (policy.per_run_limit_cents && totalDebitCents > Number(policy.per_run_limit_cents)) throw new Error("Payment run exceeds the organization's per-run limit")

  const approvalMode: PaymentApprovalMode = policy.approval_mode === "sole" ? "sole" : "dual"
  const requiredApprovals = requiredApprovalCount(approvalMode)
  const currency = bills[0]?.currency ?? "usd"
  const atomicItems = preparedItems.map((prepared) => ({
    project_id: prepared.bill.project_id,
    bill_id: prepared.bill.id,
    relationship_id: prepared.relationship.id,
    bill_balance_snapshot_cents: prepared.outstandingCents,
    gross_payment_cents: prepared.input.amount_cents + prepared.input.retainage_held_cents,
    retainage_held_cents: prepared.input.retainage_held_cents,
    vendor_amount_cents: prepared.fee.vendorAmountCents,
    processor_fee_cents: prepared.fee.processorFeeCents,
    platform_fee_cents: prepared.fee.platformFeeCents,
    total_debit_cents: prepared.fee.totalDebitCents,
    allocation_snapshot: [],
    hold_snapshot: prepared.evidence?.holdEvaluation ?? {},
    waiver_snapshot: { jurisdiction: "FL", lien_waiver_status: prepared.bill.lien_waiver_status ?? null, captured_at: prepared.evidence?.capturedAt },
    payees: prepared.input.payees.map((payee) => ({
      payee_kind: payee.payee_kind,
      method: payee.method,
      recipient_account_id: payee.recipient_account_id ?? (payee.payee_kind === "primary_vendor" ? prepared.recipient.id : null),
      payee_name: payee.payee_name,
      amount_cents: payee.amount_cents,
    })),
  }))
  const { data: created, error: createError } = await supabase.rpc("create_payment_run_atomic", {
    p_org_id: context.orgId,
    p_requested_by: context.userId,
    p_funding_source_id: funding.id,
    p_currency: currency,
    p_approval_mode: approvalMode,
    p_required_approvals: requiredApprovals,
    p_vendor_amount_cents: vendorAmountCents,
    p_processor_fee_cents: processorFeeCents,
    p_platform_fee_cents: platformFeeCents,
    p_total_debit_cents: totalDebitCents,
    p_control_snapshot: { policy, fee_policy: feePolicy, funding_source_status: funding.status },
    p_idempotency_key: parsed.idempotency_key,
    p_items: atomicItems,
  })
  const runId = created && typeof created === "object" && !Array.isArray(created) ? Reflect.get(created, "id") : null
  if (createError || typeof runId !== "string") throw new Error(`Unable to create payment run: ${createError?.message ?? "Atomic write returned no run"}`)
  const duplicate = Reflect.get(created, "duplicate") === true
  if (duplicate) {
    const existingStatus = Reflect.get(created, "status")
    const existingTotalDebitCents = Reflect.get(created, "total_debit_cents")
    const existingRequiredApprovals = Reflect.get(created, "required_approvals")
    return {
      id: runId,
      status: typeof existingStatus === "string" ? existingStatus : "draft",
      totalDebitCents: Number(existingTotalDebitCents),
      requiredApprovals: Number(existingRequiredApprovals),
    }
  }

  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_created", entityType: "payment_run", entityId: runId, payload: { payment_count: parsed.items.length, total_debit_cents: totalDebitCents } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "payment_run", entityId: runId, after: { payment_count: parsed.items.length, total_debit_cents: totalDebitCents, approval_mode: approvalMode } }),
  ])
  return { id: runId, status: "draft", totalDebitCents, requiredApprovals }
}

async function loadRunHashMaterial(runId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: run, error } = await supabase.from("payment_runs").select("*").eq("org_id", orgId).eq("id", runId).maybeSingle()
  if (error || !run) throw new Error("Payment run was not found")
  const { data: items, error: itemsError } = await supabase.from("payment_run_items").select("*,payees:payment_run_item_payees(id,payee_kind,method,recipient_account_id,payee_name,amount_cents)").eq("org_id", orgId).eq("run_id", runId).order("created_at")
  if (itemsError) throw new Error(`Unable to load payment run items: ${itemsError.message}`)
  return { run, items: items ?? [], contentHash: createPaymentRunContentHash(paymentRunHashValue(run, items ?? [])) }
}

export async function submitPaymentRun(runId: string, orgId?: string) {
  const parsedRunId = z.string().uuid().parse(runId)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const material = await loadRunHashMaterial(parsedRunId, context.orgId)
  if (material.run.requested_by !== context.userId) throw new Error("Only the payment-run preparer can submit it")
  if (material.run.status !== "draft") throw new Error("Only a draft payment run can be submitted")
  await Promise.all(material.items.map((item) => assertBillReleasable(item.bill_id, context.orgId, { excludePaymentRunId: parsedRunId })))
  await assertRunRiskAllowed(material.run, material.items, context.orgId)
  const now = new Date().toISOString()
  const { data, error } = await supabase.rpc("submit_payment_run_atomic", {
    p_org_id: context.orgId,
    p_run_id: parsedRunId,
    p_requester_id: context.userId,
    p_content_hash: material.contentHash,
    p_requested_at: now,
  })
  if (error || !data) throw new Error("Payment run changed before it could be submitted")
  // Notification copy has to say what is being approved, so the event carries the
  // bill context rather than making every recipient open the run to find out.
  const summary = await summarizeRunForNotification(parsedRunId, context.orgId, material.items)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_submitted", entityType: "payment_run", entityId: parsedRunId, payload: { content_hash: material.contentHash, total_debit_cents: Number(material.run.total_debit_cents), required_approvals: Number(material.run.required_approvals), ...summary } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "payment_run", entityId: parsedRunId, before: { status: "draft" }, after: { status: "pending_approval", content_hash: material.contentHash } }),
  ])
  return { id: parsedRunId, status: "pending_approval", content_hash: material.contentHash }
}

/**
 * Bill-level context for a run's notifications: enough for an approver to know
 * what they are being asked to release without opening anything.
 */
async function summarizeRunForNotification(runId: string, orgId: string, items: Array<Record<string, unknown>>) {
  const supabase = createServiceSupabaseClient()
  const billIds = items.map((item) => item.bill_id).filter((value): value is string => typeof value === "string")
  const { data: bills } = billIds.length > 0
    ? await supabase.from("vendor_bills").select("id,bill_number,project_id,company_id").eq("org_id", orgId).in("id", billIds)
    : { data: [] }
  const first = (bills ?? [])[0]
  const { data: company } = first?.company_id
    ? await supabase.from("companies").select("name").eq("org_id", orgId).eq("id", first.company_id).maybeSingle()
    : { data: null }
  const { data: project } = first?.project_id
    ? await supabase.from("projects").select("name").eq("org_id", orgId).eq("id", first.project_id).maybeSingle()
    : { data: null }
  return {
    bill_id: first?.id ?? null,
    bill_number: first?.bill_number ?? null,
    project_id: first?.project_id ?? null,
    project_name: project?.name ?? null,
    vendor_name: company?.name ?? null,
    bill_count: billIds.length,
  }
}

export async function cancelPaymentRun(runId: string, orgId?: string) {
  const parsedRunId = z.string().uuid().parse(runId)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await supabase.from("payment_runs")
    .select("id,status,requested_by")
    .eq("org_id", context.orgId)
    .eq("id", parsedRunId)
    .maybeSingle()
  if (existingError || !existing) throw new Error("Payment run was not found")
  const { data, error } = await supabase.rpc("cancel_payment_run_atomic", {
    p_org_id: context.orgId,
    p_run_id: parsedRunId,
    p_requester_id: context.userId,
  })
  if (error || !data) throw new Error(`Unable to cancel payment run: ${error?.message ?? "Atomic cancellation failed"}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_canceled", entityType: "payment_run", entityId: parsedRunId, payload: { prior_status: existing.status } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "payment_run", entityId: parsedRunId, before: { status: existing.status }, after: { status: "canceled" } }),
  ])
  return { id: parsedRunId, status: "canceled" }
}

export async function decidePaymentRun(input: DecidePaymentRunInput, orgId?: string) {
  const parsed = decidePaymentRunSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payments.approve_run", context)
  const stepUpVerifiedAt = await requireRecentPaymentStepUp()
  const supabase = createServiceSupabaseClient()
  const material = await loadRunHashMaterial(parsed.run_id, context.orgId)
  if (material.contentHash !== parsed.content_hash || material.run.content_hash !== parsed.content_hash) throw new Error("Payment run changed after review; reload it before deciding")
  // Permission says you *can* approve; the roster says the org designated you to.
  await assertUserMayApproveRun({ userId: context.userId, orgId: context.orgId, totalDebitCents: Number(material.run.total_debit_cents) })
  const { data, error } = await supabase.rpc("decide_payment_run_atomic", {
    p_org_id: context.orgId,
    p_run_id: parsed.run_id,
    p_approver_id: context.userId,
    p_decision: parsed.decision,
    p_reason: parsed.reason ?? null,
    p_content_hash: parsed.content_hash,
    p_step_up_verified_at: stepUpVerifiedAt,
  })
  if (error || !data) throw new Error(`Unable to decide payment run: ${error?.message}`)
  const decisionStatus = data && typeof data === "object" ? Reflect.get(data, "status") : null
  const eventType = parsed.decision === "rejected"
    ? "payment_run_rejected"
    : decisionStatus === "approved"
      ? "payment_run_approved"
      : "payment_run_approval_recorded"
  const summary = await summarizeRunForNotification(parsed.run_id, context.orgId, material.items)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType, entityType: "payment_run", entityId: parsed.run_id, payload: { content_hash: parsed.content_hash, status: decisionStatus, total_debit_cents: Number(material.run.total_debit_cents), reason: parsed.reason ?? null, ...summary } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "payment_run_approval", entityId: parsed.run_id, after: { decision: parsed.decision, content_hash: parsed.content_hash } }),
  ])
  return data
}

async function assertRunRiskAllowed(run: Record<string, unknown>, items: Array<Record<string, unknown>>, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const controlSnapshot = run.control_snapshot && typeof run.control_snapshot === "object" && !Array.isArray(run.control_snapshot)
    ? run.control_snapshot
    : null
  const policyValue = controlSnapshot ? Reflect.get(controlSnapshot, "policy") : null
  const policy = policyValue && typeof policyValue === "object" && !Array.isArray(policyValue) ? policyValue : null
  const signals: Array<Record<string, unknown>> = []
  const perRunLimitCents = policy ? Reflect.get(policy, "per_run_limit_cents") : null
  const dailyLimitCents = policy ? Reflect.get(policy, "daily_limit_cents") : null
  if (perRunLimitCents && Number(run.total_debit_cents) > Number(perRunLimitCents)) signals.push({ code: "run_limit_exceeded", severity: "block" })
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
  const failureWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const relationshipIds = [...new Set(items.map((item) => item.relationship_id).filter((value): value is string => typeof value === "string"))]
  const [{ data: dailyRows }, { count: recentFailureCount }, { data: relationships }] = await Promise.all([
    supabase.from("disbursements").select("amount_cents,processor_fee_cents,platform_fee_cents").eq("org_id", orgId).gte("created_at", dayStart.toISOString()).not("status", "in", "(failed,canceled)"),
    supabase.from("disbursements").select("id", { count: "exact", head: true }).eq("org_id", orgId).gte("created_at", failureWindowStart).in("status", ["failed", "returned"]),
    relationshipIds.length > 0
      ? supabase.from("vendor_payment_relationships").select("id,accepted_at,created_at").eq("org_id", orgId).in("id", relationshipIds)
      : Promise.resolve({ data: [] }),
  ])
  const dailyCents = (dailyRows ?? []).reduce((sum, row) => sum + Number(row.amount_cents) + Number(row.processor_fee_cents) + Number(row.platform_fee_cents), 0) + Number(run.total_debit_cents)
  if (dailyLimitCents && dailyCents > Number(dailyLimitCents)) signals.push({ code: "daily_limit_exceeded", severity: "block", daily_cents: dailyCents })
  if ((recentFailureCount ?? 0) >= 3) signals.push({ code: "repeated_payment_failures", severity: "block", count: recentFailureCount })
  const duplicateBillIds = items.map((item) => item.bill_id)
  if (new Set(duplicateBillIds).size !== duplicateBillIds.length) signals.push({ code: "duplicate_bill", severity: "block" })
  const duplicateRelationshipAmounts = items.map((item) => `${String(item.relationship_id)}:${Number(item.vendor_amount_cents)}`)
  if (new Set(duplicateRelationshipAmounts).size !== duplicateRelationshipAmounts.length) signals.push({ code: "repeated_vendor_amount", severity: "observe" })
  const newRelationshipCutoff = Date.now() - 72 * 60 * 60 * 1000
  if ((relationships ?? []).some((relationship) => new Date(relationship.accepted_at ?? relationship.created_at).getTime() > newRelationshipCutoff)) {
    signals.push({ code: "recently_claimed_vendor_relationship", severity: "observe" })
  }
  const decision = signals.some((signal) => signal.severity === "block") ? "block" : "allow"
  const riskScore = decision === "block" ? 100 : signals.length > 0 ? 25 : 0
  const { error } = await supabase.from("payment_risk_reviews").insert({ org_id: orgId, run_id: run.id, review_type: "automated", decision, signals, risk_score: riskScore })
  if (error) throw new Error(`Unable to record payment risk review: ${error.message}`)
  if (decision !== "allow") throw new Error("Payment run is blocked by automated risk controls")
}

export async function executePaymentRun(runId: string, orgId?: string) {
  const parsedRunId = z.string().uuid().parse(runId)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  if (process.env.FINTECH_PAYMENTS_EXECUTION_ENABLED !== "true") throw new Error("Electronic payment execution is disabled pending provider and legal approval")
  const flagEnabled = await isFeatureEnabledForOrg({ supabase, orgId: context.orgId, flagKey: EXECUTION_FLAG, defaultEnabled: false })
  if (!flagEnabled) throw new Error("Electronic payment execution is not enabled for this organization")
  const material = await loadRunHashMaterial(parsedRunId, context.orgId)
  if (material.run.status !== "approved") throw new Error("Payment run must be fully approved before execution")
  if (!material.run.content_hash || material.contentHash !== material.run.content_hash) throw new Error("Payment run changed after approval")
  await Promise.all(material.items.map((item) => assertBillReleasable(item.bill_id, context.orgId, { excludePaymentRunId: parsedRunId })))
  await assertRunRiskAllowed(material.run, material.items, context.orgId)

  const { data: funding } = await supabase.from("org_funding_sources").select("id,provider,provider_customer_id,provider_payment_method_id,status,usable_after").eq("org_id", context.orgId).eq("id", material.run.funding_source_id).maybeSingle()
  if (!funding || funding.status !== "active" || (funding.usable_after && new Date(funding.usable_after) > new Date())) throw new Error("Payment run funding source is no longer usable")
  const provider = getPaymentRailProvider(funding.provider)
  const now = new Date().toISOString()
  await supabase.from("payment_runs").update({ status: "processing", processing_started_at: now }).eq("org_id", context.orgId).eq("id", parsedRunId).eq("status", "approved")
  await supabase.from("payment_run_items").update({ status: "processing" }).eq("org_id", context.orgId).eq("run_id", parsedRunId).eq("status", "approved")

  const results: Array<{ disbursementId: string; status: string }> = []
  for (const item of material.items) {
    const payees = Array.isArray(item.payees) ? item.payees : []
    let allocatedProcessorFeeCents = 0
    let allocatedPlatformFeeCents = 0
    for (const [payeeIndex, payee] of payees.entries()) {
      if (payee.method !== "ach") continue
      const { data: recipient } = await supabase.from("payment_recipient_accounts").select("id,provider,provider_account_id,status,payouts_enabled,destination_locked_until").eq("id", payee.recipient_account_id).maybeSingle()
      if (!recipient || recipient.provider !== funding.provider || recipient.status !== "ready" || !recipient.payouts_enabled) throw new Error(`Payee ${payee.payee_name} is no longer ready for ACH`)
      if (recipient.destination_locked_until && new Date(recipient.destination_locked_until) > new Date()) throw new Error(`Payee ${payee.payee_name} has a payout destination security hold`)
      const idempotencyKey = `${parsedRunId}:${payee.id}:v${material.run.revision}`
      const isLastPayee = payeeIndex === payees.length - 1
      const payeeProcessorFeeCents = isLastPayee
        ? Number(item.processor_fee_cents) - allocatedProcessorFeeCents
        : Math.floor((Number(item.processor_fee_cents) * Number(payee.amount_cents)) / Number(item.vendor_amount_cents))
      const payeePlatformFeeCents = isLastPayee
        ? Number(item.platform_fee_cents) - allocatedPlatformFeeCents
        : Math.floor((Number(item.platform_fee_cents) * Number(payee.amount_cents)) / Number(item.vendor_amount_cents))
      allocatedProcessorFeeCents += payeeProcessorFeeCents
      allocatedPlatformFeeCents += payeePlatformFeeCents
      const { data: disbursement, error: disbursementError } = await supabase.from("disbursements").insert({
        org_id: context.orgId,
        project_id: item.project_id,
        run_id: parsedRunId,
        run_item_id: item.id,
        run_item_payee_id: payee.id,
        bill_id: item.bill_id,
        funding_source_id: funding.id,
        recipient_account_id: recipient.id,
        provider: provider.key,
        status: "created",
        amount_cents: payee.amount_cents,
        processor_fee_cents: payeeProcessorFeeCents,
        platform_fee_cents: payeePlatformFeeCents,
        currency: material.run.currency,
        transfer_group: `payment_run:${parsedRunId}`,
        idempotency_key: idempotencyKey,
      }).select("id,status").single()
      if (disbursementError || !disbursement) throw new Error(`Unable to create disbursement: ${disbursementError?.message}`)
      try {
        const providerResult = await provider.submitDisbursement({
          disbursementId: disbursement.id,
          orgId: context.orgId,
          recipientAmountCents: Number(payee.amount_cents),
          debitAmountCents: Number(payee.amount_cents) + payeeProcessorFeeCents + payeePlatformFeeCents,
          processorFeeCents: payeeProcessorFeeCents,
          platformFeeCents: payeePlatformFeeCents,
          currency: material.run.currency,
          providerCustomerId: funding.provider_customer_id,
          providerPaymentMethodId: funding.provider_payment_method_id,
          recipientProviderAccountId: recipient.provider_account_id,
          transferGroup: `payment_run:${parsedRunId}`,
          idempotencyKey,
          metadata: { payment_run_id: parsedRunId, payment_run_item_id: item.id, bill_id: item.bill_id },
        })
        assertDisbursementTransition(disbursement.status, "submitted")
        const { error: submittedError } = await supabase.from("disbursements").update({
          status: "submitted",
          provider_payment_id: providerResult.providerPaymentId,
          submitted_at: now,
        }).eq("org_id", context.orgId).eq("id", disbursement.id).eq("status", "created")
        if (submittedError) throw new Error(`Unable to record provider submission: ${submittedError.message}`)
        if (providerResult.status !== "submitted") {
          const forwardPath = ["submitted", "debit_pending", "funds_available"]
          const targetIndex = forwardPath.indexOf(providerResult.status)
          if (targetIndex < 0) {
            assertDisbursementTransition("submitted", providerResult.status)
            await supabase.from("disbursements").update({ status: providerResult.status }).eq("org_id", context.orgId).eq("id", disbursement.id).eq("status", "submitted")
          } else {
            let currentStatus = "submitted"
            for (const nextStatus of forwardPath.slice(1, targetIndex + 1)) {
              assertDisbursementTransition(currentStatus, nextStatus)
              const { error: statusError } = await supabase.from("disbursements").update({ status: nextStatus }).eq("org_id", context.orgId).eq("id", disbursement.id).eq("status", currentStatus)
              if (statusError) throw new Error(`Unable to advance provider submission: ${statusError.message}`)
              currentStatus = nextStatus
            }
          }
        }
        await supabase.from("payment_run_item_payees").update({ status: "processing" }).eq("org_id", context.orgId).eq("id", payee.id)
        await postDisbursementSubmittedLedger({
          orgId: context.orgId,
          disbursementId: disbursement.id,
          vendorAmountCents: Number(payee.amount_cents),
          processorFeeCents: payeeProcessorFeeCents,
          platformFeeCents: payeePlatformFeeCents,
          currency: material.run.currency,
          effectiveAt: now,
        })
        results.push({ disbursementId: disbursement.id, status: providerResult.status })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provider submission failed"
        await supabase.from("disbursements").update({ status: "failed", failure_reason: message }).eq("org_id", context.orgId).eq("id", disbursement.id)
        await supabase.from("payment_run_item_payees").update({ status: "failed" }).eq("org_id", context.orgId).eq("id", payee.id)
        await supabase.from("payment_run_items").update({ status: "failed", failure_reason: message }).eq("org_id", context.orgId).eq("id", item.id)
        const failedRunStatus = results.length > 0 ? "partially_failed" : "failed"
        await supabase.from("payment_runs").update({ status: failedRunStatus, completed_at: new Date().toISOString() }).eq("org_id", context.orgId).eq("id", parsedRunId)
        await Promise.all([
          recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_execution_failed", entityType: "payment_run", entityId: parsedRunId, payload: { disbursement_id: disbursement.id, error: message } }),
          recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "payment_run", entityId: parsedRunId, before: { status: "processing" }, after: { status: failedRunStatus, failure_reason: message } }),
        ])
        throw error
      }
    }
  }
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_execution_started", entityType: "payment_run", entityId: parsedRunId, payload: { disbursement_count: results.length } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "payment_run", entityId: parsedRunId, before: { status: "approved" }, after: { status: "processing", disbursement_count: results.length } }),
  ])
  return { runId: parsedRunId, status: "processing", disbursements: results }
}

export interface PaymentRunListRow {
  id: string
  status: string
  currency: string
  payment_count: number
  vendor_amount_cents: number
  processor_fee_cents: number
  platform_fee_cents: number
  total_debit_cents: number
  approval_mode_snapshot: string
  required_approvals: number
  content_hash: string | null
  requested_by: string
  requested_at: string | null
  approved_at: string | null
  processing_started_at: string | null
  completed_at: string | null
  created_at: string
  details_truncated: boolean
  can_cancel: boolean
  can_approve: boolean
  approvals: Array<{ id: string; approver_id: string; decision: string; created_at: string }>
  items: Array<{
    id: string
    billNumber: string
    vendorName: string
    projectName: string
    vendorAmountCents: number
    feeCents: number
    releasableAtSubmission: boolean
    waiverStatus: string | null
    payees: Array<{ id: string; name: string; kind: string; method: string; amountCents: number }>
  }>
}

export async function listPaymentRuns(orgId?: string): Promise<PaymentRunListRow[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const [routing, runResult] = await Promise.all([
    getPaymentApprovalRouting(context.orgId),
    supabase.from("payment_runs").select("id,status,currency,payment_count,vendor_amount_cents,processor_fee_cents,platform_fee_cents,total_debit_cents,approval_mode_snapshot,required_approvals,content_hash,requested_by,requested_at,approved_at,processing_started_at,completed_at,created_at").eq("org_id", context.orgId).order("created_at", { ascending: false }).limit(PAYMENT_RUN_LIST_LIMIT).overrideTypes<PaymentRunReviewRow[], { merge: false }>(),
  ])
  const { data, error } = runResult
  if (error) throw new Error(`Unable to list payment runs: ${error.message}`)
  const runIds = (data ?? []).map((run) => run.id)
  const [{ data: approvalRows, error: approvalError }, { data: loadedItemRows, error: itemError }] = await Promise.all([
    runIds.length > 0
      ? supabase.from("payment_run_approvals").select("id,run_id,approver_id,decision,created_at").eq("org_id", context.orgId).in("run_id", runIds).overrideTypes<PaymentRunApprovalReviewRow[], { merge: false }>()
      : Promise.resolve({ data: [], error: null }),
    runIds.length > 0
      ? supabase.from("payment_run_items").select("id,run_id,bill_id,project_id,vendor_amount_cents,processor_fee_cents,platform_fee_cents,hold_snapshot,waiver_snapshot").eq("org_id", context.orgId).in("run_id", runIds).order("created_at", { ascending: false }).limit(PAYMENT_RUN_ITEM_LIST_LIMIT + 1).overrideTypes<PaymentRunItemReviewRow[], { merge: false }>()
      : Promise.resolve({ data: [], error: null }),
  ])
  if (approvalError) throw new Error(`Unable to list payment run approvals: ${approvalError.message}`)
  if (itemError) throw new Error(`Unable to list payment run items: ${itemError.message}`)
  const detailsTruncated = (loadedItemRows ?? []).length > PAYMENT_RUN_ITEM_LIST_LIMIT
  const itemRows = (loadedItemRows ?? []).slice(0, PAYMENT_RUN_ITEM_LIST_LIMIT)
  const itemIds = itemRows.map((item) => item.id)
  const billIds = [...new Set(itemRows.map((item) => item.bill_id))]
  const projectIds = [...new Set(itemRows.map((item) => item.project_id).filter((value): value is string => Boolean(value)))]
  const [{ data: payeeRows }, { data: billRows }, { data: projectRows }] = await Promise.all([
    itemIds.length > 0 ? supabase.from("payment_run_item_payees").select("id,run_item_id,payee_name,payee_kind,method,amount_cents").eq("org_id", context.orgId).in("run_item_id", itemIds).overrideTypes<PaymentRunPayeeReviewRow[], { merge: false }>() : Promise.resolve({ data: [] }),
    billIds.length > 0 ? supabase.from("vendor_bills").select("id,bill_number,company_id").eq("org_id", context.orgId).in("id", billIds).overrideTypes<PaymentRunBillReviewRow[], { merge: false }>() : Promise.resolve({ data: [] }),
    projectIds.length > 0 ? supabase.from("projects").select("id,name").eq("org_id", context.orgId).in("id", projectIds).overrideTypes<PaymentRunNameRow[], { merge: false }>() : Promise.resolve({ data: [] }),
  ])
  const companyIds = [...new Set((billRows ?? []).map((bill) => bill.company_id).filter((value): value is string => Boolean(value)))]
  const { data: companyRows } = companyIds.length > 0
    ? await supabase.from("companies").select("id,name").eq("org_id", context.orgId).in("id", companyIds).overrideTypes<PaymentRunNameRow[], { merge: false }>()
    : { data: [] }
  const billById = new Map((billRows ?? []).map((bill) => [bill.id, bill]))
  const projectNameById = new Map((projectRows ?? []).map((project) => [project.id, project.name]))
  const companyNameById = new Map((companyRows ?? []).map((company) => [company.id, company.name]))
  const payeesByItemId = new Map<string, Array<{ id: string; name: string; kind: string; method: string; amountCents: number }>>()
  for (const payee of payeeRows ?? []) {
    const rows = payeesByItemId.get(payee.run_item_id) ?? []
    rows.push({ id: payee.id, name: payee.payee_name, kind: payee.payee_kind, method: payee.method, amountCents: Number(payee.amount_cents) })
    payeesByItemId.set(payee.run_item_id, rows)
  }
  const approvalsByRunId = new Map<string, PaymentRunListRow["approvals"]>()
  for (const approval of approvalRows ?? []) {
    const rows = approvalsByRunId.get(approval.run_id) ?? []
    rows.push({
      id: approval.id,
      approver_id: approval.approver_id,
      decision: approval.decision,
      created_at: approval.created_at,
    })
    approvalsByRunId.set(approval.run_id, rows)
  }
  const listItemsByRunId = new Map<string, PaymentRunListRow["items"]>()
  for (const item of itemRows) {
    const bill = billById.get(item.bill_id)
    const releasable = item.hold_snapshot && typeof item.hold_snapshot === "object" && !Array.isArray(item.hold_snapshot)
      ? Reflect.get(item.hold_snapshot, "releasable") === true
      : false
    const waiverStatus = item.waiver_snapshot && typeof item.waiver_snapshot === "object" && !Array.isArray(item.waiver_snapshot)
      ? Reflect.get(item.waiver_snapshot, "lien_waiver_status")
      : null
    const rows = listItemsByRunId.get(item.run_id) ?? []
    rows.push({
      id: item.id,
      billNumber: bill?.bill_number ?? "Vendor bill",
      vendorName: bill?.company_id ? companyNameById.get(bill.company_id) ?? "Vendor" : "Vendor",
      projectName: item.project_id ? projectNameById.get(item.project_id) ?? "Project" : "Project",
      vendorAmountCents: Number(item.vendor_amount_cents),
      feeCents: Number(item.processor_fee_cents) + Number(item.platform_fee_cents),
      releasableAtSubmission: releasable,
      waiverStatus: typeof waiverStatus === "string" ? waiverStatus : null,
      payees: payeesByItemId.get(item.id) ?? [],
    })
    listItemsByRunId.set(item.run_id, rows)
  }
  // A run is approvable by this viewer when they are designated (or the org named
  // nobody and they hold the permission), they did not prepare it, and it fits
  // under their personal approval ceiling.
  const viewerLimitCents = routing.approvers.find((approver) => approver.userId === context.userId)?.approvalLimitCents ?? null
  const viewerCanApprove = (requestedBy: string, totalDebitCents: number) =>
    routing.viewerMayApprove &&
    requestedBy !== context.userId &&
    (viewerLimitCents == null || totalDebitCents <= viewerLimitCents)
  return (data ?? []).map((row) => ({
    id: row.id,
    status: row.status,
    currency: row.currency,
    payment_count: Number(row.payment_count),
    vendor_amount_cents: Number(row.vendor_amount_cents),
    processor_fee_cents: Number(row.processor_fee_cents),
    platform_fee_cents: Number(row.platform_fee_cents),
    total_debit_cents: Number(row.total_debit_cents),
    approval_mode_snapshot: row.approval_mode_snapshot,
    required_approvals: Number(row.required_approvals),
    content_hash: row.content_hash ?? null,
    requested_by: row.requested_by,
    requested_at: row.requested_at ?? null,
    approved_at: row.approved_at ?? null,
    processing_started_at: row.processing_started_at ?? null,
    completed_at: row.completed_at ?? null,
    created_at: row.created_at,
    details_truncated: detailsTruncated,
    can_cancel: row.requested_by === context.userId && ["draft", "pending_approval", "approved"].includes(row.status),
    can_approve: viewerCanApprove(row.requested_by, Number(row.total_debit_cents)),
    approvals: approvalsByRunId.get(row.id) ?? [],
    items: listItemsByRunId.get(row.id) ?? [],
  }))
}

export interface PaymentRunSetupData {
  fundingSources: Array<{ id: string; label: string; isDefault: boolean }>
  eligibleBills: Array<{
    id: string
    billNumber: string
    vendorName: string
    projectName: string
    outstandingCents: number
    recipientAccountId: string
  }>
  /** Who a submitted run routes to, so the preparer can be told before submitting. */
  routing: PaymentApprovalRouting
}

export async function getPaymentRunSetupData(orgId?: string): Promise<PaymentRunSetupData> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const [routing, { data: fundingSources, error: fundingError }, { data: bills, error: billsError }] = await Promise.all([
    getPaymentApprovalRouting(context.orgId),
    supabase.from("org_funding_sources")
      .select("id,bank_name,last4,is_default,status,usable_after")
      .eq("org_id", context.orgId)
      .eq("status", "active")
      .order("is_default", { ascending: false })
      .limit(20),
    supabase.from("vendor_bills")
      .select("id,bill_number,total_cents,paid_cents,retainage_cents,status,company_id,project_id")
      .eq("org_id", context.orgId)
      .in("status", ["approved", "partial"])
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(200),
  ])
  if (fundingError) throw new Error(`Unable to load payment funding sources: ${fundingError.message}`)
  if (billsError) throw new Error(`Unable to load eligible vendor bills: ${billsError.message}`)

  const companyIds = [...new Set((bills ?? []).map((bill) => bill.company_id).filter((value): value is string => Boolean(value)))]
  const projectIds = [...new Set((bills ?? []).map((bill) => bill.project_id).filter((value): value is string => Boolean(value)))]
  const [{ data: relationships, error: relationshipError }, { data: companies, error: companyError }, { data: projects, error: projectError }] = await Promise.all([
    companyIds.length > 0
    ? supabase.from("vendor_payment_relationships")
      .select("company_id,status,recipient_account_id")
      .eq("org_id", context.orgId)
      .in("company_id", companyIds)
      .eq("status", "active")
    : Promise.resolve({ data: [], error: null }),
    companyIds.length > 0
      ? supabase.from("companies").select("id,name").eq("org_id", context.orgId).in("id", companyIds)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length > 0
      ? supabase.from("projects").select("id,name").eq("org_id", context.orgId).in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (relationshipError) throw new Error(`Unable to load vendor payment relationships: ${relationshipError.message}`)
  if (companyError) throw new Error(`Unable to load vendor names: ${companyError.message}`)
  if (projectError) throw new Error(`Unable to load project names: ${projectError.message}`)
  const recipientIds = [...new Set((relationships ?? []).map((relationship) => relationship.recipient_account_id).filter((value): value is string => Boolean(value)))]
  const { data: recipients, error: recipientError } = recipientIds.length > 0
    ? await supabase.from("payment_recipient_accounts").select("id,status,payouts_enabled,destination_locked_until").in("id", recipientIds)
    : { data: [], error: null }
  if (recipientError) throw new Error(`Unable to load vendor recipients: ${recipientError.message}`)
  const relationshipByCompany = new Map((relationships ?? []).map((relationship) => [relationship.company_id, relationship]))
  const recipientById = new Map((recipients ?? []).map((recipient) => [recipient.id, recipient]))
  const companyById = new Map((companies ?? []).map((company) => [company.id, company.name]))
  const projectById = new Map((projects ?? []).map((project) => [project.id, project.name]))
  const now = new Date()

  return {
    fundingSources: (fundingSources ?? [])
      .filter((source) => !source.usable_after || new Date(source.usable_after) <= now)
      .map((source) => ({
        id: source.id,
        label: `${source.bank_name ?? "Bank account"}${source.last4 ? ` •••• ${source.last4}` : ""}`,
        isDefault: Boolean(source.is_default),
      })),
    eligibleBills: (bills ?? []).flatMap((bill) => {
      if (!bill.company_id) return []
      const relationship = relationshipByCompany.get(bill.company_id)
      const recipient = relationship?.recipient_account_id ? recipientById.get(relationship.recipient_account_id) : null
      if (!recipient || recipient.status !== "ready" || !recipient.payouts_enabled) return []
      if (recipient.destination_locked_until && new Date(recipient.destination_locked_until) > now) return []
      const outstandingCents = payableOutstandingCents({
        total_cents: Number(bill.total_cents ?? 0),
        paid_cents: Number(bill.paid_cents ?? 0),
        retainage_cents: Number(bill.retainage_cents ?? 0),
      })
      if (outstandingCents <= 0) return []
      return [{
        id: bill.id,
        billNumber: bill.bill_number ?? "Unnumbered bill",
        vendorName: companyById.get(bill.company_id) ?? "Vendor",
        projectName: bill.project_id ? projectById.get(bill.project_id) ?? "Project" : "Project",
        outstandingCents,
        recipientAccountId: recipient.id,
      }]
    }),
    routing,
  }
}
