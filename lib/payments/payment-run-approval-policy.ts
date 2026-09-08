import { requesterMayApprovePaymentRun } from "@/lib/payments/payment-domain"

export interface SubmissionApprover {
  userId: string
  permitted: boolean
  approvalLimitCents: number | null
  divisionId: string | null
}

export function hashableWaiverSnapshot(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const snapshot = value as Record<string, unknown>
  const { commitment: _commitment, construction: _legacyCommitment, ...billFacts } = snapshot
  return billFacts
}

export function evaluateRunSubmissionReadiness(input: {
  preparerId: string
  totalDebitCents: number
  requiredApprovals: number
  runDivisionIds: string[]
  controlSnapshot: unknown
  routing: { rosterConfigured: boolean; approvers: SubmissionApprover[] }
  preferredApproverIds?: string[]
}) {
  if (!input.routing.rosterConfigured || input.routing.approvers.length === 0) return { approvable: false, reason: "No payment approvers are configured. Add approvers in Settings → Payments → Approvers." }
  const preferred = input.preferredApproverIds ?? []
  const requesterAllowed = requesterMayApprovePaymentRun(input.controlSnapshot) && input.requiredApprovals === 1
  const eligible = input.routing.approvers.filter((approver) => approver.permitted
    && (requesterAllowed || approver.userId !== input.preparerId)
    && (preferred.length === 0 || preferred.includes(approver.userId))
    && (approver.approvalLimitCents == null || approver.approvalLimitCents >= input.totalDebitCents)
    && (!approver.divisionId || (input.runDivisionIds.length > 0 && input.runDivisionIds.every((id) => id === approver.divisionId))))
  if (eligible.length >= input.requiredApprovals) return { approvable: true, reason: "Ready for approval" }
  if (input.routing.approvers.every((approver) => approver.userId === input.preparerId)) return { approvable: false, reason: "Every eligible approver is the payment preparer. Add another approver." }
  if (input.routing.approvers.every((approver) => approver.approvalLimitCents != null && approver.approvalLimitCents < input.totalDebitCents)) return { approvable: false, reason: "No configured approver has a high enough payment limit." }
  if (input.runDivisionIds.length > 0 && input.routing.approvers.every((approver) => approver.divisionId && !input.runDivisionIds.every((id) => id === approver.divisionId))) return { approvable: false, reason: "No configured approver covers every division in this payment run." }
  return { approvable: false, reason: `This run needs ${input.requiredApprovals} eligible approver${input.requiredApprovals === 1 ? "" : "s"}, but only ${eligible.length} can approve it.` }
}

/** Approvers the preparer named on the payables, frozen into the run's control snapshot. */
export function selectedApproverIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const ids = Reflect.get(value, "preferred_approver_ids")
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []
}

export interface PaymentRunApprovability {
  /** Whether this viewer may decide this run right now. */
  mayDecide: boolean
  /** Why they may not, written for them to read. Null when they may. */
  blockedReason: string | null
}

/**
 * The one answer to "may this viewer approve this run".
 *
 * Every surface that offers or withholds an Approve button reads it here, and
 * it mirrors `assertUserMayApproveRun`, which is what the server will actually
 * enforce. The two used to be computed separately: the approver screen took the
 * FIRST roster entry's ceiling, checked no division and ignored preferred-
 * approver routing, so divisional and routed-away approvers were shown a live
 * button the server refused, and anyone holding a low org-wide entry alongside a
 * higher divisional one was wrongly told they were over their limit.
 */
export function evaluateRunApprovability(input: {
  viewerId: string
  requestedBy: string
  totalDebitCents: number
  /** Divisions the run's projects sit in; empty when none of them are divisioned. */
  runDivisionIds: string[]
  controlSnapshot: unknown
  /** `PaymentApprovalRouting` satisfies this; the shape keeps the module pure. */
  routing: { viewerMayApprove: boolean; approvers: SubmissionApprover[] }
}): PaymentRunApprovability {
  if (!input.routing.viewerMayApprove) {
    return { mayDecide: false, blockedReason: "Your role does not allow approving payments" }
  }
  if (input.requestedBy === input.viewerId && !requesterMayApprovePaymentRun(input.controlSnapshot)) {
    return { mayDecide: false, blockedReason: "You prepared this payment, so someone else has to approve it" }
  }
  const preferredApprovers = selectedApproverIds(input.controlSnapshot)
  if (preferredApprovers.length > 0 && !preferredApprovers.includes(input.viewerId)) {
    return { mayDecide: false, blockedReason: "This payment was routed to different approvers" }
  }
  // No roster entry at all means the org never named approvers — `viewerMayApprove`
  // already required membership when it did — so the permission is the whole gate.
  const entries = input.routing.approvers.filter((approver) => approver.userId === input.viewerId)
  if (entries.length === 0) return { mayDecide: true, blockedReason: null }
  // A division-scoped entry covers a run only when every payable in it sits in
  // that division: approving the part you own is not approving the run.
  const covering = entries.filter((entry) =>
    !entry.divisionId || (input.runDivisionIds.length > 0 && input.runDivisionIds.every((division) => division === entry.divisionId)),
  )
  if (covering.length === 0) {
    return {
      mayDecide: false,
      blockedReason: "This payment covers work outside the division you approve for; it needs an approver with organization-wide authority",
    }
  }
  // The best ceiling across covering entries, never the first one found: someone
  // may hold a low org-wide ceiling and a higher one inside their own division.
  const bestLimitCents = covering.reduce<number | null>((best, entry) => {
    if (best === null || entry.approvalLimitCents === null) return null
    return Math.max(best, entry.approvalLimitCents)
  }, 0)
  if (bestLimitCents != null && input.totalDebitCents > bestLimitCents) {
    return { mayDecide: false, blockedReason: "This payment is above your approval limit" }
  }
  return { mayDecide: true, blockedReason: null }
}
