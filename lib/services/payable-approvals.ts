import "server-only"

import { z } from "zod"

import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { requireOrgContext } from "@/lib/services/context"
import { getPaymentApprovalRouting } from "@/lib/services/payment-approvers"
import {
  createPaymentRun,
  decidePaymentRun,
  executePaymentRun,
} from "@/lib/services/payment-runs"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { updateVendorBillStatus } from "@/lib/services/vendor-bills"
import { decidePaymentRunSchema } from "@/lib/validation/fintech-payments"

export const preparePayableApprovalSchema = z.object({
  bill_id: z.string().uuid(),
  amount_cents: z.number().int().positive(),
  funding_source_id: z.string().uuid(),
  idempotency_key: z.string().trim().min(8).max(200),
})

export type PreparePayableApprovalInput = z.infer<
  typeof preparePayableApprovalSchema
>

export interface PreparedPayableApproval {
  runId: string
  totalDebitCents: number
  vendorAmountCents: number
  requiredApprovals: number
}

/**
 * Turn one payable into a payment run that is ready to submit for approval.
 *
 * The preparer's act is a single decision — "pay this bill, from this account,
 * for this amount" — so the coding approval the run requires is folded in here
 * rather than left as a separate button the clerk has to remember to press.
 * Nothing is submitted and no money moves; that is `submitPaymentRun`.
 */
export async function preparePayableApproval(
  input: PreparePayableApprovalInput,
  orgId?: string,
): Promise<PreparedPayableApproval> {
  const parsed = preparePayableApprovalSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()

  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select(
      "id,status,company_id,updated_at,total_cents,paid_cents,retainage_cents,bill_number",
    )
    .eq("org_id", context.orgId)
    .eq("id", parsed.bill_id)
    .maybeSingle()
  if (error || !bill) throw new Error("Vendor bill not found")
  if (!bill.company_id) throw new Error("This payable has no vendor to pay")

  const outstandingCents = payableOutstandingCents({
    total_cents: Number(bill.total_cents ?? 0),
    paid_cents: Number(bill.paid_cents ?? 0),
    retainage_cents: Number(bill.retainage_cents ?? 0),
  })
  if (parsed.amount_cents > outstandingCents) {
    throw new Error(
      "Payment amount is more than this payable's outstanding balance",
    )
  }

  // A run can only contain approved bills. Approving here keeps the preparer's
  // flow to one decision; `updateVendorBillStatus` still enforces bill.approve.
  if (bill.status === "pending") {
    await updateVendorBillStatus({
      billId: parsed.bill_id,
      input: {
        status: "approved",
        expected_updated_at: bill.updated_at ?? undefined,
      },
      orgId: context.orgId,
    })
  }

  // The payee's destination is resolved server-side — a client must never get to
  // name the bank account a payment lands in.
  const { data: relationship } = await supabase
    .from("vendor_payment_relationships")
    .select("recipient_account_id,status")
    .eq("org_id", context.orgId)
    .eq("company_id", bill.company_id)
    .eq("status", "active")
    .maybeSingle()
  if (!relationship?.recipient_account_id) {
    throw new Error("This vendor has not finished payout verification yet")
  }

  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("org_id", context.orgId)
    .eq("id", bill.company_id)
    .maybeSingle()

  const run = await createPaymentRun(
    {
      funding_source_id: parsed.funding_source_id,
      idempotency_key: parsed.idempotency_key,
      items: [
        {
          bill_id: parsed.bill_id,
          amount_cents: parsed.amount_cents,
          retainage_held_cents: 0,
          payees: [
            {
              payee_kind: "primary_vendor",
              method: "ach",
              recipient_account_id: relationship.recipient_account_id,
              payee_name: company?.name ?? "Vendor",
              amount_cents: parsed.amount_cents,
            },
          ],
        },
      ],
    },
    context.orgId,
  )

  return {
    runId: run.id,
    totalDebitCents: run.totalDebitCents,
    vendorAmountCents: parsed.amount_cents,
    requiredApprovals: run.requiredApprovals,
  }
}

export interface PayableApprovalDetail {
  runId: string
  status: string
  contentHash: string | null
  vendorAmountCents: number
  feeCents: number
  totalDebitCents: number
  requiredApprovals: number
  approvalCount: number
  fundingLabel: string
  submittedByName: string
  submittedAt: string | null
  /** Whether the viewer may decide this run right now. */
  viewerMayDecide: boolean
  /** Why they cannot, when they cannot — shown instead of a dead button. */
  blockedReason: string | null
}

