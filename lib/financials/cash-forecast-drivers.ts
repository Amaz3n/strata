/**
 * The construction drivers of the cash forecast: planned starts, scheduled
 * closings, and the what-if a reader can apply to them.
 *
 * A scenario is two numbers, not a model: closings slip (or pull in) by whole
 * weeks, and starts run at a percentage of plan. Everything here is pure so the
 * dollars are tested without a database.
 */

export type ForecastScenario = {
  /** Whole weeks every scheduled closing moves; negative pulls it in. */
  closingShiftWeeks: number
  /** Planned starts' cost as a percentage of plan: 100 is the plan. */
  startPacePercent: number
}

export const BASE_FORECAST_SCENARIO: ForecastScenario = { closingShiftWeeks: 0, startPacePercent: 100 }

export function isBaseScenario(scenario: ForecastScenario) {
  return scenario.closingShiftWeeks === 0 && scenario.startPacePercent === 100
}

/** `YYYY-MM-DD` moved by whole weeks, in UTC so a DST change never moves the day. */
export function shiftIsoDate(date: string, weeks: number): string {
  const moved = new Date(`${date}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + weeks * 7)
  return moved.toISOString().slice(0, 10)
}

/** The month a construction cash movement lands in; a date already past is owed now. */
export function forecastMonth(date: string, today: string): string {
  return (date < today ? today : date).slice(0, 7)
}

/**
 * What a closing brings in: the agreement price less everything already billed
 * on the home. Billed deposits and draws are receivables the forecast already
 * carries on their due dates, so counting them again at closing would double
 * the cash.
 */
export function closingProceedsCents(input: { agreementTotalCents: number; billedCents: number }): number {
  return Math.max(0, input.agreementTotalCents - input.billedCents)
}

/**
 * What a planned start will still cost: its approved budget less what is
 * already committed to trades. Committed cost is forecast as committed-unbilled,
 * so only the uncommitted rest is new cash out.
 */
export function plannedStartCostCents(input: { budgetCents: number; committedCents: number }): number {
  return Math.max(0, input.budgetCents - input.committedCents)
}

/** A month's planned-start cost at the scenario's pace, rounded once for the month. */
export function applyStartPace(costCents: number, startPacePercent: number): number {
  return Math.round((costCents * startPacePercent) / 100)
}
