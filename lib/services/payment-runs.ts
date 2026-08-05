import "server-only"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { calculateEarlyPayDiscount, readEarlyPayTerms } from "@/lib/payments/early-pay-discount"
import { quoteApDisbursementFee, type ApFeePolicy } from "@/lib/payments/fee-engine"
import {
  assertDisbursementTransition,
  createPaymentRunContentHash,
  requiredApprovalCount,
  type PaymentApprovalMode,
} from "@/lib/payments/payment-domain"
import type { ProviderSettlementWindow } from "@/lib/payments/settlement-estimate"
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { normalizeProductTier } from "@/lib/product-tier"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext, runWithServiceOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { isFeatureEnabledForOrg } from "@/lib/services/feature-flags"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import {
  assertUserMayApproveRun,
  getPaymentApprovalRouting,
  type PaymentApprovalRouting,
} from "@/lib/services/payment-approvers"
import { assertBillReleasable } from "@/lib/services/payment-holds"
import {
  postApFeeAccrualLedger,
  postApFeeChargeSubmittedLedger,
  postDisbursementSubmittedLedger,
} from "@/lib/services/payment-ledger"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { requireRecentPaymentStepUp } from "@/lib/services/payment-step-up"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  createPaymentRunSchema,
  decidePaymentRunSchema,
  submitPaymentRunSchema,
  type CreatePaymentRunInput,
  type DecidePaymentRunInput,
  type SubmitPaymentRunInput,
} from "@/lib/validation/fintech-payments"
import { z } from "zod"

const EXECUTION_FLAG = "fintech_ap_payments"
const PAYMENT_RUN_LIST_LIMIT = 100
const PAYMENT_RUN_ITEM_LIST_LIMIT = 1_000
/** One cron tick's worth of scheduled releases; the rest wait for the next sweep. */
const SCHEDULED_RELEASE_SWEEP_LIMIT = 100

/** Outbox job type carrying one approved run's scheduled release. */
const RELEASE_JOB_TYPE = "release_payment_run"
/**
 * Long enough that a slow provider round-trip is never mistaken for a dead
 * worker, short enough that a genuinely dead one is retried the same morning.
 */
const RELEASE_LEASE_SECONDS = 900
const RELEASE_MAX_ATTEMPTS = 3
/**
 * The UTC time of day a scheduled run is released on its business date.
 *
 * `scheduled_for` is a date, so something has to decide the hour. This preserves
 * the release time the daily cron produced before releases became queue-driven,
 * rather than letting it drift to whenever a five-minute tick first sees the
 * date roll over in UTC (which would be the previous evening in every US zone).
 *
 * It is fixed UTC, so the local release time shifts by an hour across DST. That
 * is deliberate: a fixed wall-clock time per org needs an org timezone, which is
 * a product decision, not a scheduling one.
 */
const SCHEDULED_RELEASE_UTC_HOUR = 13
const SCHEDULED_RELEASE_UTC_MINUTE = 35

function scheduledReleaseInstant(scheduledFor: string) {
  const hour = String(SCHEDULED_RELEASE_UTC_HOUR).padStart(2, "0")
  const minute = String(SCHEDULED_RELEASE_UTC_MINUTE).padStart(2, "0")
  return `${scheduledFor}T${hour}:${minute}:00.000Z`
}

interface ClaimedReleaseJob {
  job_id: number
  org_id: string
  job_type: string
  payload: Record<string, unknown> | null
  retry_count: number
}

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
  scheduled_for: string | null
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

async function requirePaymentProjectAccess(context: Awaited<ReturnType<typeof requireOrgContext>>, projectIds: Array<string | null | undefined>) {
  for (const projectId of new Set(projectIds.filter((id): id is string => Boolean(id)))) {
    await requireAuthorization({ permission: "payment.release", userId: context.userId, orgId: context.orgId, projectId, supabase: context.supabase, resourceType: "project", resourceId: projectId, logDecision: true })
  }
}

