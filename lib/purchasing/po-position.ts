/**
 * Where a purchase order stands: what it authorizes (PO plus approved variance
 * orders), what has been billed and paid against it, and what the books say is
 * wrong. Pure so the rules are testable; the numbers come from the
 * `purchase_order_positions` view, which mirrors `approve_po_completion` and the
 * payment-release evidence in `lib/services/payment-holds.ts`.
 */

export type PoPosition = {
  commitmentId: string
  projectId: string
  title: string
  contractNumber: string | null
  companyId: string | null
  status: string
  divisionId: string | null
  communityId: string | null
  payOnPo: boolean
  originalCents: number
  approvedVpoCents: number
  pendingVpoCount: number
  billedCents: number
  paidCents: number
  retainageHeldCents: number
  completionBilledCents: number
  openCompletionCount: number
  unclaimedVpoCents: number
}

export type PoPositionExceptionKind = "overbilled" | "paid_exceeds_billed" | "billed_without_completion" | "vpo_unbilled"

export type PoPositionException = { kind: PoPositionExceptionKind; cents: number }

export const PO_POSITION_EXCEPTION_LABELS: Record<PoPositionExceptionKind, string> = {
  overbilled: "Billed over the approved total",
  paid_exceeds_billed: "Paid more than billed",
  billed_without_completion: "Billed without a field completion",
  vpo_unbilled: "Approved variance order not billed",
}

export function poRevisedCents(position: Pick<PoPosition, "originalCents" | "approvedVpoCents">) {
  return position.originalCents + position.approvedVpoCents
}

export function poRemainingCents(position: Pick<PoPosition, "originalCents" | "approvedVpoCents" | "billedCents">) {
  return poRevisedCents(position) - position.billedCents
}

export function classifyPoPosition(position: PoPosition): PoPositionException[] {
  const found: PoPositionException[] = []
  const revised = poRevisedCents(position)
  if (position.billedCents > revised) found.push({ kind: "overbilled", cents: position.billedCents - revised })
  if (position.paidCents > position.billedCents) found.push({ kind: "paid_exceeds_billed", cents: position.paidCents - position.billedCents })
  if (position.payOnPo && position.billedCents > position.completionBilledCents) {
    found.push({ kind: "billed_without_completion", cents: position.billedCents - position.completionBilledCents })
  }
  if (position.payOnPo && position.unclaimedVpoCents > 0) found.push({ kind: "vpo_unbilled", cents: position.unclaimedVpoCents })
  return found
}
