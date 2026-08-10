/**
 * Invoice arithmetic, kept pure on purpose.
 *
 * This is the gate that decides whether an extracted invoice is trustworthy
 * enough to show a bookkeeper. It has no model, no network and no Supabase in
 * it, so it can be tested exhaustively — which is the only reason it is safe to
 * let it block a read from reaching the ledger.
 */

/** Line sums may drift from the printed total by this much before we distrust it. */
export const RECONCILE_TOLERANCE_CENTS = 100

export interface ReconcileLine {
  amountCents: number
  quantity: number | null
  unitPriceCents: number | null
}

export interface ReconcileInput {
  totalCents: number | null
  subtotalCents: number | null
  taxCents: number | null
  lines: ReconcileLine[]
}

export interface ReconcileResult {
  ok: boolean
  message?: string
  lineSumCents: number
}

/**
 * Currency units to integer cents.
 *
 * The model reports the decimal number printed on the page, and this is the only
 * place the unit is decided. The predecessor asked the model for integer cents
 * and inferred the unit from whether a decimal point was present, so a total
 * printed as "1234" was read as $12.34.
 */
export function toCents(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return Math.round(value * 100)
}

/**
 * The continuation-sheet arithmetic on an AIA G702-style payment application.
 * Every field here is printed on the form, and the form's own footing rules say
 * how they relate — which makes a pay app the most checkable document in AP.
 */
export interface PayApplicationReconcileInput {
  previousCompletedCents: number | null
  thisPeriodCents: number | null
  materialsStoredCents: number | null
  totalCompletedStoredCents: number | null
  retainageCents: number | null
  totalEarnedLessRetainageCents: number | null
  lessPreviousCertificatesCents: number | null
  currentPaymentDueCents: number | null
}

export function reconcilePayApplication(input: PayApplicationReconcileInput): ReconcileResult {
  const lineSumCents = 0

  // Line 4: previous + this period + stored = total completed and stored.
  if (
    input.previousCompletedCents !== null &&
    input.thisPeriodCents !== null &&
    input.totalCompletedStoredCents !== null
  ) {
    const composed =
      input.previousCompletedCents + input.thisPeriodCents + (input.materialsStoredCents ?? 0)
    if (Math.abs(composed - input.totalCompletedStoredCents) > RECONCILE_TOLERANCE_CENTS) {
      return {
        ok: false,
        lineSumCents,
        message: `Previous plus this period plus stored materials is ${(composed / 100).toFixed(2)} but total completed and stored reads ${(input.totalCompletedStoredCents / 100).toFixed(2)}.`,
      }
    }
  }

  // Line 6: total completed and stored less retainage = total earned.
  if (
    input.totalCompletedStoredCents !== null &&
    input.retainageCents !== null &&
    input.totalEarnedLessRetainageCents !== null
  ) {
    const composed = input.totalCompletedStoredCents - input.retainageCents
    if (Math.abs(composed - input.totalEarnedLessRetainageCents) > RECONCILE_TOLERANCE_CENTS) {
      return {
        ok: false,
        lineSumCents,
        message: `Total completed less retainage is ${(composed / 100).toFixed(2)} but total earned less retainage reads ${(input.totalEarnedLessRetainageCents / 100).toFixed(2)}.`,
      }
    }
  }

  // Line 8: total earned less previous certificates = current payment due.
  // This is the number that actually gets paid, so it is the one that matters.
  if (
    input.totalEarnedLessRetainageCents !== null &&
    input.lessPreviousCertificatesCents !== null &&
    input.currentPaymentDueCents !== null
  ) {
    const composed = input.totalEarnedLessRetainageCents - input.lessPreviousCertificatesCents
    if (Math.abs(composed - input.currentPaymentDueCents) > RECONCILE_TOLERANCE_CENTS) {
      return {
        ok: false,
        lineSumCents,
        message: `Total earned less previous certificates is ${(composed / 100).toFixed(2)} but current payment due reads ${(input.currentPaymentDueCents / 100).toFixed(2)}.`,
      }
    }
  }

  return { ok: true, lineSumCents }
}

export function reconcileInvoice(input: ReconcileInput): ReconcileResult {
  const lineSumCents = input.lines.reduce((sum, line) => sum + line.amountCents, 0)

  // Subtotal + tax should equal total whenever all three are printed. Checked
  // first because it is true regardless of whether any lines were extracted.
  if (input.subtotalCents !== null && input.taxCents !== null && input.totalCents !== null) {
    const composed = input.subtotalCents + input.taxCents
    if (Math.abs(composed - input.totalCents) > RECONCILE_TOLERANCE_CENTS) {
      return {
        ok: false,
        lineSumCents,
        message: `Subtotal plus tax is ${(composed / 100).toFixed(2)} but the total reads ${(input.totalCents / 100).toFixed(2)}.`,
      }
    }
  }

  if (input.lines.length === 0 || input.totalCents === null) {
    return { ok: true, lineSumCents }
  }

  // Vendors differ on whether printed lines are pre-tax or tax-inclusive, and
  // the document rarely says which. Accept either reading rather than inventing
  // a rule that would reject half of a legitimate corpus.
  const preTaxTarget = input.taxCents !== null ? input.totalCents - input.taxCents : null
  const matchesTotal = Math.abs(lineSumCents - input.totalCents) <= RECONCILE_TOLERANCE_CENTS
  const matchesPreTax = preTaxTarget !== null && Math.abs(lineSumCents - preTaxTarget) <= RECONCILE_TOLERANCE_CENTS

  if (!matchesTotal && !matchesPreTax) {
    return {
      ok: false,
      lineSumCents,
      message: `Line amounts sum to ${(lineSumCents / 100).toFixed(2)} but the invoice total reads ${(input.totalCents / 100).toFixed(2)}.`,
    }
  }

  // Per-line arithmetic, only where the vendor printed enough to check it.
  for (const [index, line] of input.lines.entries()) {
    if (line.quantity === null || line.unitPriceCents === null) continue
    const expected = Math.round(line.quantity * line.unitPriceCents)
    if (Math.abs(expected - line.amountCents) > RECONCILE_TOLERANCE_CENTS) {
      return {
        ok: false,
        lineSumCents,
        message: `Line ${index + 1} shows quantity times unit price as ${(expected / 100).toFixed(2)} but its amount reads ${(line.amountCents / 100).toFixed(2)}.`,
      }
    }
  }

  return { ok: true, lineSumCents }
}
