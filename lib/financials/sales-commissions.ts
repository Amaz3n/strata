/**
 * Commission math (EP05-06). Pure and client-safe: the agreement sheet estimates
 * with it, settlement derives what is owed with it, and the closing reversal
 * decides how to take a commission back with it. Money is integer cents; rates
 * are basis points (2.5% is 250).
 *
 * `record_sales_commission_payables` re-derives every amount in SQL and refuses a
 * disagreement, so the basis and rounding here are a contract with that function.
 */

export const COMMISSION_KINDS = ["coop_broker", "sales_consultant"] as const
export type CommissionKind = (typeof COMMISSION_KINDS)[number]

export const COMMISSION_PAYOUT_CHANNELS = ["accounts_payable", "payroll"] as const
export type CommissionPayoutChannel = (typeof COMMISSION_PAYOUT_CHANNELS)[number]

export const COMMISSION_BASES = ["percent_of_authorized_price", "flat"] as const
export type CommissionBasis = (typeof COMMISSION_BASES)[number]

/** The rate ceiling the database enforces: anything above is a typo, not a commission. */
export const MAX_COMMISSION_RATE_BPS = 1500

export type CommissionTerms = {
  basis: CommissionBasis
  rateBps: number | null
  flatCents: number | null
}

export type CommissionPlanLine = CommissionTerms & {
  id: string
  lineNo: number
  kind: CommissionKind
  payoutChannel: CommissionPayoutChannel
}

/** The part of a recorded settlement the basis reads. */
export type CommissionSettlement = {
  contractId: string
  components: { agreementTotalCents: number; approvedChangeOrdersCents: number; adjustmentsCents: number; changeOrderIds: string[] }
}

/**
 * The authorized price: the agreement plus every buyer-signed change order.
 * Closing-table adjustments (seller credits, closing costs, prorations) are
 * negotiated at settlement, after the broker's terms were fixed, and are not price.
 */
export function commissionBasisCents(settlement: Pick<CommissionSettlement, "components">): number {
  const basis = settlement.components.agreementTotalCents + settlement.components.approvedChangeOrdersCents
  if (!Number.isSafeInteger(basis) || basis < 0) throw new Error("The authorized price is not a valid commission basis")
  return basis
}

/** Half-up to the cent on integers, so a rate on a seven-figure price never drifts. */
export function commissionAmountCents(terms: CommissionTerms, basisCents: number): number {
  if (terms.basis === "flat") {
    if (terms.flatCents === null || !Number.isSafeInteger(terms.flatCents) || terms.flatCents <= 0) throw new Error("A flat commission needs a positive amount")
    return terms.flatCents
  }
  if (terms.rateBps === null || !Number.isInteger(terms.rateBps) || terms.rateBps < 1 || terms.rateBps > MAX_COMMISSION_RATE_BPS) {
    throw new Error(`A commission rate is between 0.01% and ${MAX_COMMISSION_RATE_BPS / 100}%`)
  }
  if (!Number.isSafeInteger(basisCents) || basisCents < 0) throw new Error("The commission basis is invalid")
  const amount = (BigInt(basisCents) * BigInt(terms.rateBps) + BigInt(5000)) / BigInt(10000)
  return Number(amount)
}

/** Before settlement: what each line would owe on today's authorized price. */
export function estimateCommissions(lines: Array<CommissionTerms & { lineNo: number }>, authorizedPriceCents: number) {
  const estimates = lines.map((line) => ({ lineNo: line.lineNo, amountCents: commissionAmountCents(line, authorizedPriceCents) }))
  return { lines: estimates, totalCents: estimates.reduce((sum, line) => sum + line.amountCents, 0) }
}

export type DerivedCommissionObligation = {
  planLineId: string
  lineNo: number
  kind: CommissionKind
  payoutChannel: CommissionPayoutChannel
  basisPriceCents: number
  amountCents: number
  /** What the amount was derived from; the service hashes it into the evidence digest. */
  evidence: {
    kind: "sales-commission-v1"
    closingId: string
    contractId: string
    planId: string
    planRevision: number
    planLineId: string
    basis: CommissionBasis
    rateBps: number | null
    flatCents: number | null
    basisPriceCents: number
    changeOrderIds: string[]
    amountCents: number
  }
}

