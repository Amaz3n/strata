/** For one reviewed construction contract using cost-to-cost recognition. */
export function expectedContractLoss(input: { contractCents: number; eacCents: number; costCents: number; earnedCents: number }) {
  for (const value of Object.values(input)) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Loss provision inputs must be nonnegative integer cents")
  if (input.eacCents < input.costCents) throw new Error("EAC cannot be below incurred cost")
  const totalExpectedLossCents = Math.max(0, input.eacCents - input.contractCents)
  const incurredLossCents = Math.max(0, input.costCents - input.earnedCents)
  return { totalExpectedLossCents, incurredLossCents, reserveCents: Math.max(0, totalExpectedLossCents - incurredLossCents) }
}
