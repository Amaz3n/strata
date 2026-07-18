import type { InvoiceTotals } from "@/lib/types"

/**
 * Canonical invoice money math, shared by the server write path and every
 * client preview. Pure and framework-free — safe to import from client
 * components. Any change here changes what invoices charge; keep the draw
 * regression suite green (pnpm test:financials).
 */

export type InvoiceDiscountInput = { type: "percent" | "fixed"; value: number } | null

export interface InvoiceTotalsLine {
  quantity: number
  unit_cost_cents: number
  taxable?: boolean | null
  /** Per-line tax rate override (%). Null/undefined inherits the invoice-level rate. */
  tax_rate_percent?: number | null
}

/**
 * Invoice math, in order: subtotal → invoice-level discount (spread proportionally across
 * lines) → tax per line (line override rate wins over the invoice rate) → total.
 */
export function calculateInvoiceTotals(
  lines: InvoiceTotalsLine[],
  taxRate = 0,
  discount: InvoiceDiscountInput = null,
): InvoiceTotals {
  const subtotal_cents = lines.reduce((sum, line) => {
    return sum + Math.round(line.quantity * line.unit_cost_cents)
  }, 0)

  let discount_cents = 0
  if (discount && discount.value > 0 && subtotal_cents > 0) {
    discount_cents =
      discount.type === "percent"
        ? Math.round(subtotal_cents * (Math.min(discount.value, 100) / 100))
        : Math.min(Math.round(discount.value * 100), subtotal_cents)
  }
  const discountRatio = subtotal_cents > 0 ? discount_cents / subtotal_cents : 0

  const taxExact = lines.reduce((sum, line) => {
    if (line.taxable === false) return sum
    const lineSubtotal = Math.round(line.quantity * line.unit_cost_cents)
    const effectiveRate = line.tax_rate_percent ?? taxRate
    return sum + lineSubtotal * (1 - discountRatio) * (effectiveRate / 100)
  }, 0)

  const tax_cents = Math.round(taxExact)
  const total_cents = subtotal_cents - discount_cents + tax_cents

  return {
    subtotal_cents,
    tax_cents,
    total_cents,
    balance_due_cents: total_cents,
    tax_rate: taxRate,
    discount_cents,
    discount_type: discount?.type ?? null,
    discount_value: discount?.value ?? null,
  }
}

/**
 * Retainage held on an invoice: a percentage of the discounted pre-tax base.
 * Mirrors the server's source-billing derivation for the manual/contract path.
 */
export function deriveRetainageCents(subtotalCents: number, discountCents: number, retainagePercent: number): number {
  if (!Number.isFinite(retainagePercent) || retainagePercent <= 0) return 0
  return Math.round(Math.max(subtotalCents - discountCents, 0) * (retainagePercent / 100))
}
