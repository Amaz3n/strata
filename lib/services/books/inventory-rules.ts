/** Owned-property accounting is an explicit project policy, independent of org tier. */
export type InventoryPolicy = { enabled: boolean; effectiveOn: string | null; completedOn: string | null; soldOn: string | null }
export function inventoryCostAccount(policy: InventoryPolicy | undefined, incurredOn: string, expenseAccount = "5000") {
  if (!policy?.enabled || !policy.effectiveOn || incurredOn < policy.effectiveOn) return expenseAccount
  if (policy.soldOn && incurredOn >= policy.soldOn) return expenseAccount
  if (policy.completedOn && incurredOn >= policy.completedOn) return "1170"
  return "1160"
}

/** Largest-remainder allocation: exact cents, stable ties, and no synthetic cost. */
export function allocateInventoryCost(amountCents: number, weights: Array<{ id: string; weight: number }>) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || weights.length === 0 || new Set(weights.map(row => row.id)).size !== weights.length || weights.some(row => !Number.isFinite(row.weight) || row.weight <= 0)) throw new Error("Allocation requires positive cents and unique positive weights")
  const total = weights.reduce((sum, row) => sum + row.weight, 0)
  const shares = weights.map(row => ({ ...row, exact: amountCents * row.weight / total, amountCents: Math.floor(amountCents * row.weight / total) }))
  let remaining = amountCents - shares.reduce((sum, row) => sum + row.amountCents, 0)
  for (const row of [...shares].sort((a,b) => (b.exact - b.amountCents) - (a.exact - a.amountCents) || a.id.localeCompare(b.id))) { if (remaining-- <= 0) break; row.amountCents++ }
  return shares.map(({ id, amountCents }) => ({ id, amountCents })).sort((a,b) => a.id.localeCompare(b.id))
}
