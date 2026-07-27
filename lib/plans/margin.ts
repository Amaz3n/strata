/**
 * House-level gross margin below which a plan is flagged: price less direct
 * construction cost and the lot basis it sits on. Indirects, financing, overhead
 * and sales commission still come out of what is left, and those run 12–16% of
 * price, so a plan holding under 18% here is not paying for itself.
 *
 * Lives outside `lib/services` so client components can read it without dragging
 * the server-only plan service into the browser bundle.
 */
export const THIN_MARGIN_PCT = 18

/** The band above which a plan is comfortably profitable rather than merely viable. */
export const HEALTHY_MARGIN_PCT = 22

/**
 * Price less cost of sales — construction plus land — as a percentage of price.
 * Null unless both halves are known: a build-only figure sitting beside one that
 * includes land reads as a much healthier plan than it is.
 */
export function grossMarginPct({
  priceCents,
  buildCostCents,
  lotBasisCents,
}: {
  priceCents: number | null
  buildCostCents: number | null
  lotBasisCents: number | null
}): number | null {
  if (buildCostCents == null || lotBasisCents == null || !priceCents) return null
  return ((priceCents - buildCostCents - lotBasisCents) / priceCents) * 100
}

/**
 * Above this the number stops being good news. A production house sold at a
 * genuine 32% gross — after land — does not exist; what exists is a takeoff
 * missing whole divisions. Reading it as "healthy" is how an incomplete cost
 * basis survives all the way to a released version.
 */
export const IMPLAUSIBLE_MARGIN_PCT = 32

export type MarginBand = "unknown" | "underwater" | "thin" | "healthy" | "strong" | "implausible"

export function marginBand(pct: number | null): MarginBand {
  if (pct == null) return "unknown"
  if (pct < 0) return "underwater"
  if (pct < THIN_MARGIN_PCT) return "thin"
  if (pct < HEALTHY_MARGIN_PCT) return "healthy"
  if (pct < IMPLAUSIBLE_MARGIN_PCT) return "strong"
  return "implausible"
}

export const MARGIN_BAND_META: Record<MarginBand, { label: string; text: string; fill: string }> = {
  unknown: { label: "No cost basis", text: "text-muted-foreground", fill: "bg-muted" },
  underwater: { label: "Underwater", text: "text-destructive", fill: "bg-destructive/30" },
  thin: { label: "Thin", text: "text-warning", fill: "bg-warning/30" },
  healthy: { label: "Healthy", text: "text-chart-2", fill: "bg-chart-2/30" },
  strong: { label: "Strong", text: "text-success", fill: "bg-success/25" },
  implausible: { label: "Check the takeoff", text: "text-destructive", fill: "bg-destructive/20" },
}

/**
 * Where a margin sits on the corridor gauge, 0–100. The corridor is drawn from
 * −10% to 40% because that is the range a real plan moves through; anything
 * outside pins to an end rather than falling off the track.
 */
export const MARGIN_GAUGE_MIN = -10
export const MARGIN_GAUGE_MAX = 40

export function marginGaugePct(pct: number): number {
  const clamped = Math.min(Math.max(pct, MARGIN_GAUGE_MIN), MARGIN_GAUGE_MAX)
  return ((clamped - MARGIN_GAUGE_MIN) / (MARGIN_GAUGE_MAX - MARGIN_GAUGE_MIN)) * 100
}
