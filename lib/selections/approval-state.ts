/**
 * Where a group's buyer approval stands. The database stores what happened to
 * each request (sent, approved, declined, expired, voided); what a coordinator
 * and a buyer read is one of five states, decided here and nowhere else:
 *
 *   unsigned  nothing was sent, or the last request was voided (withdrawn, or
 *             the selections changed after it went out)
 *   sent      waiting on the buyer
 *   declined  the buyer said no
 *   expired   the deadline passed without an answer
 *   approved  the buyer approved exactly what was sent
 */

export type SelectionApprovalStatus = "sent" | "approved" | "declined" | "expired" | "voided"
export type SelectionApprovalChannel = "esign" | "portal" | "in_person"
export type SelectionApprovalState = "unsigned" | "sent" | "declined" | "expired" | "approved"

export interface SelectionApprovalSummary {
  id: string
  status: SelectionApprovalStatus
  channel: SelectionApprovalChannel
  termsHash: string
  totalCents: number
  sentAt: string
  expiresAt: string | null
  approvedAt: string | null
  declineReason: string | null
  voidReason: string | null
}

export interface SelectionTermsSummary {
  termsHash: string
  totalCents: number
  lineCount: number
  /** Every selection has an option and a price. */
  complete: boolean
  /** Every selection is already confirmed. */
  confirmed: boolean
}

export const SELECTION_APPROVAL_STATE_LABELS: Record<SelectionApprovalState, string> = {
  unsigned: "Not approved",
  sent: "Awaiting buyer",
  declined: "Declined",
  expired: "Expired",
  approved: "Approved",
}

export const SELECTION_APPROVAL_CHANNEL_LABELS: Record<SelectionApprovalChannel, string> = {
  esign: "E-signature",
  portal: "Buyer portal",
  in_person: "Signed in person",
}

/** The newest request decides; requests are never deleted, so history is the rest. */
export function latestApproval<T extends { sentAt: string }>(approvals: T[]): T | null {
  return approvals.reduce<T | null>((latest, approval) => (!latest || approval.sentAt > latest.sentAt ? approval : latest), null)
}

export function selectionApprovalState(latest: SelectionApprovalSummary | null, now: Date): { state: SelectionApprovalState; reason: string | null } {
  if (!latest) return { state: "unsigned", reason: null }
  switch (latest.status) {
    case "voided":
      return { state: "unsigned", reason: latest.voidReason }
    case "declined":
      return { state: "declined", reason: latest.declineReason }
    case "sent":
      // The sweep records the expiry; until it runs the request is already dead.
      return latest.expiresAt && Date.parse(latest.expiresAt) <= now.getTime() ? { state: "expired", reason: null } : { state: "sent", reason: null }
    default:
      return { state: latest.status, reason: null }
  }
}

/**
 * Why a group cannot be sent (or approved in person) right now, in the
 * coordinator's words; null when it can.
 */
export function approvalBlocker(state: SelectionApprovalState, terms: SelectionTermsSummary | null, locked: boolean): string | null {
  if (!terms || terms.lineCount === 0) return "There are no selections to approve."
  if (terms.confirmed || state === "approved") return "Approved. A change now needs a change order."
  if (locked) return "The deadline has passed. A change now needs a change order."
  if (state === "sent") return "Waiting on the buyer. Void the request to change or resend it."
  if (!terms.complete) return "Choose an option for every category first."
  return null
}
