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

export interface RetainageBaseLine {
  quantity: number
  unit_cost_cents: number
  unit?: string | null
  description?: string | null
  metadata?: Record<string, unknown> | null
}

/** A system-appended retainage hold line (negative, non-taxable). */
export function isSystemGeneratedRetainageLine(line: Pick<RetainageBaseLine, "description" | "unit">) {
  const normalizedUnit = String(line.unit ?? "").toLowerCase()
  const normalizedDescription = String(line.description ?? "").toLowerCase()
  return normalizedUnit === "retainage" || normalizedDescription.startsWith("retainage held")
}

export function isInvoiceFeeLine(line: Pick<RetainageBaseLine, "unit" | "metadata">) {
  return String(line.unit ?? "").toLowerCase() === "fee" || Boolean((line.metadata ?? {})?.fee_line_kind)
}

export interface RetainageAwareTotalsLine extends InvoiceTotalsLine {
  unit?: string | null
  description?: string | null
}

/**
 * Totals for a line set that may carry a system-generated retainage hold line.
 * Subtotal, discount, and tax are computed on the GROSS billing base (retainage
 * is not a discount and must not shrink the discount/tax base); the hold then
 * nets off the total. This is what the composer preview shows: gross subtotal,
 * discount and tax on gross, retainage as a final deduction.
 */
export function calculateInvoiceTotalsWithRetainage(
  lines: RetainageAwareTotalsLine[],
  taxRate = 0,
  discount: InvoiceDiscountInput = null,
): InvoiceTotals {
  const retainageCents = lines
    .filter((line) => isSystemGeneratedRetainageLine(line))
    .reduce((sum, line) => sum + Math.round(line.quantity * line.unit_cost_cents), 0)
  const base = calculateInvoiceTotals(
    lines.filter((line) => !isSystemGeneratedRetainageLine(line)),
    taxRate,
    discount,
  )
  const total_cents = base.total_cents + retainageCents
  return { ...base, total_cents, balance_due_cents: total_cents }
}

/**
 * Retainage held on a manual/draw/change-order invoice: a percentage of the
 * gross billing base — system retainage lines stripped, fee lines excluded
 * unless the contract retains on fee, and no discount subtraction. This is the
 * single derivation for both the server write path and the composer preview.
 */
export function deriveManualRetainageCents(
  lines: RetainageBaseLine[],
  retainagePercent: number,
  retainageAppliesToFee: boolean,
): number {
  if (!Number.isFinite(retainagePercent) || retainagePercent <= 0) return 0
  const grossAmountCents = lines
    .filter((line) => !isSystemGeneratedRetainageLine(line))
    .filter((line) => retainageAppliesToFee || !isInvoiceFeeLine(line))
    .reduce((sum, line) => sum + Math.round(line.quantity * line.unit_cost_cents), 0)
  return Math.round(Math.max(grossAmountCents, 0) * (retainagePercent / 100))
}
