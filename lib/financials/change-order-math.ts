export type ChangeOrderCostLine = {
  quantity: number
  internalCostCents: number | null
}

export function changeOrderCostTotal(lines: ChangeOrderCostLine[]): number | null {
  const costed = lines.filter((line) => line.internalCostCents != null)
  if (costed.length === 0) return null
  return costed.reduce((sum, line) => sum + (line.internalCostCents ?? 0), 0)
}

export function deriveOwnerPriceCents(internalCostCents: number, markupPercent: number): number {
  return Math.round(internalCostCents * (1 + markupPercent / 100))
}

export function deriveOwnerUnitPriceCents({
  internalCostCents,
  quantity,
  markupPercent,
}: {
  internalCostCents: number
  quantity: number
  markupPercent: number
}): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Quantity must be greater than zero")
  }
  return Math.round(deriveOwnerPriceCents(internalCostCents, markupPercent) / quantity)
}

export function changeOrderMarginCents(priceCents: number, costCents: number | null): number | null {
  return costCents == null ? null : priceCents - costCents
}
