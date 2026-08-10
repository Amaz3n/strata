import "server-only"

import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { decidePaymentRun, listPaymentRuns } from "@/lib/services/payment-runs"
import { requireRecentMobilePaymentStepUp } from "@/lib/services/payment-step-up"

/**
 * Payment approval from the phone.
 *
 * Everything here delegates to the same services the web app uses. The one thing
 * that genuinely differs is step-up: mobile has no cookie session, so assurance
 * is read from the bearer token's claims instead — same facts, same policy, via
 * `requireRecentMobilePaymentStepUp`.
 */

export interface MobilePaymentRunDTO {
  id: string
  status: string
  total_debit_cents: number
  payment_count: number
  currency: string
  requested_at: string | null
  scheduled_for: string | null
  /** Required by the decision endpoint — an approver decides what they were shown. */
  content_hash: string | null
  approvals_recorded: number
  approvals_required: number
  bills: Array<{ bill_number: string; vendor_name: string; project_name: string; amount_cents: number }>
}

export async function listMobilePaymentRuns(context: MobileOrgContext): Promise<MobilePaymentRunDTO[]> {
  const runs = await runWithServiceOrgContext(context.serviceContext, () => listPaymentRuns(context.orgId))
  return runs
    // Only what this person can actually act on. `can_approve` already accounts
    // for the roster, division scope, their ceiling, and never their own run.
    .filter((run) => run.status === "pending_approval" && run.can_approve)
    .map((run) => ({
      id: run.id,
      status: run.status,
      total_debit_cents: run.total_debit_cents,
      payment_count: run.payment_count,
      currency: run.currency,
      requested_at: run.requested_at,
      scheduled_for: run.scheduled_for,
      content_hash: run.content_hash,
      approvals_recorded: run.approvals.filter((approval) => approval.decision === "approved").length,
      approvals_required: run.required_approvals,
      bills: run.items.map((item) => ({
        bill_number: item.billNumber,
        vendor_name: item.vendorName,
        project_name: item.projectName,
        amount_cents: item.vendorAmountCents,
      })),
    }))
}

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  // Not optional on mobile either: an approver decides the run they were shown,
  // and a stale hash means the run changed since it rendered on their phone.
  content_hash: z.string().min(1),
  reason: z.string().trim().max(1000).optional(),
})

export async function decideMobilePaymentRun(context: MobileOrgContext, runId: string, body: unknown) {
  const parsed = decisionSchema.safeParse(body)
  if (!parsed.success) {
    throw new MobileAPIError(400, "invalid_decision", "A decision and the content hash you reviewed are required.")
  }
  if (!z.string().uuid().safeParse(runId).success) {
    throw new MobileAPIError(400, "invalid_payment_run", "That payment run id is not valid.")
  }

  try {
    await runWithServiceOrgContext(context.serviceContext, () =>
      decidePaymentRun(
        { run_id: runId, decision: parsed.data.decision, content_hash: parsed.data.content_hash, reason: parsed.data.reason },
        context.orgId,
        {
          // Assurance from the token's claims rather than a cookie session,
          // which mobile does not have. The token was already validated by
          // `requireMobileUser`, so its claims are authentic — and the policy
          // deciding on them is the same one the web path uses.
          resolveStepUp: async () => requireRecentMobilePaymentStepUp(context.token),
        },
      ),
    )
  } catch (error) {
    // The service's messages are written for the person deciding — the run
    // changed, you prepared it, it exceeds your limit — so they are surfaced
    // rather than replaced with a generic failure.
    throw new MobileAPIError(422, "decision_rejected", error instanceof Error ? error.message : "The decision could not be recorded.")
  }
  return { id: runId, decision: parsed.data.decision }
}
