/** Allocate contract dollars over a proposed billing structure, preserving cents.
 * Costs are weights only; they never become the contractual value by accident.
 */
export function allocateContractValue(weights: number[], contractCents: number): number[] {
  if (!Number.isSafeInteger(contractCents) || contractCents <= 0) throw new Error("A positive contract value is required")
  if (weights.some((weight) => !Number.isSafeInteger(weight))) throw new Error("Billing allocation weights must be integer cents")
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total <= 0 || !Number.isSafeInteger(total)) throw new Error("Add positive billing values before allocating the contract")
  const denominator = BigInt(total)
  const numerators = weights.map((weight) => BigInt(weight) * BigInt(contractCents))
  const allocated = numerators.map((value) => Number(value / denominator - (value % denominator < BigInt(0) ? BigInt(1) : BigInt(0))))
  let remainder = contractCents - allocated.reduce((sum, value) => sum + value, 0)
  const order = numerators.map((value, index) => ({ index, remainder: (value % denominator + denominator) % denominator }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)
  for (const row of order) {
    if (remainder-- <= 0) break
    allocated[row.index] += 1
  }
  return allocated
}
