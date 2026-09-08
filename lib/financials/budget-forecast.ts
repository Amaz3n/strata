/** A commitment bill consumes the obligation; it is not a second cost. */
export function outstandingObligationCents(committed: number, billed: number, pendingBills: number): number {
  return Math.max(0, committed - billed, pendingBills)
}

export function forecastBudgetCost(args: {
  revisedBudgetCents: number
  actualCents: number
  outstandingObligationsCents: number
  additionalPendingCents: number
  estimateRemainingCents: number | null
}) {
  const knownFinalCostCents = args.actualCents + args.outstandingObligationsCents + args.additionalPendingCents
  const eacCents = args.estimateRemainingCents == null
    ? Math.max(args.revisedBudgetCents, args.actualCents, knownFinalCostCents)
    : args.actualCents + args.estimateRemainingCents
  return { eacCents, knownFinalCostCents, belowKnownObligations: eacCents < knownFinalCostCents }
}
