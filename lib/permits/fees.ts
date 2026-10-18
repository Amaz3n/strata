/**
 * What a permit owes the authority against what has been paid. A fee is an
 * obligation on the application; a payment is a bill or an expense to the
 * jurisdiction on the home's job cost, linked to the fee. Mirrors
 * permit_fee_paid_cents / permit_fee_linked_cents in the permits migration,
 * which is what refuses an approval while a fee due before issuance is unpaid.
 */

export const PERMIT_FEE_KINDS = ["plan_review", "permit", "impact", "other"] as const
export type PermitFeeKind = (typeof PERMIT_FEE_KINDS)[number]

export const PERMIT_FEE_KIND_LABELS: Record<PermitFeeKind, string> = {
  plan_review: "Plan review",
  permit: "Permit",
  impact: "Impact",
  other: "Other",
}

export const PERMIT_FEE_DUE = ["submission", "issuance", "certificate_of_occupancy"] as const
export type PermitFeeDue = (typeof PERMIT_FEE_DUE)[number]

export const PERMIT_FEE_DUE_LABELS: Record<PermitFeeDue, string> = {
  submission: "Before submission",
  issuance: "Before issuance",
  certificate_of_occupancy: "Before certificate of occupancy",
}

/** Fees the authority will not issue without. */
const PRE_ISSUANCE_DUE: ReadonlySet<PermitFeeDue> = new Set(["submission", "issuance"])

export interface PermitFeeFact {
  id: string
  kind: PermitFeeKind
  amountCents: number
  status: "open" | "void"
  dueBefore: PermitFeeDue | null
}

export interface PermitFeePaymentFact {
  feeId: string
  source: "bill" | "expense"
  /** Bill total, or expense amount plus tax. */
  totalCents: number
  /** What the bill has had paid; ignored for an expense. */
  paidCents: number
  status: string
}

export interface FeePosition {
  feeId: string
  obligatedCents: number
  /** Payables standing against the fee (rejected ones excluded). */
  linkedCents: number
  paidCents: number
  /** Obligated minus paid: positive is still owed, negative is overpaid. */
  varianceCents: number
  reconciled: boolean
}

function paymentLinkedCents(payment: PermitFeePaymentFact) {
  return payment.status === "rejected" ? 0 : payment.totalCents
}

function paymentPaidCents(payment: PermitFeePaymentFact) {
  if (payment.source === "bill") return payment.status === "rejected" ? 0 : payment.paidCents
  return payment.status === "approved" || payment.status === "locked" ? payment.totalCents : 0
}

export function feePosition(fee: PermitFeeFact, payments: PermitFeePaymentFact[]): FeePosition {
  const mine = payments.filter((payment) => payment.feeId === fee.id)
  const obligatedCents = fee.status === "open" ? fee.amountCents : 0
  const linkedCents = mine.reduce((sum, payment) => sum + paymentLinkedCents(payment), 0)
  const paidCents = mine.reduce((sum, payment) => sum + paymentPaidCents(payment), 0)
  return {
    feeId: fee.id,
    obligatedCents,
    linkedCents,
    paidCents,
    varianceCents: obligatedCents - paidCents,
    reconciled: fee.status === "open" && paidCents === obligatedCents,
  }
}

export interface PermitFeeSummary {
  fees: FeePosition[]
  obligatedCents: number
  paidCents: number
  varianceCents: number
  /** Every open fee paid exactly, and there is at least one. */
  reconciled: boolean
  /** Open fees due before submission or issuance that are not yet paid in full. */
  unpaidPreIssuance: PermitFeeFact[]
}

export function permitFeeSummary(fees: PermitFeeFact[], payments: PermitFeePaymentFact[]): PermitFeeSummary {
  const positions = fees.map((fee) => feePosition(fee, payments))
  const open = positions.filter((position, index) => fees[index].status === "open")
  const obligatedCents = open.reduce((sum, position) => sum + position.obligatedCents, 0)
  const paidCents = open.reduce((sum, position) => sum + position.paidCents, 0)
  return {
    fees: positions,
    obligatedCents,
    paidCents,
    varianceCents: obligatedCents - paidCents,
    reconciled: open.length > 0 && open.every((position) => position.reconciled),
    unpaidPreIssuance: fees.filter((fee, index) =>
      fee.status === "open" && fee.dueBefore !== null && PRE_ISSUANCE_DUE.has(fee.dueBefore) && positions[index].paidCents < fee.amountCents),
  }
}

/** What can still be linked to a fee without paying it twice. */
export function feeRemainingToLinkCents(fee: PermitFeeFact, payments: PermitFeePaymentFact[]) {
  return fee.status === "open" ? Math.max(0, fee.amountCents - feePosition(fee, payments).linkedCents) : 0
}
