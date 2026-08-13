/** Convert an explicitly dollar-denominated value to integer cents. */
export function dollarsToCents(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Money amount must be finite")
  return Math.round(value * 100)
}
