import "server-only"

import { z } from "zod"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import type { ProviderSettlementWindow } from "@/lib/payments/settlement-estimate"
import { requireOrgContext } from "@/lib/services/context"
import { getPaymentApprovalRouting } from "@/lib/services/payment-approvers"
import {
  createPaymentRun,
  decidePaymentRun,
  evaluateRunApprovability,
  isReleasableHoldSnapshot,
} from "@/lib/services/payment-runs"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { decidePaymentRunSchema } from "@/lib/validation/fintech-payments"

export const preparePayableApprovalSchema = z.object({
  /**
   * One or many. A run is the envelope an approver signs for, so a batch is the
   * normal case and a single bill is just a batch of one — the same code path
   * either way, rather than a second one that drifts.
   */
  bills: z
    .array(z.object({ bill_id: z.string().uuid(), amount_cents: z.number().int().positive() }))
    .min(1, "Select at least one payable")
    .max(200, "A payment run holds up to 200 payables"),
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
  /** Provider cost and Arc's fee stay apart: a lumped "fees" number hides whose it is. */
  processorFeeCents: number
  platformFeeCents: number
  requiredApprovals: number
  /** How many separate ACH payments this run makes — one per payable. */
  paymentCount: number
}

/**
 * Turn selected payables into one payment run, ready to submit for approval.
 *
 * The run is the envelope an approver signs for, so the batch — not the bill —
 * is the natural unit here. Fees are still quoted per payable, because each one
 * is its own ACH payment to its own vendor and the provider charges accordingly;
 * they are merely collected in a single debit so a run does not pay a processor
 * fee to collect a processor fee.
 *
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

  const billIds = parsed.bills.map((entry) => entry.bill_id)
  if (new Set(billIds).size !== billIds.length) {
    throw new Error("The same payable was selected twice")
  }

  const { data: bills, error } = await supabase
    .from("vendor_bills")
    .select("id,status,company_id,total_cents,paid_cents,retainage_cents,bill_number,metadata")
    .eq("org_id", context.orgId)
    .in("id", billIds)
  if (error) throw new Error(`Unable to load the selected payables: ${error.message}`)
  if (!bills || bills.length !== billIds.length) throw new Error("One or more payables were not found")
  const billById = new Map(bills.map((bill) => [bill.id, bill]))

  const companyIds = [...new Set(bills.map((bill) => bill.company_id).filter((id): id is string => Boolean(id)))]
  const [{ data: relationships }, { data: companies }] = await Promise.all([
    // The payee's destination is resolved server-side — a client must never get
    // to name the bank account a payment lands in.
    supabase
      .from("vendor_payment_relationships")
      .select("company_id,recipient_account_id,status")
      .eq("org_id", context.orgId)
      .eq("status", "active")
      .in("company_id", companyIds.length > 0 ? companyIds : [""]),
    supabase
      .from("companies")
      .select("id,name")
      .eq("org_id", context.orgId)
      .in("id", companyIds.length > 0 ? companyIds : [""]),
  ])
  const recipientByCompany = new Map((relationships ?? []).map((row) => [row.company_id, row.recipient_account_id]))
  const nameByCompany = new Map((companies ?? []).map((row) => [row.id, row.name]))

  const items = parsed.bills.map((entry) => {
    const bill = billById.get(entry.bill_id)
    if (!bill) throw new Error("One or more payables were not found")
    const label = bill.bill_number ? `Invoice ${bill.bill_number}` : "A payable"
    if (!bill.company_id) throw new Error(`${label} has no vendor to pay`)

    // Approving the obligation and releasing the money are two decisions, and
    // preparing a payment must never quietly make them one.
    if (bill.status === "rejected") throw new Error(`${label} was rejected. Reopen it before paying.`)
    if (bill.status === "pending") throw new Error(`${label} has to be approved before a payment can be prepared for it`)

    // The builder said they would pay this one themselves. Paying it here as
    // well is how a vendor gets paid twice, so it is refused rather than warned.
    if ((bill.metadata as Record<string, unknown> | null)?.payment_channel === "external") {
      throw new Error(`${label} is set to be paid outside Arc. Change its payment method on the payable to pay it here.`)
    }

    const outstandingCents = payableOutstandingCents({
      total_cents: Number(bill.total_cents ?? 0),
      paid_cents: Number(bill.paid_cents ?? 0),
      retainage_cents: Number(bill.retainage_cents ?? 0),
    })
    if (entry.amount_cents > outstandingCents) {
      throw new Error(`${label} is set to pay more than its outstanding balance`)
    }

    const recipientAccountId = recipientByCompany.get(bill.company_id)
    if (!recipientAccountId) throw new Error(`The vendor on ${label} has not finished payout verification yet`)

    return {
      bill_id: entry.bill_id,
      amount_cents: entry.amount_cents,
      payees: [
        {
          payee_kind: "primary_vendor" as const,
          method: "ach" as const,
          payee_name: nameByCompany.get(bill.company_id) ?? "Vendor",
          amount_cents: entry.amount_cents,
        },
      ],
    }
  })

  const run = await createPaymentRun(
    {
      funding_source_id: parsed.funding_source_id,
      idempotency_key: parsed.idempotency_key,
      items,
    },
    context.orgId,
  )

  return {
    runId: run.id,
    totalDebitCents: run.totalDebitCents,
    vendorAmountCents: run.vendorAmountCents,
    processorFeeCents: run.processorFeeCents,
    platformFeeCents: run.platformFeeCents,
    requiredApprovals: run.requiredApprovals,
    paymentCount: items.length,
  }
}

export interface PayableApprovalDetail {
  runId: string
  status: string
  contentHash: string | null
  vendorAmountCents: number
  /** Kept apart so the approver can see which part of the cost is Arc's. */
  processorFeeCents: number
  platformFeeCents: number
  totalDebitCents: number
  requiredApprovals: number
  approvalCount: number
  /** The release date the preparer chose, or null to release on approval. */
  scheduledFor: string | null
  /** The rail's timing, so the approver sees when the vendor would actually be paid. */
  settlementWindow: ProviderSettlementWindow
  fundingLabel: string
  submittedByName: string
  submittedAt: string | null
  /** Whether the viewer may decide this run right now. */
  viewerMayDecide: boolean
  /** Why they cannot, when they cannot — shown instead of a dead button. */
  blockedReason: string | null
  /**
   * Every payable in the run, not just the one that was clicked. The signature
   * binds to the whole frozen set, so showing a single line beside the run's
   * total made the approver sign for money they could not see.
   */
  items: Array<{
    billId: string
    billNumber: string | null
    vendorName: string
    projectName: string | null
    vendorAmountCents: number
    /** Quoted per payable: each is its own ACH payment, priced on its own amount. */
    processorFeeCents: number
    platformFeeCents: number
    releasableAtSubmission: boolean
  }>
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

  // The whole run, because that is what the approval binds to. The project's
  // division comes with it: a division-scoped approver covers a run only when
  // every payable in it sits inside their division, and this screen has to know
  // that before it offers a button.
  const { data: runItems } = await supabase
    .from("payment_run_items")
    .select("bill_id,vendor_amount_cents,processor_fee_cents,platform_fee_cents,hold_snapshot,bill:vendor_bills(bill_number,company:companies(name)),project:projects(name,division_id)")
    .eq("org_id", context.orgId)
    .eq("run_id", item.run_id)
    .order("created_at")
    .limit(200)

  const [{ data: run }, { data: approvals }, routing] = await Promise.all([
    supabase
      .from("payment_runs")
      .select(
        "id,status,content_hash,total_debit_cents,required_approvals,requested_by,requested_at,funding_source_id,scheduled_for,control_snapshot",
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
          .select("bank_name,last4,provider")
          .eq("id", run.funding_source_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("app_users")
      .select("full_name,email")
      .eq("id", run.requested_by)
      .maybeSingle(),
  ])

  const totalDebitCents = Number(run.total_debit_cents)
  const runDivisionIds = [
    ...new Set(
      (runItems ?? [])
        .map((row) => (Array.isArray(row.project) ? row.project[0] : row.project)?.division_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  ]
  // One derivation, shared with the run list and mirroring the server's own
  // refusal — this screen used to compute its own weaker version.
  const { mayDecide, blockedReason } = evaluateRunApprovability({
    viewerId: context.userId,
    requestedBy: run.requested_by,
    totalDebitCents,
    runDivisionIds,
    controlSnapshot: run.control_snapshot,
    routing,
  })

  return {
    runId: run.id,
    status: run.status,
    contentHash: run.content_hash ?? null,
    vendorAmountCents: Number(item.vendor_amount_cents),
    processorFeeCents: Number(item.processor_fee_cents),
    platformFeeCents: Number(item.platform_fee_cents),
    totalDebitCents,
    requiredApprovals: Number(run.required_approvals),
    approvalCount: (approvals ?? []).filter(
      (approval) => approval.decision === "approved",
    ).length,
    scheduledFor: run.scheduled_for ?? null,
    settlementWindow: getPaymentRailProvider(funding?.provider ?? undefined).settlementWindow,
    fundingLabel: funding
      ? `${funding.bank_name ?? "Bank account"}${funding.last4 ? ` •••• ${funding.last4}` : ""}`
      : "Bank account",
    submittedByName: submitter?.full_name ?? submitter?.email ?? "A teammate",
    submittedAt: run.requested_at ?? null,
    viewerMayDecide: run.status === "pending_approval" && mayDecide,
    blockedReason,
    items: (runItems ?? []).map((row) => {
      const rowBill = Array.isArray(row.bill) ? row.bill[0] : row.bill
      const rowCompany = rowBill && (Array.isArray(rowBill.company) ? rowBill.company[0] : rowBill.company)
      const rowProject = Array.isArray(row.project) ? row.project[0] : row.project
      return {
        billId: row.bill_id,
        billNumber: rowBill?.bill_number ?? null,
        vendorName: rowCompany?.name ?? "Vendor",
        projectName: rowProject?.name ?? null,
        vendorAmountCents: Number(row.vendor_amount_cents),
        processorFeeCents: Number(row.processor_fee_cents),
        platformFeeCents: Number(row.platform_fee_cents),
        // Fails closed on missing evidence: an absent snapshot is not a clearance.
        releasableAtSubmission: isReleasableHoldSnapshot(row.hold_snapshot),
      }
    }),
  }
}

export type PayableApprovalOutcome =
  | { result: "recorded"; status: string }
  | { result: "rejected" }
  | { result: "released" }
  /** Approved with a release date on it — nothing is pending, it goes out then. */
  | { result: "scheduled"; scheduledFor: string }
  /** Approved; the release is a queued work item because this approver cannot release. */
  | { result: "release_queued"; reason: string }
  /** Approved, but a gate or a failure stopped the money. The sweep retries it. */
  | { result: "approved_release_pending"; reason: string }

/**
 * Approve (or reject) a payable's payment run.
 *
 * Releasing the money is `decidePaymentRun`'s job, not this one's: reaching
 * quorum is what owes a release, and putting it in the caller made it a property
 * of approving from the web app. This translates that one outcome into the copy
 * the payable screen shows, and keeps the four cases apart — released,
 * scheduled for a date the approver already saw, queued because releasing money
 * is not part of this person's role, and genuinely gated or failed.
 */
export async function decidePayableApproval(
  input: z.infer<typeof decidePaymentRunSchema>,
  orgId?: string,
): Promise<PayableApprovalOutcome> {
  const parsed = decidePaymentRunSchema.parse(input)
  const decision = await decidePaymentRun(parsed, orgId)
  if (parsed.decision === "rejected") return { result: "rejected" }

  const status = decision.status
  if (status !== "approved") return { result: "recorded", status }

  switch (decision.release.kind) {
    case "released":
      return { result: "released" }
    case "scheduled":
      return { result: "scheduled", scheduledFor: decision.release.scheduledFor }
    case "queued":
      return { result: "release_queued", reason: decision.release.reason }
    case "blocked":
      return { result: "approved_release_pending", reason: decision.release.reason }
    // Quorum without a release is not a state a decision can reach: the service
    // releases, schedules or queues every approval that completes one.
    case "none":
      return { result: "recorded", status }
  }
}