/**
 * Everything an approver needs to decide a bill's payment without leaving the
 * payable: the frozen amounts, who prepared it, and whether this viewer is
 * allowed to be the one who decides.
 */
export async function getPayableApprovalDetail(
  billId: string,
  orgId?: string,
): Promise<PayableApprovalDetail | null> {
  const parsedBillId = z.string().uuid().parse(billId)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()

  const { data: item } = await supabase
    .from("payment_run_items")
    .select("run_id,vendor_amount_cents,processor_fee_cents,platform_fee_cents")
    .eq("org_id", context.orgId)
    .eq("bill_id", parsedBillId)
    .in("status", [
      "draft",
      "pending_approval",
      "approved",
      "processing",
      "partially_paid",
    ])
    .maybeSingle()
  if (!item) return null

  const [{ data: run }, { data: approvals }, routing] = await Promise.all([
    supabase
      .from("payment_runs")
      .select(
        "id,status,content_hash,total_debit_cents,required_approvals,requested_by,requested_at,funding_source_id",
      )
      .eq("org_id", context.orgId)
      .eq("id", item.run_id)
      .maybeSingle(),
    supabase
      .from("payment_run_approvals")
      .select("decision")
      .eq("org_id", context.orgId)
      .eq("run_id", item.run_id),
    getPaymentApprovalRouting(context.orgId),
  ])
  if (!run) return null

  const [{ data: funding }, { data: submitter }] = await Promise.all([
    run.funding_source_id
      ? supabase
          .from("org_funding_sources")
          .select("bank_name,last4")
          .eq("id", run.funding_source_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("app_users")
      .select("full_name,email")
      .eq("id", run.requested_by)
      .maybeSingle(),
  ])

  const viewerLimitCents =
    routing.approvers.find((approver) => approver.userId === context.userId)
      ?.approvalLimitCents ?? null
  const totalDebitCents = Number(run.total_debit_cents)
  const isPreparer = run.requested_by === context.userId

  const blockedReason = !routing.viewerMayApprove
    ? "Your role does not allow approving payments"
    : isPreparer
      ? "You prepared this payment, so someone else has to approve it"
      : viewerLimitCents != null && totalDebitCents > viewerLimitCents
        ? "This payment is above your approval limit"
        : null

  return {
    runId: run.id,
    status: run.status,
    contentHash: run.content_hash ?? null,
    vendorAmountCents: Number(item.vendor_amount_cents),
    feeCents:
      Number(item.processor_fee_cents) + Number(item.platform_fee_cents),
    totalDebitCents,
    requiredApprovals: Number(run.required_approvals),
    approvalCount: (approvals ?? []).filter(
      (approval) => approval.decision === "approved",
    ).length,
    fundingLabel: funding
      ? `${funding.bank_name ?? "Bank account"}${funding.last4 ? ` •••• ${funding.last4}` : ""}`
      : "Bank account",
    submittedByName: submitter?.full_name ?? submitter?.email ?? "A teammate",
    submittedAt: run.requested_at ?? null,
    viewerMayDecide: run.status === "pending_approval" && !blockedReason,
    blockedReason,
  }
}

export type PayableApprovalOutcome =
  | { result: "recorded"; status: string }
  | { result: "rejected" }
  | { result: "released" }
  | { result: "approved_release_pending"; reason: string }

/**
 * Approve (or reject) a payable's payment run, and release it the moment it has
 * every approval it needs. Approval is what the org agreed the control is — once
 * it clears, holding the money back behind another button only invites someone
 * to forget to press it.
 *
 * Release is still gated by the platform kill switch and the org's execution
 * flag; when those are closed the run stays approved and this says so plainly
 * rather than reporting money that did not move.
 */
export async function decidePayableApproval(
  input: z.infer<typeof decidePaymentRunSchema>,
  orgId?: string,
): Promise<PayableApprovalOutcome> {
  const parsed = decidePaymentRunSchema.parse(input)
  const decision = await decidePaymentRun(parsed, orgId)
  if (parsed.decision === "rejected") return { result: "rejected" }

  const status =
    decision && typeof decision === "object"
      ? Reflect.get(decision, "status")
      : null
  if (status !== "approved") {
    return {
      result: "recorded",
      status: typeof status === "string" ? status : "pending_approval",
    }
  }

  try {
    await executePaymentRun(parsed.run_id, orgId)
    return { result: "released" }
  } catch (error) {
    return {
      result: "approved_release_pending",
      reason:
        error instanceof Error
          ? error.message
          : "Payment release is not enabled yet",
    }
  }
}
