import "server-only"

import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { requireRecentPaymentStepUp } from "@/lib/services/payment-step-up"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The risk queue.
 *
 * `assertRunRiskAllowed` wrote a blocking review and threw, and nothing else in
 * the codebase ever read the table — so a block was terminal with no queue, no
 * screen and no override. Three failed disbursements stopped an org's entire AP
 * for twenty-four hours with no way for a human to look at it and say the
 * payments were fine. On a Friday that means subcontractors wait until Monday.
 *
 * A block is now a decision waiting for someone, not a wall.
 */

const RISK_QUEUE_LIMIT = 100

export interface PaymentRiskSignal {
  code: string
  severity: string
  [key: string]: unknown
}

export interface BlockedPaymentRun {
  reviewId: string
  runId: string
  createdAt: string
  riskScore: number
  signals: PaymentRiskSignal[]
  runStatus: string
  totalDebitCents: number
  paymentCount: number
  requestedBy: string
  /** True when the viewer prepared the run, and so may never clear its block. */
  preparedByViewer: boolean
}

/**
 * Runs currently stopped by risk controls.
 *
 * A run appears only while its most recent review still blocks it — once a
 * reviewer allows it, or the run reaches a terminal state, it drops out.
 */
export async function listBlockedPaymentRuns(orgId?: string): Promise<BlockedPaymentRun[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.reconcile", context)
  const supabase = createServiceSupabaseClient()

  const { data: reviews, error } = await supabase
    .from("payment_risk_reviews")
    .select("id,run_id,decision,review_type,risk_score,signals,created_at")
    .eq("org_id", context.orgId)
    .not("run_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(RISK_QUEUE_LIMIT * 4)
  if (error) throw new Error(`Unable to load payment risk reviews: ${error.message}`)

  // Only the latest review per run matters — an older block that a reviewer has
  // since allowed is history, not a queue item.
  const latestByRun = new Map<string, (typeof reviews)[number]>()
  for (const review of reviews ?? []) {
    if (!review.run_id || latestByRun.has(review.run_id)) continue
    latestByRun.set(review.run_id, review)
  }
  const blocked = [...latestByRun.values()].filter((review) => review.decision === "block").slice(0, RISK_QUEUE_LIMIT)
  if (blocked.length === 0) return []

  const { data: runs } = await supabase
    .from("payment_runs")
    .select("id,status,total_debit_cents,payment_count,requested_by")
    .eq("org_id", context.orgId)
    .in("id", blocked.map((review) => review.run_id as string))
  const runById = new Map((runs ?? []).map((run) => [run.id, run]))

  return blocked.flatMap((review) => {
    const run = runById.get(review.run_id as string)
    // A run that has since been cancelled or paid is not waiting on anyone.
    if (!run || !["draft", "pending_approval", "approved"].includes(run.status)) return []
    return [{
      reviewId: review.id,
      runId: review.run_id as string,
      createdAt: review.created_at,
      riskScore: Number(review.risk_score ?? 0),
      signals: Array.isArray(review.signals) ? (review.signals as PaymentRiskSignal[]) : [],
      runStatus: run.status,
      totalDebitCents: Number(run.total_debit_cents),
      paymentCount: Number(run.payment_count),
      requestedBy: run.requested_by,
      preparedByViewer: run.requested_by === context.userId,
    }]
  })
}

const decideRiskSchema = z.object({
  run_id: z.string().uuid(),
  decision: z.enum(["allow", "block"]),
  // Long enough to be a reason rather than a shrug. This is the record of why
  // someone released a payment the system refused.
  reason: z.string().trim().min(12).max(1000),
})

export type DecidePaymentRiskInput = z.infer<typeof decideRiskSchema>

/**
 * Record a human decision on a blocked run.
 *
 * Deliberately mirrors the run-approval controls: step-up authentication, and
 * the preparer can never clear a block on their own run. Overriding a fraud
 * control is at least as sensitive as approving the payment it stopped, so it
 * cannot be the weaker gate.
 */
export async function decidePaymentRiskReview(input: DecidePaymentRiskInput, orgId?: string) {
  const parsed = decideRiskSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payments.approve_run", context)
  const stepUpVerifiedAt = await requireRecentPaymentStepUp()
  const supabase = createServiceSupabaseClient()

  const { data: run, error } = await supabase
    .from("payment_runs")
    .select("id,status,requested_by,total_debit_cents")
    .eq("org_id", context.orgId)
    .eq("id", parsed.run_id)
    .maybeSingle()
  if (error || !run) throw new Error("Payment run was not found")
  if (run.requested_by === context.userId) {
    throw new Error("You prepared this run, so you cannot clear the risk block on it")
  }
  if (!["draft", "pending_approval", "approved"].includes(run.status)) {
    throw new Error("This payment run is no longer waiting on a risk decision")
  }

  const { data: review, error: insertError } = await supabase
    .from("payment_risk_reviews")
    .insert({
      org_id: context.orgId,
      run_id: parsed.run_id,
      review_type: "manual",
      decision: parsed.decision,
      risk_score: parsed.decision === "allow" ? 0 : 100,
      signals: [{ code: "manual_review", severity: "observe", reason: parsed.reason, step_up_verified_at: stepUpVerifiedAt }],
      reviewed_by: context.userId,
      reviewed_at: new Date().toISOString(),
    })
    .select("id")
    .single()
  if (insertError || !review) throw new Error(`Unable to record risk decision: ${insertError?.message}`)

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: parsed.decision === "allow" ? "payment_risk_override_granted" : "payment_risk_block_confirmed",
      entityType: "payment_run",
      entityId: parsed.run_id,
      payload: { review_id: review.id, reason: parsed.reason, total_debit_cents: Number(run.total_debit_cents) },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "payment_risk_review",
      entityId: review.id,
      after: { run_id: parsed.run_id, decision: parsed.decision, reason: parsed.reason },
    }),
  ])
  return { id: review.id, decision: parsed.decision }
}