async function loadApFeePolicy(orgId: string): Promise<ApFeePolicy> {
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()
  const feePolicyColumns = "pass_through_processor_fees,processor_fee_bps,processor_fee_fixed_cents,processor_fee_cap_cents,ap_platform_fee_flat_cents,ap_platform_fee_bps,ap_platform_fee_cap_cents"
  const [{ data: orgPolicy }, { data: platformPolicy }] = await Promise.all([
    supabase.from("payment_fee_policies").select(feePolicyColumns).eq("org_id", orgId).lte("effective_from", now).is("effective_to", null).maybeSingle(),
    supabase.from("payment_fee_policies").select(feePolicyColumns).is("org_id", null).lte("effective_from", now).is("effective_to", null).maybeSingle(),
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
    platformFeeCapCents: policy.ap_platform_fee_cap_cents == null ? null : Number(policy.ap_platform_fee_cap_cents),
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
    // The release date is part of what gets approved. Moving it after approval has
    // to invalidate those approvals exactly like moving an amount would.
    scheduled_for: run.scheduled_for ?? null,
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
  const requestFingerprint = createPaymentRunContentHash(parsed)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const { data: existingRun } = await supabase.from("payment_runs")
    .select("id,status,vendor_amount_cents,processor_fee_cents,platform_fee_cents,total_debit_cents,required_approvals,control_snapshot")
    .eq("org_id", context.orgId)
    .eq("idempotency_key", parsed.idempotency_key)
    .maybeSingle()
  if (existingRun) {
    const existingFingerprint = existingRun.control_snapshot && typeof existingRun.control_snapshot === "object" && !Array.isArray(existingRun.control_snapshot)
      ? Reflect.get(existingRun.control_snapshot, "request_fingerprint")
      : null
    if (existingFingerprint && existingFingerprint !== requestFingerprint) throw new Error("Idempotency key was already used for different payment-run contents")
    return {
      id: existingRun.id,
      status: existingRun.status,
      vendorAmountCents: Number(existingRun.vendor_amount_cents),
      processorFeeCents: Number(existingRun.processor_fee_cents),
      platformFeeCents: Number(existingRun.platform_fee_cents),
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
  await requirePaymentProjectAccess(context, bills.map((bill) => bill.project_id))
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
  // The debit is what leaves the bank, which is the vendor amount and nothing
  // else. Fees are collected once per run in their own debit, so they
  // are quoted and stored for display but never added to the money that moves.
  const totalDebitCents = vendorAmountCents
  if (policy.per_run_limit_cents && totalDebitCents > Number(policy.per_run_limit_cents)) throw new Error("Payment run exceeds the organization's per-run limit")

  const approvalMode: PaymentApprovalMode = policy.approval_mode === "sole" ? "sole" : "dual"
  const requiredApprovals = requiredApprovalCount(approvalMode)
  const currency = bills[0]?.currency ?? "usd"
  if (bills.some((bill) => String(bill.currency ?? "usd").toLowerCase() !== String(currency).toLowerCase())) {
    throw new Error("A payment run can only contain bills in one currency")
  }
  const atomicItems = preparedItems.map((prepared) => ({
    project_id: prepared.bill.project_id,
    bill_id: prepared.bill.id,
    relationship_id: prepared.relationship.id,
    bill_balance_snapshot_cents: prepared.outstandingCents,
    // Retainage is accounting evidence owned by the approved bill, never a
    // client-entered payment-run adjustment.
    gross_payment_cents: prepared.input.amount_cents + Number(prepared.bill.retainage_cents ?? 0),
    retainage_held_cents: Number(prepared.bill.retainage_cents ?? 0),
    vendor_amount_cents: prepared.fee.vendorAmountCents,
    processor_fee_cents: prepared.fee.processorFeeCents,
    platform_fee_cents: prepared.fee.platformFeeCents,
    total_debit_cents: prepared.fee.debitAmountCents,
    allocation_snapshot: [],
    hold_snapshot: prepared.evidence?.holdEvaluation ?? {},
    waiver_snapshot: {
      jurisdiction: policy.waiver_jurisdiction,
      required: Boolean(policy.require_waiver_snapshot),
      lien_waiver_status: prepared.bill.lien_waiver_status ?? null,
      evidence: prepared.evidence?.waiverEvidence ?? null,
      construction: prepared.evidence?.constructionEvidence ?? null,
      captured_at: prepared.evidence?.capturedAt,
    },
    payees: prepared.input.payees.map((payee) => ({
      payee_kind: payee.payee_kind,
      method: payee.method,
      // Ignore any client-provided destination for the primary vendor.
      recipient_account_id: payee.payee_kind === "primary_vendor" ? prepared.recipient.id : payee.recipient_account_id,
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
    p_control_snapshot: { policy, fee_policy: feePolicy, funding_source_status: funding.status, request_fingerprint: requestFingerprint },
    p_idempotency_key: parsed.idempotency_key,
    p_items: atomicItems,
  })
  const runId = created && typeof created === "object" && !Array.isArray(created) ? Reflect.get(created, "id") : null
  if (createError || typeof runId !== "string") throw new Error(`Unable to create payment run: ${createError?.message ?? "Atomic write returned no run"}`)
  const duplicate = Reflect.get(created, "duplicate") === true
  if (duplicate) {
    const { data: settled } = await supabase.from("payment_runs")
      .select("status,vendor_amount_cents,processor_fee_cents,platform_fee_cents,total_debit_cents,required_approvals,control_snapshot")
      .eq("org_id", context.orgId)
      .eq("id", runId)
      .maybeSingle()
    const settledFingerprint = settled?.control_snapshot && typeof settled.control_snapshot === "object" && !Array.isArray(settled.control_snapshot)
      ? Reflect.get(settled.control_snapshot, "request_fingerprint")
      : null
    if (settledFingerprint && settledFingerprint !== requestFingerprint) throw new Error("Idempotency key was concurrently used for different payment-run contents")
    return {
      id: runId,
      status: settled?.status ?? "draft",
      vendorAmountCents: Number(settled?.vendor_amount_cents ?? vendorAmountCents),
      processorFeeCents: Number(settled?.processor_fee_cents ?? processorFeeCents),
      platformFeeCents: Number(settled?.platform_fee_cents ?? platformFeeCents),
      totalDebitCents: Number(settled?.total_debit_cents ?? totalDebitCents),
      requiredApprovals: Number(settled?.required_approvals ?? requiredApprovals),
    }
  }

  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_created", entityType: "payment_run", entityId: runId, payload: { payment_count: parsed.items.length, total_debit_cents: totalDebitCents } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "payment_run", entityId: runId, after: { payment_count: parsed.items.length, total_debit_cents: totalDebitCents, approval_mode: approvalMode } }),
  ])
  return { id: runId, status: "draft", vendorAmountCents, processorFeeCents, platformFeeCents, totalDebitCents, requiredApprovals }
}

async function loadRunHashMaterial(runId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: run, error } = await supabase.from("payment_runs").select("*").eq("org_id", orgId).eq("id", runId).maybeSingle()
  if (error || !run) throw new Error("Payment run was not found")
  const { data: items, error: itemsError } = await supabase.from("payment_run_items").select("*,payees:payment_run_item_payees(id,payee_kind,method,recipient_account_id,payee_name,amount_cents)").eq("org_id", orgId).eq("run_id", runId).order("created_at")
  if (itemsError) throw new Error(`Unable to load payment run items: ${itemsError.message}`)
  return { run, items: items ?? [], contentHash: createPaymentRunContentHash(paymentRunHashValue(run, items ?? [])) }
}

export async function submitPaymentRun(input: SubmitPaymentRunInput, orgId?: string) {
  const parsed = submitPaymentRunSchema.parse(input)
  const parsedRunId = parsed.run_id
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const material = await loadRunHashMaterial(parsedRunId, context.orgId)
  await requirePaymentProjectAccess(context, material.items.map((item) => item.project_id))
  if (material.run.requested_by !== context.userId) throw new Error("Only the payment-run preparer can submit it")
  if (material.run.status !== "draft") throw new Error("Only a draft payment run can be submitted")
  await Promise.all(material.items.map((item) => assertBillReleasable(item.bill_id, context.orgId, { excludePaymentRunId: parsedRunId })))
  await assertRunRiskAllowed(material.run, material.items, context.orgId)
  // The hash has to cover the date the approver is about to see, not the null the
  // draft still carries, so it is computed over the run as it will be written.
  const contentHash = createPaymentRunContentHash(
    paymentRunHashValue({ ...material.run, scheduled_for: parsed.scheduled_for }, material.items),
  )
  const now = new Date().toISOString()
  const { data, error } = await supabase.rpc("submit_payment_run_atomic", {
    p_org_id: context.orgId,
    p_run_id: parsedRunId,
    p_requester_id: context.userId,
    p_content_hash: contentHash,
    p_requested_at: now,
    p_scheduled_for: parsed.scheduled_for,
  })
  if (error || !data) throw new Error(error?.message ?? "Payment run changed before it could be submitted")
  // Notification copy has to say what is being approved, so the event carries the
  // bill context rather than making every recipient open the run to find out.
  const summary = await summarizeRunForNotification(parsedRunId, context.orgId, material.items)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_submitted", entityType: "payment_run", entityId: parsedRunId, payload: { content_hash: contentHash, total_debit_cents: Number(material.run.total_debit_cents), required_approvals: Number(material.run.required_approvals), scheduled_for: parsed.scheduled_for, ...summary } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "payment_run", entityId: parsedRunId, before: { status: "draft" }, after: { status: "pending_approval", content_hash: contentHash, scheduled_for: parsed.scheduled_for } }),
  ])
  return { id: parsedRunId, status: "pending_approval", content_hash: contentHash, scheduled_for: parsed.scheduled_for }
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
  // Retract any queued release. Leaving it would fire against a canceled run,
  // fail the approval check, and burn three retries into a dead letter that
  // looks like an incident rather than a cancellation.
  await supabase.from("outbox")
    .update({ status: "completed", last_error: "Payment run was canceled before release" })
    .eq("org_id", context.orgId)
    .eq("job_type", RELEASE_JOB_TYPE)
    .eq("status", "pending")
    .contains("payload", { run_id: parsedRunId })
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_canceled", entityType: "payment_run", entityId: parsedRunId, payload: { prior_status: existing.status } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "payment_run", entityId: parsedRunId, before: { status: existing.status }, after: { status: "canceled" } }),
  ])
  return { id: parsedRunId, status: "canceled" }
}

export async function decidePaymentRun(
  input: DecidePaymentRunInput,
  orgId?: string,
  options: {
    /**
     * How to prove recent step-up. Mobile has no cookie session and reads the
     * same facts from its bearer token, so the resolver is injectable — but it
     * is never optional. Defaulting here rather than hoisting the check to
     * callers means no future call site can forget it.
     */
    resolveStepUp?: () => Promise<string>
  } = {},
) {
  const parsed = decidePaymentRunSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payments.approve_run", context)
  const stepUpVerifiedAt = await (options.resolveStepUp ?? requireRecentPaymentStepUp)()
  const supabase = createServiceSupabaseClient()
  const material = await loadRunHashMaterial(parsed.run_id, context.orgId)
  if (material.contentHash !== parsed.content_hash || material.run.content_hash !== parsed.content_hash) throw new Error("Payment run changed after review; reload it before deciding")
  // Permission says you *can* approve; the roster says the org designated you to,
  // and for which work — a division-scoped approver cannot release a run that
  // reaches outside their division.
  const runProjectIds = [...new Set(material.items.map((item) => item.project_id).filter((value): value is string => typeof value === "string"))]
  const { data: runProjects } = runProjectIds.length > 0
    ? await supabase.from("projects").select("division_id").eq("org_id", context.orgId).in("id", runProjectIds)
    : { data: [] }
  const runDivisionIds = [...new Set((runProjects ?? []).map((project) => project.division_id).filter((value): value is string => typeof value === "string"))]
  await assertUserMayApproveRun({
    userId: context.userId,
    orgId: context.orgId,
    totalDebitCents: Number(material.run.total_debit_cents),
    divisionIds: runDivisionIds,
  })
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
  // The approval that reaches quorum is what owes a release. Enqueue it here, in
  // the same request that made it due, so the release survives a cron that never
  // fires rather than depending on something noticing a column later.
  if (decisionStatus === "approved" && typeof material.run.scheduled_for === "string") {
    await enqueueScheduledRelease({
      orgId: context.orgId,
      runId: parsed.run_id,
      revision: Number(material.run.revision ?? 0),
      scheduledFor: material.run.scheduled_for,
    })
  }
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

/** Today in UTC as `YYYY-MM-DD` — the same reckoning the database's `current_date` uses. */
function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function isScheduledForLater(scheduledFor: unknown): boolean {
  return typeof scheduledFor === "string" && scheduledFor > todayIso()
}

/**
 * Enqueue the durable release for a run that just reached approval.
 *
 * The intent to release on a date used to exist only as a column something had
 * to notice, so a missed cron request meant a payment that nothing anywhere knew
 * was owed. Materializing it as an outbox row makes the release a work item with
 * a lease, a retry count and a dead-letter state.
 *
 * Only scheduled runs are enqueued: an approved run with no date still waits for
 * a human to press Release, which is the existing contract.
 */
async function enqueueScheduledRelease(input: { orgId: string; runId: string; revision: number; scheduledFor: string }) {
  return enqueueOutboxJob({
    orgId: input.orgId,
    jobType: RELEASE_JOB_TYPE,
    payload: { run_id: input.runId, revision: input.revision },
    runAt: scheduledReleaseInstant(input.scheduledFor),
    // Revision is part of the key because invalidated approvals return the run to
    // draft; the next approval is a genuinely different release to schedule.
    dedupeByPayloadKeys: ["run_id", "revision"],
  })
}

/**
 * Self-healing sweep for approved runs past their date with nothing queued.
 *
 * Covers runs approved before releases became queue-driven, and any enqueue that
 * failed after the approval committed. Returning the ids lets the caller alert:
 * a non-empty result means the durable path did not hold and someone should know
 * why, even though the sweep already repaired it.
 */
async function backfillMissingReleaseJobs(supabase: ReturnType<typeof createServiceSupabaseClient>): Promise<string[]> {
  const { data: due, error } = await supabase
    .from("payment_runs")
    .select("id,org_id,revision")
    .eq("status", "approved")
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", todayIso())
    .order("scheduled_for", { ascending: true })
    .limit(SCHEDULED_RELEASE_SWEEP_LIMIT)
  if (error) throw new Error(`Unable to load scheduled payment runs: ${error.message}`)
  if ((due ?? []).length === 0) return []

  const { data: queued } = await supabase
    .from("outbox")
    .select("payload")
    .eq("job_type", RELEASE_JOB_TYPE)
    .in("status", ["pending", "processing"])
    .limit(1_000)
  const queuedRunIds = new Set(
    (queued ?? [])
      .map((row) => (row.payload && typeof row.payload === "object" ? Reflect.get(row.payload, "run_id") : null))
      .filter((value): value is string => typeof value === "string"),
  )

  const orphaned: string[] = []
  for (const run of due ?? []) {
    if (queuedRunIds.has(run.id)) continue
    // Due already, so it runs on the next tick rather than at its original hour.
    const result = await enqueueOutboxJob({
      orgId: run.org_id,
      jobType: RELEASE_JOB_TYPE,
      payload: { run_id: run.id, revision: Number(run.revision ?? 0) },
      runAt: new Date().toISOString(),
      dedupeByPayloadKeys: ["run_id", "revision"],
    })
    if (result.enqueued) orphaned.push(run.id)
  }
  return orphaned
}

/**
 * Drain the scheduled-release queue.
 *
 * Runs from the five-minute payment-release tick. It deliberately re-enters
 * `executePaymentRun`, which re-checks the execution kill switches, the per-org
 * flag, bill releasability, the content hash, and risk controls — a scheduled
 * release is not a privileged path, it is the same release with no human present.
 *
 * One failing run must not strand the rest of the queue, so failures are recorded
 * on their own job row rather than thrown; `executePaymentRun` has already
 * recorded the failure on the run and emitted its own event by the time we see
 * the error.
 */
export async function releaseScheduledPaymentRuns(): Promise<{
  attempted: number
  released: string[]
  failed: Array<{ runId: string; error: string }>
  requeued: number
  exhausted: number
  /** Approved, past-due runs the durable path missed. Non-empty means alert. */
  orphaned: string[]
}> {
  if (process.env.FINTECH_PAYMENTS_EXECUTION_ENABLED !== "true") {
    return { attempted: 0, released: [], failed: [], requeued: 0, exhausted: 0, orphaned: [] }
  }
  const supabase = createServiceSupabaseClient()

  // Return leases abandoned by a timed-out worker before claiming anything, so a
  // release stuck mid-flight is retried this tick instead of stranded forever.
  const { data: reaped, error: reapError } = await supabase.rpc("reap_stale_outbox_jobs", {
    p_lease_seconds: RELEASE_LEASE_SECONDS,
    p_max_attempts: RELEASE_MAX_ATTEMPTS,
    p_job_types: [RELEASE_JOB_TYPE],
  })
  if (reapError) throw new Error(`Unable to reap stale payment releases: ${reapError.message}`)
  const reapRow = (Array.isArray(reaped) ? reaped[0] : reaped) as { requeued?: number; exhausted?: number } | null

  const orphaned = await backfillMissingReleaseJobs(supabase)

  const { data: claimed, error } = await supabase.rpc("claim_jobs", {
    job_types: [RELEASE_JOB_TYPE],
    limit_value: SCHEDULED_RELEASE_SWEEP_LIMIT,
  })
  if (error) throw new Error(`Unable to claim scheduled payment releases: ${error.message}`)
  const jobs = (claimed ?? []) as ClaimedReleaseJob[]

  const released: string[] = []
  const failed: Array<{ runId: string; error: string }> = []
  for (const job of jobs) {
    const runId = job.payload && typeof job.payload === "object" ? Reflect.get(job.payload, "run_id") : null
    if (typeof runId !== "string") {
      await supabase.from("outbox").update({ status: "failed", last_error: "Release job is missing run_id" }).eq("id", job.job_id)
      continue
    }
    try {
      // The preparer is the human who authorized this release when they picked the
      // date, so the run executes as them. Their `payment.release` permission is
      // re-checked inside — losing it between scheduling and the due date stops the
      // payment, which is the behaviour we want.
      const { data: run } = await supabase.from("payment_runs").select("requested_by").eq("org_id", job.org_id).eq("id", runId).maybeSingle()
      if (!run?.requested_by) throw new Error("Scheduled payment run no longer exists")
      const { data: org } = await supabase.from("orgs").select("product_tier").eq("id", job.org_id).maybeSingle()
      await runWithServiceOrgContext(
        {
          supabase,
          orgId: job.org_id,
          userId: run.requested_by,
          productTier: normalizeProductTier(org?.product_tier),
        },
        () => executePaymentRun(runId, job.org_id),
      )
      await supabase.from("outbox").update({ status: "completed" }).eq("id", job.job_id)
      released.push(runId)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Scheduled release failed"
      const nextRetry = Number(job.retry_count ?? 0) + 1
      const shouldRetry = nextRetry < RELEASE_MAX_ATTEMPTS
      await supabase.from("outbox").update({
        status: shouldRetry ? "pending" : "failed",
        retry_count: nextRetry,
        last_error: message.slice(0, 2_000),
        ...(shouldRetry ? { run_at: new Date(Date.now() + Math.pow(3, nextRetry) * 60_000).toISOString() } : {}),
      }).eq("id", job.job_id)
      failed.push({ runId, error: message })
    }
  }
  return {
    attempted: jobs.length,
    released,
    failed,
    requeued: Number(reapRow?.requeued ?? 0),
    exhausted: Number(reapRow?.exhausted ?? 0),
    orphaned,
  }
}

/**
 * Repairs submissions whose provider call had no trustworthy response. Reusing
 * executePaymentRun is safe because both the disbursement row and provider call
 * use deterministic idempotency keys.
 */
export async function recoverAmbiguousPaymentSubmissions(): Promise<{
  attempted: number
  recovered: string[]
  failed: Array<{ runId: string; error: string }>
}> {
  if (process.env.FINTECH_PAYMENTS_EXECUTION_ENABLED !== "true") return { attempted: 0, recovered: [], failed: [] }
  const supabase = createServiceSupabaseClient()
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const { data, error } = await supabase.from("disbursements")
    .select("run_id,org_id,run:payment_runs(requested_by)")
    .eq("status", "created").not("submission_attempted_at", "is", null)
    .lte("submission_attempted_at", cutoff).order("submission_attempted_at", { ascending: true }).limit(50)
  if (error) throw new Error(`Unable to load ambiguous payment submissions: ${error.message}`)
  const candidates = Array.from(new Map((data ?? []).map((row) => [`${row.org_id}:${row.run_id}`, row])).values())
  const recovered: string[] = []
  const failed: Array<{ runId: string; error: string }> = []
  for (const row of candidates) {
    const run = Array.isArray(row.run) ? row.run[0] : row.run
    if (!run?.requested_by) continue
    try {
      const { data: org } = await supabase.from("orgs").select("product_tier").eq("id", row.org_id).maybeSingle()
      await runWithServiceOrgContext({ supabase, orgId: row.org_id, userId: run.requested_by, productTier: normalizeProductTier(org?.product_tier) }, () => executePaymentRun(row.run_id, row.org_id))
      recovered.push(row.run_id)
    } catch (cause) {
      failed.push({ runId: row.run_id, error: cause instanceof Error ? cause.message : "Payment recovery failed" })
    }
  }
  return { attempted: candidates.length, recovered, failed }
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
  const [{ data: dailyRows }, { count: recentFailureCount }, { data: relationships }, { data: livePolicy }] = await Promise.all([
    supabase.from("disbursements").select("amount_cents,processor_fee_cents,platform_fee_cents").eq("org_id", orgId).gte("created_at", dayStart.toISOString()).not("status", "in", "(failed,canceled)"),
    supabase.from("disbursements").select("id", { count: "exact", head: true }).eq("org_id", orgId).gte("created_at", failureWindowStart).in("status", ["failed", "returned"]),
    relationshipIds.length > 0
      ? supabase.from("vendor_payment_relationships").select("id,accepted_at,created_at,per_payment_limit_cents").eq("org_id", orgId).in("id", relationshipIds)
      : Promise.resolve({ data: [] }),
    // Read live, not from the run's frozen control snapshot: these are fraud
    // controls, and tightening one has to bind runs that were built before it.
    supabase.from("payment_rail_policies").select("new_vendor_hold_hours,max_inflight_cents").eq("org_id", orgId).maybeSingle(),
  ])
  // Fees ride their own debit, so the daily limit measures the vendor money that
  // actually left the bank rather than a total that includes an accrual.
  const dailyCents = (dailyRows ?? []).reduce((sum, row) => sum + Number(row.amount_cents), 0) + Number(run.total_debit_cents)
  if (dailyLimitCents && dailyCents > Number(dailyLimitCents)) signals.push({ code: "daily_limit_exceeded", severity: "block", daily_cents: dailyCents })
  if ((recentFailureCount ?? 0) >= 3) signals.push({ code: "repeated_payment_failures", severity: "block", count: recentFailureCount })
  const duplicateBillIds = items.map((item) => item.bill_id)
  if (new Set(duplicateBillIds).size !== duplicateBillIds.length) signals.push({ code: "duplicate_bill", severity: "block" })
  const duplicateRelationshipAmounts = items.map((item) => `${String(item.relationship_id)}:${Number(item.vendor_amount_cents)}`)
  if (new Set(duplicateRelationshipAmounts).size !== duplicateRelationshipAmounts.length) signals.push({ code: "repeated_vendor_amount", severity: "observe" })
  // "Change the payee, pay immediately" is the classic vector. Holding the first
  // payment to a newly claimed relationship gives the out-of-band notification
  // time to reach someone who knows the vendor's bank did not change. This was
  // an observe-only signal on a hardcoded 72 hours; it blocks now, and the
  // window is the org's to set.
  const newVendorHoldHours = Number(livePolicy?.new_vendor_hold_hours ?? 72)
  if (newVendorHoldHours > 0) {
    const newRelationshipCutoff = Date.now() - newVendorHoldHours * 60 * 60 * 1000
    const fresh = (relationships ?? []).filter(
      (relationship) => new Date(relationship.accepted_at ?? relationship.created_at).getTime() > newRelationshipCutoff,
    )
    if (fresh.length > 0) {
      signals.push({
        code: "recently_claimed_vendor_relationship",
        severity: "block",
        hold_hours: newVendorHoldHours,
        relationship_ids: fresh.map((relationship) => relationship.id),
      })
    }
  }

  // A per-vendor ceiling the org-wide limit cannot express: the run limit is
  // sized for a normal batch and does nothing to stop one compromised
  // destination taking all of it in a single payment.
  for (const item of items) {
    const relationship = (relationships ?? []).find((row) => row.id === item.relationship_id)
    const vendorLimit = relationship?.per_payment_limit_cents
    if (vendorLimit && Number(item.vendor_amount_cents) > Number(vendorLimit)) {
      signals.push({ code: "vendor_limit_exceeded", severity: "block", relationship_id: relationship.id, amount_cents: Number(item.vendor_amount_cents) })
    }
  }

  // In-flight exposure: debits submitted but not yet cleared. Per-payment and
  // daily limits both reset; this accumulates, which is what actually bounds the
  // blast radius of a compromised session over several days.
  const maxInflightCents = livePolicy?.max_inflight_cents == null ? null : Number(livePolicy.max_inflight_cents)
  if (maxInflightCents) {
    const { data: inflight } = await supabase
      .from("disbursements")
      .select("amount_cents")
      .eq("org_id", orgId)
      .in("status", ["created", "submitted", "debit_pending", "funds_available"])
      .limit(5_000)
    const inflightCents = (inflight ?? []).reduce((sum, row) => sum + Number(row.amount_cents), 0) + Number(run.total_debit_cents)
    if (inflightCents > maxInflightCents) {
      signals.push({ code: "inflight_exposure_exceeded", severity: "block", inflight_cents: inflightCents, limit_cents: maxInflightCents })
    }
  }

  const blocked = signals.some((signal) => signal.severity === "block")
  // A human with the permission can clear a block, and that decision is its own
  // immutable row. Without this a `repeated_payment_failures` signal stopped an
  // org's entire AP for 24 hours with no way for anyone to look at it and say
  // the payments were fine — which on a Friday means subs wait until Monday.
  const override = blocked ? await findManualRiskOverride(supabase, orgId, String(run.id)) : null
  const decision = blocked && !override ? "block" : "allow"
  const riskScore = blocked ? 100 : signals.length > 0 ? 25 : 0
  const { error } = await supabase.from("payment_risk_reviews").insert({
    org_id: orgId,
    run_id: run.id,
    review_type: "automated",
    decision,
    signals: override ? [...signals, { code: "manual_override_applied", severity: "observe", review_id: override }] : signals,
    risk_score: riskScore,
  })
  if (error) throw new Error(`Unable to record payment risk review: ${error.message}`)
  if (decision !== "allow") {
    const codes = signals.filter((signal) => signal.severity === "block").map((signal) => String(signal.code)).join(", ")
    throw new Error(`Payment run is blocked by automated risk controls (${codes}). A payments reviewer can release it from the risk queue.`)
  }
}

/**
 * A standing manual `allow` for this run, if a reviewer granted one.
 *
 * Bound to the run rather than to a content hash because any material change
 * returns the run to draft and invalidates its approvals — so an override
 * cannot outlive the thing it was granted for.
 */
async function findManualRiskOverride(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  runId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("payment_risk_reviews")
    .select("id")
    .eq("org_id", orgId)
    .eq("run_id", runId)
    .eq("review_type", "manual")
    .eq("decision", "allow")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.id ?? null
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
  await requirePaymentProjectAccess(context, material.items.map((item) => item.project_id))
  if (!["approved", "processing"].includes(material.run.status)) throw new Error("Payment run must be fully approved before execution")
  if (!material.run.content_hash || material.contentHash !== material.run.content_hash) throw new Error("Payment run changed after approval")
  // The approvers approved a release date along with the money. Paying early is a
  // different run, not an override — the schedule is inside the content hash, so
  // there is no way to move it that keeps the approvals valid.
  if (isScheduledForLater(material.run.scheduled_for)) {
    throw new Error(`This run is scheduled for release on ${String(material.run.scheduled_for)}. Cancel it and build a new run to pay sooner.`)
  }
  if (material.run.status === "approved") {
    await Promise.all(material.items.map((item) => assertBillReleasable(item.bill_id, context.orgId, { excludePaymentRunId: parsedRunId })))
    await assertRunRiskAllowed(material.run, material.items, context.orgId)
  }

  const { data: funding } = await supabase.from("org_funding_sources").select("id,provider,provider_customer_id,provider_payment_method_id,status,usable_after").eq("org_id", context.orgId).eq("id", material.run.funding_source_id).maybeSingle()
  if (!funding || funding.status !== "active" || (funding.usable_after && new Date(funding.usable_after) > new Date())) throw new Error("Payment run funding source is no longer usable")
  const provider = getPaymentRailProvider(funding.provider)
  const now = new Date().toISOString()
  if (material.run.status === "approved") {
    const { data: claim, error: claimError } = await supabase.rpc("claim_payment_run_execution_atomic", {
      p_org_id: context.orgId,
      p_run_id: parsedRunId,
      p_claimed_at: now,
    })
    if (claimError || !claim) throw new Error(claimError?.message ?? "Payment run could not be reserved for execution")
    await supabase.from("payment_run_items").update({ status: "processing" }).eq("org_id", context.orgId).eq("run_id", parsedRunId).eq("status", "approved")
  }

  const results: Array<{ disbursementId: string; status: string }> = []
  for (const item of material.items) {
    const payees = Array.isArray(item.payees) ? item.payees : []
    let allocatedProcessorFeeCents = 0
    let allocatedPlatformFeeCents = 0
    for (const [payeeIndex, payee] of payees.entries()) {
      if (payee.method !== "ach") continue
      const { data: relationship } = await supabase.from("vendor_payment_relationships")
        .select("recipient_account_id,vendor_entity_id,status")
        .eq("org_id", context.orgId).eq("id", item.relationship_id).maybeSingle()
      const trustedRecipientId = payee.payee_kind === "primary_vendor" ? relationship?.recipient_account_id : payee.recipient_account_id
      const { data: recipient } = await supabase.from("payment_recipient_accounts").select("id,vendor_entity_id,provider,provider_account_id,status,payouts_enabled,destination_locked_until").eq("id", trustedRecipientId).maybeSingle()
      if (!relationship || relationship.status !== "active" || recipient?.vendor_entity_id !== relationship.vendor_entity_id) throw new Error(`Payee ${payee.payee_name} is not bound to this vendor relationship`)
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
      let { data: disbursement } = await supabase.from("disbursements").select("id,status,provider_payment_id").eq("org_id", context.orgId).eq("idempotency_key", idempotencyKey).maybeSingle()
      if (!disbursement) {
        const { data: inserted, error: disbursementError } = await supabase.from("disbursements").insert({
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
        }).select("id,status,provider_payment_id").single()
        if (disbursementError || !inserted) throw new Error(`Unable to create disbursement: ${disbursementError?.message}`)
        disbursement = inserted
      }
      let providerRejected = false
      try {
        if (disbursement.status !== "created") {
          await postDisbursementSubmittedLedger({ orgId: context.orgId, disbursementId: disbursement.id, vendorAmountCents: Number(payee.amount_cents), currency: material.run.currency, effectiveAt: now })
          results.push({ disbursementId: disbursement.id, status: disbursement.status })
          continue
        }
        // Record the pending debit before contacting the provider. The entry is
        // idempotent and gives an authoritative failure webhook something to
        // reverse even if it races the HTTP response.
        await postDisbursementSubmittedLedger({ orgId: context.orgId, disbursementId: disbursement.id, vendorAmountCents: Number(payee.amount_cents), currency: material.run.currency, effectiveAt: now })
        const providerResult = await provider.submitDisbursement({
          disbursementId: disbursement.id,
          orgId: context.orgId,
          amountCents: Number(payee.amount_cents),
          currency: material.run.currency,
          providerCustomerId: funding.provider_customer_id,
          providerPaymentMethodId: funding.provider_payment_method_id,
          recipientProviderAccountId: recipient.provider_account_id,
          transferGroup: `payment_run:${parsedRunId}`,
          idempotencyKey,
          metadata: { payment_run_id: parsedRunId, payment_run_item_id: item.id, bill_id: item.bill_id },
        })
        if (providerResult.status === "failed") {
          providerRejected = true
          await supabase.from("disbursements").update({ status: "failed", failure_reason: "Provider rejected payment submission" }).eq("org_id", context.orgId).eq("id", disbursement.id).eq("status", "created")
          await rollUpExecutionFailure({ supabase, orgId: context.orgId, runId: parsedRunId, itemId: item.id, payeeId: payee.id, message: "Provider rejected payment submission" })
          await Promise.all([
            recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_execution_failed", entityType: "payment_run", entityId: parsedRunId, payload: { disbursement_id: disbursement.id, provider_status: providerResult.status } }),
            recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "disbursement", entityId: disbursement.id, before: { status: "created" }, after: { status: "failed", reason: "provider_rejected" } }),
          ])
          throw new Error("Provider rejected payment submission")
        }
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
          currency: material.run.currency,
          effectiveAt: now,
        })
        results.push({ disbursementId: disbursement.id, status: providerResult.status })
      } catch (error) {
        if (providerRejected) throw error
        const message = error instanceof Error ? error.message : "Provider submission failed"
        // A network error cannot tell us whether the provider accepted the debit.
        // Keep the deterministic disbursement resumable; retrying invokes the
        // provider with the exact same idempotency key and repairs local state.
        await supabase.from("disbursements").update({ failure_reason: message, submission_attempted_at: now }).eq("org_id", context.orgId).eq("id", disbursement.id).eq("status", "created")
        await Promise.all([
          recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_submission_needs_recovery", entityType: "disbursement", entityId: disbursement.id, payload: { payment_run_id: parsedRunId, error: message } }),
          recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "disbursement", entityId: disbursement.id, after: { status: "created", recovery_required: true, failure_reason: message } }),
        ])
        throw error
      }
    }
  }
  // Fees are collected once, after the vendor payments are away. Deliberately
  // last: a failure collecting Arc's fee must never stop a subcontractor being
  // paid, and it must never be able to leave the vendor debits half-submitted.
  const feeCharge = await collectRunFees({
    supabase,
    orgId: context.orgId,
    actorId: context.userId,
    run: material.run,
    items: material.items,
    funding,
    provider,
    effectiveAt: now,
  })

  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_run_execution_started", entityType: "payment_run", entityId: parsedRunId, payload: { disbursement_count: results.length, fee_charge_cents: feeCharge?.amountCents ?? 0 } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "payment_run", entityId: parsedRunId, before: { status: "approved" }, after: { status: "processing", disbursement_count: results.length, fee_charge_cents: feeCharge?.amountCents ?? 0 } }),
  ])
  return { runId: parsedRunId, status: "processing", disbursements: results, feeCharge }
}

