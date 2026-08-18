import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { assertProjectBillingDateEditable } from "@/lib/services/billing-periods"
import { sendVendorBillDecisionNotice } from "@/lib/services/vendor-bill-notices"

/**
 * The parts of approving a payable that must be true no matter which door the
 * approval came through.
 *
 * Arc approves payables from three places — the payables workspace one at a
 * time, the desk in bulk, and a rule with nobody watching — and each had grown
 * its own copy of the rules. The copies drifted: only the cost inbox refused to
 * approve into a closed accounting period, and only the single-bill path told
 * the vendor the answer. A vendor whose invoice was approved in a batch simply
 * never heard back, and the same payable could be approved into a locked period
 * or not depending on which button was used.
 *
 * These helpers are that shared middle. Anything a human approval enforces
 * belongs here, so a rule cannot be a way around it and neither can a checkbox.
 */

/**
 * Refuse an approval that would post cost into a closed accounting period.
 *
 * Approval is what puts a payable into the cost ledger, so it is a posting, and
 * a posting into a locked period is exactly what locking a period forbids. The
 * bill date decides the period — the same date the ledger entry will carry.
 */
export async function assertPayableApprovalPeriodOpen(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string | null | undefined
  billDate: string | null | undefined
}): Promise<void> {
  if (!args.projectId) return
  await assertProjectBillingDateEditable({
    supabase: args.supabase,
    orgId: args.orgId,
    projectId: args.projectId,
    date: args.billDate,
    actionLabel: "This payable",
  })
}

/**
 * Tell the vendor their invoice was approved.
 *
 * Best effort, deliberately: the approval is already recorded and a mail
 * failure must not undo it. But it is not optional in the sense of "only when
 * approved one at a time" — a batch approval is the same answer to the same
 * question, and silence is how a subcontractor ends up calling to ask.
 */
export async function notifyPayableApprovalDecision(args: {
  orgId: string
  billId: string
  kind: "approved" | "rejected"
  reason?: string | null
  eventId?: string | null
}): Promise<void> {
  await sendVendorBillDecisionNotice({
    orgId: args.orgId,
    billId: args.billId,
    kind: args.kind,
    reason: args.reason ?? null,
    eventId: args.eventId ?? null,
  }).catch(() => {})
}
