/**
 * Margin rolled up over homes, read against the margin each home was locked at.
 *
 * Every grouping (division, community, plan, plan version) is the same sum over
 * the same per-home figures, so their totals cannot disagree and no home is
 * counted twice. The revised side is today's number: the approved budget plus
 * its variance orders, or posted cost once it is higher (`projectedMargin`).
 * The original side is the immutable baseline captured at release (else sale);
 * a home that has none is counted and named, never guessed.
 *
 * Drift is only comparable over the same homes, so it is measured on the homes
 * that have a baseline: their revised margin less their original margin.
 */

import type { OriginalMargin } from "@/lib/financials/home-margin-baseline"

export type MarginHome = {
  revenueCents: number
  projectedCostCents: number
  projectedMarginCents: number
  original: OriginalMargin | null
}

export type MarginRollup = {
  homes: number
  revenueCents: number
  projectedCostCents: number
  marginCents: number
  marginPercent: number
  /** Homes with a locked baseline, and the homes without one. */
  baselinedHomes: number
  unbaselinedHomes: number
  originalSalePriceCents: number
  originalCostCents: number
  originalMarginCents: number
  /** Of the baselined homes' original sale price; null when there are none. */
  originalMarginPercent: number | null
  /** Revised margin of the baselined homes less their original margin. */
  driftCents: number
}

export function rollUpMarginHomes(rows: MarginHome[]): MarginRollup {
  let revenueCents = 0
  let projectedCostCents = 0
  let marginCents = 0
  let originalSalePriceCents = 0
  let originalCostCents = 0
  let originalMarginCents = 0
  let baselinedRevisedMarginCents = 0
  let baselinedHomes = 0
  for (const row of rows) {
    revenueCents += row.revenueCents
    projectedCostCents += row.projectedCostCents
    marginCents += row.projectedMarginCents
    if (!row.original) continue
    baselinedHomes += 1
    originalSalePriceCents += row.original.salePriceCents
    originalCostCents += row.original.costCents
    originalMarginCents += row.original.marginCents
    baselinedRevisedMarginCents += row.projectedMarginCents
  }
  return {
    homes: rows.length,
    revenueCents,
    projectedCostCents,
    marginCents,
    marginPercent: revenueCents > 0 ? (marginCents / revenueCents) * 100 : 0,
    baselinedHomes,
    unbaselinedHomes: rows.length - baselinedHomes,
    originalSalePriceCents,
    originalCostCents,
    originalMarginCents,
    originalMarginPercent: originalSalePriceCents > 0 ? (originalMarginCents / originalSalePriceCents) * 100 : null,
    driftCents: baselinedRevisedMarginCents - originalMarginCents,
  }
}

/** Homes grouped by a key; a home with no key joins the `fallback` group. */
export function groupMarginHomes<Home extends MarginHome>(homes: Home[], keyOf: (home: Home) => string | null, fallback = ""): Map<string, Home[]> {
  const groups = new Map<string, Home[]>()
  for (const home of homes) {
    const key = keyOf(home) ?? fallback
    groups.set(key, [...(groups.get(key) ?? []), home])
  }
  return groups
}

/**
 * Which homes a margin report counts. `all` is every home in scope; `closed` is
 * homes whose closing happened in the period; `started` is homes released to
 * construction in the period. A period bound of null is open on that side.
 */
export type MarginCohort =
  | { kind: "all" }
  | { kind: "closed" | "started"; from: string | null; to: string | null }

export function homeInMarginCohort(cohort: MarginCohort, home: { closedOn: string | null; startedOn: string | null }): boolean {
  if (cohort.kind === "all") return true
  const date = cohort.kind === "closed" ? home.closedOn : home.startedOn
  if (!date) return false
  return (cohort.from === null || date >= cohort.from) && (cohort.to === null || date <= cohort.to)
}

export function describeMarginCohort(cohort: MarginCohort): string {
  if (cohort.kind === "all") return "Every home in scope, whatever its stage."
  const what = cohort.kind === "closed" ? "Homes closed" : "Homes started"
  if (cohort.from === null && cohort.to === null) return `${what} on any date.`
  return `${what} ${cohort.from ?? "the beginning"} to ${cohort.to ?? "today"}.`
}