/**
 * Debit the run's fees once, from the same funding source that paid the vendors.
 *
 * The amounts come off the run's frozen items, so what is collected is exactly
 * what the approver saw and signed for — not a figure recomputed at execution
 * time against whatever pricing happens to be in force now.
 *
 * Failures here are recorded and surfaced, never thrown: the vendor payments
 * have already been submitted and are irreversible. An uncollected fee is a
 * receivable Arc chases; a thrown error at this point would strand a run that
 * has already moved money.
 */
async function collectRunFees(input: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  actorId: string
  run: Record<string, unknown>
  items: Array<Record<string, unknown>>
  funding: { id: string; provider: string; provider_customer_id: string | null; provider_payment_method_id: string | null }
  provider: ReturnType<typeof getPaymentRailProvider>
  effectiveAt: string
}): Promise<{ id: string; amountCents: number; status: string } | null> {
  const runId = String(input.run.id)
  const currency = String(input.run.currency ?? "usd")
  const processorFeeCents = input.items.reduce((sum, item) => sum + Number(item.processor_fee_cents ?? 0), 0)
  const platformFeeCents = input.items.reduce((sum, item) => sum + Number(item.platform_fee_cents ?? 0), 0)
  const amountCents = processorFeeCents + platformFeeCents
  if (amountCents <= 0) return null

  const idempotencyKey = `payment_run_fee:${runId}:v${input.run.revision}`
  let { data: charge } = await input.supabase.from("payment_run_fee_charges")
    .select("id,status,amount_cents").eq("org_id", input.orgId).eq("idempotency_key", idempotencyKey).maybeSingle()
  if (!charge) {
    const { data: inserted, error: insertError } = await input.supabase.from("payment_run_fee_charges").insert({
      org_id: input.orgId,
      run_id: runId,
      funding_source_id: input.funding.id,
      provider: input.provider.key,
      status: "created",
      processor_fee_cents: processorFeeCents,
      platform_fee_cents: platformFeeCents,
      amount_cents: amountCents,
      currency,
      idempotency_key: idempotencyKey,
    }).select("id,status,amount_cents").single()
    if (insertError || !inserted) {
      await recordEvent({ orgId: input.orgId, actorId: input.actorId, eventType: "payment_run_fee_charge_failed", entityType: "payment_run", entityId: runId, payload: { error: insertError?.message ?? "Fee charge could not be created", amount_cents: amountCents } })
      return null
    }
    charge = inserted
  }
  if (charge.status !== "created") {
    return { id: charge.id, amountCents: Number(charge.amount_cents), status: charge.status }
  }

  // Recognise the liability before contacting the provider, so an authoritative
  // failure has something to reverse even if it races the HTTP response.
  await postApFeeAccrualLedger({
    orgId: input.orgId,
    runId,
    feeChargeId: charge.id,
    processorFeeCents,
    platformFeeCents,
    currency,
    effectiveAt: input.effectiveAt,
  })

  try {
    if (!input.funding.provider_customer_id || !input.funding.provider_payment_method_id) {
      throw new Error("Funding source is missing its provider references")
    }
    const result = await input.provider.submitPlatformCharge({
      chargeId: charge.id,
      orgId: input.orgId,
      amountCents,
      currency,
      providerCustomerId: input.funding.provider_customer_id,
      providerPaymentMethodId: input.funding.provider_payment_method_id,
      idempotencyKey,
      metadata: { payment_run_id: runId },
    })
    if (result.status === "failed") throw new Error("Provider rejected the Arc fee debit")
    await input.supabase.from("payment_run_fee_charges").update({
      status: result.status === "funds_available" ? "succeeded" : result.status === "debit_pending" ? "debit_pending" : "submitted",
      provider_payment_id: result.providerPaymentId,
      submitted_at: input.effectiveAt,
      ...(result.status === "funds_available" ? { settled_at: input.effectiveAt } : {}),
    }).eq("org_id", input.orgId).eq("id", charge.id).eq("status", "created")
    await postApFeeChargeSubmittedLedger({ orgId: input.orgId, runId, feeChargeId: charge.id, amountCents, currency, effectiveAt: input.effectiveAt })
    return { id: charge.id, amountCents, status: result.status }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Arc fee debit failed"
    await input.supabase.from("payment_run_fee_charges").update({
      status: "failed",
      failure_reason: message,
      submission_attempted_at: input.effectiveAt,
    }).eq("org_id", input.orgId).eq("id", charge.id).eq("status", "created")
    // The accrual stands. The fee was earned when the vendors were paid, so a
    // failed collection leaves an open liability rather than forgiving it.
    await recordEvent({
      orgId: input.orgId,
      actorId: input.actorId,
      eventType: "payment_run_fee_charge_failed",
      entityType: "payment_run",
      entityId: runId,
      payload: { fee_charge_id: charge.id, amount_cents: amountCents, error: message },
    })
    return { id: charge.id, amountCents, status: "failed" }
  }
}

