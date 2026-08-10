/**
 * Pure cutover gate math. No I/O — the cutover service resolves the rows, this
 * decides what they mean, and the tests exercise it directly.
 */

/**
 * A quarter of zero-variance comparison, measured in the calendar the compared
 * accounting periods actually cover — not in how many runs a bookkeeper managed
 * to approve in an afternoon. 90 days is the shortest possible calendar quarter.
 *
 * The plan's companion condition — silent-correct "across multiple orgs" — is
 * deliberately NOT encoded. It is a platform readiness judgement about Arc, not
 * a property of the org sitting in front of the cutover screen, and encoding it
 * per-org would make the first org's cutover unreachable forever. It stays a
 * human gate on the cutover approval.
 */
export const SILENT_CORRECTNESS_DAYS = 90

export type ComparedPeriod = { periodStart: string; periodEnd: string }

/**
 * Calendar days covered by the compared accounting periods, inclusive of both
 * end days. Subtraction alone makes a calendar Q1 (Jan 1 – Mar 31) measure 89
 * days and would block a cutover that has earned it.
 *
 * Gaps are not penalized: three approved periods spanning January through
 * September still represent nine months of the ledger agreeing with the external
 * system, and the periods themselves are what `three_approved_comparisons`
 * counts.
 */
export function comparisonSpanDays(periods: ComparedPeriod[]): number {
  const bounds = periods
    .map((period) => ({ start: Date.parse(period.periodStart), end: Date.parse(period.periodEnd) }))
    .filter((bound) => Number.isFinite(bound.start) && Number.isFinite(bound.end))
  if (!bounds.length) return 0
  const start = Math.min(...bounds.map((bound) => bound.start))
  const end = Math.max(...bounds.map((bound) => bound.end))
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1
}

/** Whether the approved comparison runs cover at least one calendar quarter. */
export function hasQuarterOfSilentCorrectness(periods: ComparedPeriod[]): boolean {
  return comparisonSpanDays(periods) >= SILENT_CORRECTNESS_DAYS
}