/** Settlement: one obligation per approved line, keyed by the closing. */
export function deriveCommissionObligations(input: {
  closingId: string
  plan: { id: string; revision: number }
  lines: CommissionPlanLine[]
  settlement: CommissionSettlement
}): DerivedCommissionObligation[] {
  const basisPriceCents = commissionBasisCents(input.settlement)
  const changeOrderIds = [...input.settlement.components.changeOrderIds].sort()
  return [...input.lines]
    .sort((left, right) => left.lineNo - right.lineNo)
    .map((line) => {
      const amountCents = commissionAmountCents(line, basisPriceCents)
      return {
        planLineId: line.id,
        lineNo: line.lineNo,
        kind: line.kind,
        payoutChannel: line.payoutChannel,
        basisPriceCents,
        amountCents,
        evidence: {
          kind: "sales-commission-v1",
          closingId: input.closingId,
          contractId: input.settlement.contractId,
          planId: input.plan.id,
          planRevision: input.plan.revision,
          planLineId: line.id,
          basis: line.basis,
          rateBps: line.rateBps,
          flatCents: line.flatCents,
          basisPriceCents,
          changeOrderIds,
          amountCents,
        },
      }
    })
}

export type CommissionUnwind =
  | { action: "clear" }
  | { action: "credit"; creditCents: number; applyToBillCents: number; openCreditCents: number }
  | { action: "refuse"; reason: string }

/**
 * How a reversed closing takes back one AP commission. Nothing paid: the bill is
 * rejected. Anything paid: one credit for the whole bill closes what is unpaid and
 * stays open for what was paid, so the payee's next payment nets it. A bill in a
 * payment run is refused: the run would pay it regardless.
 */
export function commissionUnwindPlan(bill: { totalCents: number; paidCents: number; retainageCents?: number; inActiveRun: boolean }): CommissionUnwind {
  if (bill.inActiveRun) return { action: "refuse", reason: "The commission payable is in a payment run; remove it from the run first" }
  if (bill.paidCents <= 0) return { action: "clear" }
  const applyToBillCents = Math.max(bill.totalCents - (bill.retainageCents ?? 0) - bill.paidCents, 0)
  return { action: "credit", creditCents: bill.totalCents, applyToBillCents, openCreditCents: bill.totalCents - applyToBillCents }
}

/**
 * Who may approve a waiting plan: a second person, never a payee. "No
 * commissions" waits for approval only when it replaces approved terms with
 * lines (otherwise it stood at once), and taking those terms away is decided
 * the same way.
 */
export function commissionApprovalRefusal(input: {
  actorUserId: string
  proposedBy: string
  payeeUserIds: Array<string | null>
  canApprove: boolean
}): string | null {
  if (!input.canApprove) return "Approving commission terms needs the commission approval permission"
  if (input.actorUserId === input.proposedBy) return "The person who proposed commission terms cannot approve them"
  if (input.payeeUserIds.includes(input.actorUserId)) return "A payee cannot approve their own commission"
  return null
}

export type CommissionPlanStatus = "proposed" | "approved" | "superseded" | "void"

/** What holds a sale. Shared by the signing hold and the closing gate. */
export function commissionPlanRefusal(plan: { status: CommissionPlanStatus } | null, moment: "signing" | "closing"): string | null {
  if (!plan) {
    return moment === "signing"
      ? "Set the agreement's commissions, or declare none, before it goes out for signature"
      : "Set the agreement's commissions, or declare none, before closing"
  }
  if (plan.status !== "approved") {
    return moment === "signing"
      ? "Waiting for commission approval before the agreement goes out for signature"
      : "The agreement's commission terms are waiting for approval"
  }
  return null
}
