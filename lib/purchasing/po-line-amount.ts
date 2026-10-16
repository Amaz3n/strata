/**
 * What one purchase-order line is worth, in whole cents. A line's extended amount
 * is unit price times quantity, rounded half up to a cent, and an order's total is
 * the sum of its lines' rounded amounts. This is the same rule the database applies
 * (write_commitment_line, approval) and PO generation stores in scheduled_value_cents,
 * so the order, its email, its portal view and its PDF can never disagree by a cent.
 */

interface PoLineAmountInput {
  quantity: number | null
  unit_cost_cents: number | null
}

/** unit_cost_cents x quantity, rounded half up. Toward the cent a decimal sum would give, not a float's noise. */
export function extendedLineCents(line: PoLineAmountInput): number {
  const raw = (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
  return Math.round(Number(raw.toFixed(6)))
}

/** The amount shown for a line: the stored scheduled value, or the extended price when none was stored. */
export function poLineAmountCents(line: PoLineAmountInput & { scheduled_value_cents: number | null }): number {
  return line.scheduled_value_cents ?? extendedLineCents(line)
}

/** An order's total: the sum of its lines' extended amounts. */
export function poLinesTotalCents(lines: PoLineAmountInput[]): number {
  return lines.reduce((sum, line) => sum + extendedLineCents(line), 0)
}