async function rollUpExecutionFailure(input: { supabase: ReturnType<typeof createServiceSupabaseClient>; orgId: string; runId: string; itemId: string; payeeId: string; message: string }) {
  await input.supabase.from("payment_run_item_payees").update({ status: "failed" }).eq("org_id", input.orgId).eq("id", input.payeeId)
  await input.supabase.from("payment_run_items").update({ status: "failed", failure_reason: input.message }).eq("org_id", input.orgId).eq("id", input.itemId)
  const { count } = await input.supabase.from("disbursements").select("id", { count: "exact", head: true }).eq("org_id", input.orgId).eq("run_id", input.runId).not("status", "in", "(failed,canceled)")
  await input.supabase.from("payment_runs").update({ status: (count ?? 0) > 0 ? "partially_failed" : "failed", completed_at: new Date().toISOString() }).eq("org_id", input.orgId).eq("id", input.runId)
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
  /** Business date the preparer picked, or null to release on approval. */
  scheduled_for: string | null
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
    processorFeeCents: number
    platformFeeCents: number
    releasableAtSubmission: boolean
    waiverStatus: string | null
    payees: Array<{ id: string; name: string; kind: string; method: string; amountCents: number }>
  }>
}

export async function listPaymentRuns(orgId?: string, scopedProjectIds: string[] | null = null): Promise<PaymentRunListRow[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const scopedRunIds = scopedProjectIds === null
    ? null
    : scopedProjectIds.length === 0
      ? []
      : (await supabase.from("payment_run_items").select("run_id").eq("org_id", context.orgId).in("project_id", scopedProjectIds)).data?.map((row) => row.run_id) ?? []
  let runQuery = supabase.from("payment_runs").select("id,status,currency,payment_count,vendor_amount_cents,processor_fee_cents,platform_fee_cents,total_debit_cents,approval_mode_snapshot,required_approvals,content_hash,requested_by,requested_at,approved_at,processing_started_at,completed_at,created_at,scheduled_for").eq("org_id", context.orgId)
  if (scopedRunIds !== null) runQuery = scopedRunIds.length > 0 ? runQuery.in("id", Array.from(new Set(scopedRunIds))) : runQuery.eq("id", "00000000-0000-0000-0000-000000000000")
  const [routing, runResult] = await Promise.all([
    getPaymentApprovalRouting(context.orgId),
    runQuery.order("created_at", { ascending: false }).limit(PAYMENT_RUN_LIST_LIMIT).overrideTypes<PaymentRunReviewRow[], { merge: false }>(),
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
  const { data: divisionRows } = projectIds.length > 0
    ? await supabase.from("projects").select("id,division_id").eq("org_id", context.orgId).in("id", projectIds)
    : { data: [] }
  const divisionByProject = new Map((divisionRows ?? []).map((project) => [project.id, project.division_id as string | null]))
  const divisionsByRunId = new Map<string, string[]>()
  for (const item of itemRows) {
    const division = item.project_id ? divisionByProject.get(item.project_id) ?? null : null
    if (!division) continue
    const current = divisionsByRunId.get(item.run_id) ?? []
    if (!current.includes(division)) current.push(division)
    divisionsByRunId.set(item.run_id, current)
  }
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
      processorFeeCents: Number(item.processor_fee_cents),
      platformFeeCents: Number(item.platform_fee_cents),
      releasableAtSubmission: releasable,
      waiverStatus: typeof waiverStatus === "string" ? waiverStatus : null,
      payees: payeesByItemId.get(item.id) ?? [],
    })
    listItemsByRunId.set(item.run_id, rows)
  }
  // A run is approvable by this viewer when they are designated (or the org named
  // nobody and they hold the permission), they did not prepare it, and it fits
  // under their personal approval ceiling.
  const viewerEntries = routing.approvers.filter((approver) => approver.userId === context.userId)
  // Mirrors assertUserMayApproveRun: the best ceiling across every entry that
  // covers the run. A UI that offers a button the server will refuse is worse
  // than no button.
  const viewerCanApprove = (requestedBy: string, totalDebitCents: number, runDivisions: string[]) => {
    if (!routing.viewerMayApprove || requestedBy === context.userId) return false
    if (viewerEntries.length === 0) return true
    const covering = viewerEntries.filter((entry) =>
      !entry.divisionId || (runDivisions.length > 0 && runDivisions.every((division) => division === entry.divisionId)),
    )
    if (covering.length === 0) return false
    const bestLimit = covering.reduce<number | null>((best, entry) => {
      if (best === null || entry.approvalLimitCents === null) return null
      return Math.max(best, entry.approvalLimitCents)
    }, 0)
    return bestLimit == null || totalDebitCents <= bestLimit
  }
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
    scheduled_for: row.scheduled_for ?? null,
    details_truncated: detailsTruncated,
    can_cancel: row.requested_by === context.userId && ["draft", "pending_approval", "approved"].includes(row.status),
    can_approve: viewerCanApprove(row.requested_by, Number(row.total_debit_cents), divisionsByRunId.get(row.id) ?? []),
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
    /** Drives the "this schedule pays late" warning when picking a release date. */
    dueDate: string | null
    /**
     * The early-pay discount still available, if any. Present so the preparer
     * sees the money before choosing a release date, not after.
     */
    discount: { byDate: string; amountCents: number; netAmountCents: number } | null
  }>
  /** Who a submitted run routes to, so the preparer can be told before submitting. */
  routing: PaymentApprovalRouting
  /**
   * The rail's own timing, shipped to the client so the date picker can show the
   * vendor-receipt estimate as the preparer moves the date. Estimate only — see
   * the provider adapter for what is and is not confirmed.
   */
  settlementWindow: ProviderSettlementWindow
  /** The AP fee quote in force, so the preparer sees the cost before building a run. */
  feePolicy: { platformFeeFlatCents: number; platformFeeBps: number; passThroughProcessorFees: boolean }
}

