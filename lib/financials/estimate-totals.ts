/**
 * Single source of truth for estimate money math. Every place that turns
 * estimate lines into cents (service writes, portal display, PDF, client
 * acceptance, conversion) must go through these helpers so rounding and
 * tax policy stay identical everywhere.
 *
 * Policy:
 * - A line's extended amount is qty × unit cost, plus per-line markup,
 *   rounded once per line.
 * - Group headers carry no amount. Optional add-ons are excluded from the
 *   base subtotal and priced individually when accepted.
 * - Tax applies to the base subtotal and, at acceptance time, to accepted
 *   optional add-ons at the same rate.
 */

export interface EstimateMoneyLine {
  item_type?: string | null
  quantity?: number | null
  unit_cost_cents?: number | null
  markup_pct?: number | null
  is_optional?: boolean
}

export interface EstimateTotals {
  subtotal: number
  /** Contingency on the base subtotal; 0 when the estimate carries none. */
  contingency: number
  tax: number
  total: number
}

export interface AcceptedOptions {
  ids: string[]
  /** Pre-tax sum of the accepted optional add-ons. Absent on rows signed before tax-on-options shipped. */
  optional_subtotal_cents?: number
  /** Tax charged on the accepted add-ons (same rate as the base document). Absent on legacy rows. */
  optional_tax_cents?: number
  /** Tax-inclusive add-on amount (pre-tax on legacy rows). */
  optional_total_cents: number
  base_total_cents: number
  accepted_total_cents: number
}

/** Extended amount for a line: qty × unit cost, plus markup. Groups have no amount. */
export function estimateLineAmountCents(line: EstimateMoneyLine): number | null {
  if ((line.item_type ?? "line") === "group") return null
  const base = (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
  return Math.round(base + (base * (line.markup_pct ?? 0)) / 100)
}

/**
 * Base document totals: optional add-ons and group headers never contribute.
 * Contingency is a percentage of the base subtotal, added before tax so it is
 * taxed like any other scope; optional add-ons never carry contingency.
 */
export function calculateEstimateTotals(
  lines: EstimateMoneyLine[],
  taxRate = 0,
  contingencyPct = 0,
): EstimateTotals {
  const subtotal = lines.reduce((sum, line) => {
    if (line.is_optional) return sum
    return sum + (estimateLineAmountCents(line) ?? 0)
  }, 0)
  const contingency = Math.round((subtotal * (contingencyPct ?? 0)) / 100)
  const tax = Math.round(((subtotal + contingency) * (taxRate ?? 0)) / 100)
  return { subtotal, contingency, tax, total: subtotal + contingency + tax }
}

/**
 * Alternates: optional add-ons in the same `metadata.option_group` are
 * mutually exclusive ("pick one of three"). Returns an error message when the
 * selection violates that, else null. Runs server-side before acceptance.
 */
export function validateOptionGroups(
  items: Array<{ id: string; item_type?: string | null; metadata?: Record<string, unknown> | null }>,
  selectedIds: string[],
): string | null {
  const selected = new Set(selectedIds)
  const seenGroups = new Map<string, string>()
  for (const item of items ?? []) {
    if ((item.item_type ?? "line") === "group") continue
    if (!item.metadata?.is_optional || !selected.has(item.id)) continue
    const group = typeof item.metadata?.option_group === "string" ? item.metadata.option_group.trim() : ""
    if (!group) continue
    const prior = seenGroups.get(group)
    if (prior) {
      return `Choose one option in “${group}” — not more than one.`
    }
    seenGroups.set(group, item.id)
  }
  return null
}

export function estimateOptionTaxCents(optionalSubtotalCents: number, taxRate = 0): number {
  return Math.round((optionalSubtotalCents * (taxRate ?? 0)) / 100)
}

/**
 * Recomputes which optional add-ons a client accepted and the resulting total,
 * authoritatively, from the persisted line items (never trusting a client total).
 * `items` are estimate_items rows (optionality lives in metadata.is_optional).
 */
export function resolveAcceptedOptions(
  items: Array<EstimateMoneyLine & { id: string; metadata?: Record<string, unknown> | null }>,
  baseTotalCents: number,
  selectedIds: string[],
  taxRate = 0,
): AcceptedOptions {
  const selected = new Set(selectedIds)
  const ids: string[] = []
  let optionalSubtotal = 0
  for (const it of items ?? []) {
    if ((it.item_type ?? "line") === "group") continue
    if (!it.metadata?.is_optional) continue
    if (selected.has(it.id)) {
      ids.push(it.id)
      optionalSubtotal += estimateLineAmountCents(it) ?? 0
    }
  }
  const optionalTax = estimateOptionTaxCents(optionalSubtotal, taxRate)
  const optionalTotal = optionalSubtotal + optionalTax
  return {
    ids,
    optional_subtotal_cents: optionalSubtotal,
    optional_tax_cents: optionalTax,
    optional_total_cents: optionalTotal,
    base_total_cents: baseTotalCents,
    accepted_total_cents: baseTotalCents + optionalTotal,
  }
}
