/**
 * A connected receivable is an invoice on a sub's books that mirrors a bill the
 * sub submitted in a builder's Arc portal. The builder owns its lifecycle; the
 * sub's side only follows. These helpers are pure so the service, the guards
 * and the billing book all read the mirror the same way.
 */

export interface ConnectedReceivableSource {
  connectionId: string | null
  sourceOrgId: string | null
  sourceOrgName: string
  sourceBillId: string
  sourceStatus: string
  sourcePaidCents: number
  syncedAt: string | null
  needsReview: boolean
}

const BUILDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "Submitted to builder",
  approved: "Approved by builder",
  partial: "Partially paid by builder",
  paid: "Paid by builder",
  rejected: "Rejected by builder",
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** The builder-side source of a mirrored invoice, or null for any other invoice. */
export function connectedReceivableOf(metadata: unknown): ConnectedReceivableSource | null {
  if (!metadata || typeof metadata !== "object") return null
  const raw = (metadata as Record<string, unknown>).connected_receivable
  if (!raw || typeof raw !== "object") return null
  const source = raw as Record<string, unknown>
  const sourceBillId = textOf(source.source_bill_id)
  if (!sourceBillId) return null
  const paid = Number(source.source_paid_cents ?? 0)
  return {
    connectionId: textOf(source.connection_id),
    sourceOrgId: textOf(source.source_org_id),
    sourceOrgName: textOf(source.source_org_name) ?? "the builder",
    sourceBillId,
    sourceStatus: textOf(source.source_status) ?? "pending",
    sourcePaidCents: Number.isFinite(paid) ? paid : 0,
    syncedAt: textOf(source.synced_at),
    needsReview: source.needs_review === true,
  }
}

/** How the builder's status reads on the sub's side. */
export function connectedStatusLabel(status: string): string {
  return BUILDER_STATUS_LABELS[status] ?? "Submitted to builder"
}

/** The refusal shown when someone tries to act on a mirrored invoice by hand. */
export function connectedReceivableRefusal(source: ConnectedReceivableSource): string {
  return `This invoice is managed in ${source.sourceOrgName}'s portal. Its status follows what the builder records.`
}

/** Throws the standard refusal when the invoice is a mirror; call from every user-driven mutation. */
export function assertNotConnectedReceivable(metadata: unknown): void {
  const source = connectedReceivableOf(metadata)
  if (source) throw new Error(connectedReceivableRefusal(source))
}

export interface ConnectedSyncPlan {
  /** A new mirror invoice must be issued (none exists, or the old one was replaced). */
  create: boolean
  /** The existing mirror must be voided, and why. */
  voidReason: "rejected" | "amount_changed" | null
  /** What the builder has paid since the mirror last heard, in cents. */
  paymentDeltaCents: number
  /** A person has to look: money moved in a way the mirror will not follow on its own. */
  needsReview: boolean
}

/**
 * What one sync must do, from the builder's bill and the mirror's last-known
 * state. Money never moves backwards on its own: a smaller paid amount, or a
 * change to a bill that is already partly paid, is flagged for review instead.
 */
export function planConnectedSync(
  bill: { status: string; totalCents: number; paidCents: number },
  mirror: { totalCents: number; sourcePaidCents: number } | null,
): ConnectedSyncPlan {
  const rejected = bill.status === "rejected"
  if (!mirror) {
    return rejected
      ? { create: false, voidReason: null, paymentDeltaCents: 0, needsReview: false }
      : { create: true, voidReason: null, paymentDeltaCents: Math.max(bill.paidCents, 0), needsReview: false }
  }
  const settled = mirror.sourcePaidCents > 0
  if (rejected) {
    return settled
      ? { create: false, voidReason: null, paymentDeltaCents: 0, needsReview: true }
      : { create: false, voidReason: "rejected", paymentDeltaCents: 0, needsReview: false }
  }
  if (bill.totalCents !== mirror.totalCents) {
    return settled
      ? { create: false, voidReason: null, paymentDeltaCents: 0, needsReview: true }
      : { create: true, voidReason: "amount_changed", paymentDeltaCents: Math.max(bill.paidCents, 0), needsReview: false }
  }
  if (bill.paidCents < mirror.sourcePaidCents) {
    return { create: false, voidReason: null, paymentDeltaCents: 0, needsReview: true }
  }
  return { create: false, voidReason: null, paymentDeltaCents: bill.paidCents - mirror.sourcePaidCents, needsReview: false }
}