export async function getPaymentRunSetupData(orgId?: string, scopedProjectIds: string[] | null = null): Promise<PaymentRunSetupData> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  let billsQuery = supabase.from("vendor_bills")
    .select("id,bill_number,total_cents,paid_cents,retainage_cents,status,company_id,project_id,due_date,bill_date,early_pay_discount_percent,early_pay_discount_days")
    .eq("org_id", context.orgId).in("status", ["approved", "partial"])
  if (scopedProjectIds !== null) billsQuery = scopedProjectIds.length > 0 ? billsQuery.in("project_id", scopedProjectIds) : billsQuery.eq("project_id", "00000000-0000-0000-0000-000000000000")
  const [routing, feePolicy, { data: fundingSources, error: fundingError }, { data: bills, error: billsError }] = await Promise.all([
    getPaymentApprovalRouting(context.orgId),
    loadApFeePolicy(context.orgId),
    supabase.from("org_funding_sources")
      .select("id,bank_name,last4,is_default,status,usable_after,provider")
      .eq("org_id", context.orgId)
      .eq("status", "active")
      .order("is_default", { ascending: false })
      .limit(20),
    billsQuery.order("due_date", { ascending: true, nullsFirst: false }).limit(200),
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
      const terms = readEarlyPayTerms(bill)
      const discount = terms && bill.bill_date
        ? calculateEarlyPayDiscount({ billDate: bill.bill_date, outstandingCents, terms })
        : null
      return [{
        id: bill.id,
        billNumber: bill.bill_number ?? "Unnumbered bill",
        vendorName: companyById.get(bill.company_id) ?? "Vendor",
        projectName: bill.project_id ? projectById.get(bill.project_id) ?? "Project" : "Project",
        outstandingCents,
        recipientAccountId: recipient.id,
        dueDate: bill.due_date ?? null,
        discount: discount
          ? { byDate: discount.discountByDate, amountCents: discount.discountCents, netAmountCents: discount.netAmountCents }
          : null,
      }]
    }),
    routing,
    // Every active funding source in an org is on the same rail today; the default
    // one decides which adapter's timing the preparer is shown.
    settlementWindow: getPaymentRailProvider((fundingSources ?? [])[0]?.provider ?? undefined).settlementWindow,
    feePolicy: {
      platformFeeFlatCents: feePolicy.platformFeeFlatCents,
      platformFeeBps: feePolicy.platformFeeBps,
      passThroughProcessorFees: feePolicy.passThroughProcessorFees,
    },
  }
}
