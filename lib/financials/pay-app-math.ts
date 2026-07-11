/**
 * Pure math for owner-side SOV progress billing (pay applications).
 *
 * Conventions (all money is integer cents):
 * - `previous_billed_cents` on a SOV line counts completed WORK from prior
 *   applications only; stored materials are a separate running balance.
 * - A pay-app line's `stored_materials_cents` is the balance presently stored
 *   after this application, not a delta.
 * - Retainage is withheld forward-only: this application's retainage is the
 *   resolved rate applied to this period's work plus the stored-materials rate
 *   applied to the change in stored balance. A line crossing a retainage step
 *   bills at the reduced rate for the this-period amount; previously held
 *   retainage is untouched until release.
 * - `percent_complete` is work only: (previous + this period) / scheduled.
 */

export interface RetainageStep {
  until_percent_complete: number
  retainage_percent: number
}

export interface PayAppLineEntry {
  scheduledValueCents: number
  previousBilledCents: number
  thisPeriodCents: number
  /** Balance presently stored after this application. */
  storedMaterialsCents: number
  /** Stored balance before this application (from the SOV rollup). */
  previousStoredMaterialsCents: number
  /** Rate applied to this period's work, percent 0-100. */
  workRetainagePercent: number
  /** Rate applied to the stored-materials delta, percent 0-100. */
  storedMaterialsRetainagePercent: number
}

export interface ComputedPayAppLine {
  thisPeriodCents: number
  storedMaterialsCents: number
  totalCompletedAndStoredCents: number
  percentComplete: number
  balanceToFinishCents: number
  retainageCents: number
  overbilled: boolean
}

export interface PayAppSummaryInput {
  originalContractSumCents: number
  changeOrderSumCents: number
  /** Retainage held across the SOV before this application, net of releases. */
  previousRetainageHeldCents: number
  /** Sum of prior applications' current_payment_due_cents. */
  previousCertificatesCents: number
  lines: ComputedPayAppLine[]
}

export interface PayAppSummary {
  contractSumToDateCents: number
  totalCompletedStoredCents: number
  /** Retainage withheld by THIS application (feeds the invoice negative line). */
  currentRetainageCents: number
  /** Total retainage held to date after this application (G702 line 5). */
  retainageCents: number
  totalEarnedLessRetainageCents: number
  previousCertificatesCents: number
  currentPaymentDueCents: number
  balanceToFinishCents: number
}

function roundCents(value: number): number {
  return Math.round(value)
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * Parse a contract's `retainage_schedule` jsonb into validated, ascending
 * steps. Returns null when the value is missing or unusable so callers fall
 * back to the flat contract rate.
 */
export function normalizeRetainageSchedule(value: unknown): RetainageStep[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const steps: RetainageStep[] = []
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null
    const until = Number((raw as Record<string, unknown>).until_percent_complete)
    const rate = Number((raw as Record<string, unknown>).retainage_percent)
    if (!Number.isFinite(until) || until <= 0 || until > 100) return null
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null
    steps.push({ until_percent_complete: until, retainage_percent: rate })
  }
  steps.sort((a, b) => a.until_percent_complete - b.until_percent_complete)
  return steps
}

/**
 * Rate for this period's work on one line: line override, else the schedule
 * step covering the line's percent complete, else the flat contract rate.
 * Percent complete past the last step uses the last step's rate.
 */
export function resolveRetainageRatePercent({
  percentComplete,
  schedule,
  lineOverridePercent,
  contractPercent,
}: {
  percentComplete: number
  schedule: RetainageStep[] | null
  lineOverridePercent?: number | null
  contractPercent: number
}): number {
  if (lineOverridePercent != null && Number.isFinite(lineOverridePercent)) {
    return clampPercent(lineOverridePercent)
  }
  if (schedule && schedule.length > 0) {
    const pct = clampPercent(percentComplete)
    for (const step of schedule) {
      if (pct <= step.until_percent_complete) return clampPercent(step.retainage_percent)
    }
    return clampPercent(schedule[schedule.length - 1].retainage_percent)
  }
  return clampPercent(contractPercent)
}

/** Convert a typed percent-complete into this period's work amount. */
export function thisPeriodFromPercentComplete({
  scheduledValueCents,
  percentComplete,
  previousBilledCents,
}: {
  scheduledValueCents: number
  percentComplete: number
  previousBilledCents: number
}): number {
  const target = roundCents(scheduledValueCents * (clampPercent(percentComplete) / 100))
  return target - previousBilledCents
}

export function computePayAppLine(entry: PayAppLineEntry): ComputedPayAppLine {
  const workToDateCents = entry.previousBilledCents + entry.thisPeriodCents
  const totalCompletedAndStoredCents = workToDateCents + entry.storedMaterialsCents
  const percentComplete =
    entry.scheduledValueCents > 0
      ? Math.round((workToDateCents / entry.scheduledValueCents) * 10000) / 100
      : 0

  const storedDeltaCents = entry.storedMaterialsCents - entry.previousStoredMaterialsCents
  const retainageCents =
    roundCents(entry.thisPeriodCents * (clampPercent(entry.workRetainagePercent) / 100)) +
    roundCents(storedDeltaCents * (clampPercent(entry.storedMaterialsRetainagePercent) / 100))

  return {
    thisPeriodCents: entry.thisPeriodCents,
    storedMaterialsCents: entry.storedMaterialsCents,
    totalCompletedAndStoredCents,
    percentComplete,
    balanceToFinishCents: entry.scheduledValueCents - totalCompletedAndStoredCents,
    retainageCents,
    overbilled: totalCompletedAndStoredCents > entry.scheduledValueCents,
  }
}

export function computePayAppSummary(input: PayAppSummaryInput): PayAppSummary {
  const contractSumToDateCents = input.originalContractSumCents + input.changeOrderSumCents
  const totalCompletedStoredCents = input.lines.reduce(
    (sum, line) => sum + line.totalCompletedAndStoredCents,
    0,
  )
  const currentRetainageCents = input.lines.reduce((sum, line) => sum + line.retainageCents, 0)
  const retainageCents = input.previousRetainageHeldCents + currentRetainageCents
  const totalEarnedLessRetainageCents = totalCompletedStoredCents - retainageCents
  const currentPaymentDueCents = totalEarnedLessRetainageCents - input.previousCertificatesCents

  return {
    contractSumToDateCents,
    totalCompletedStoredCents,
    currentRetainageCents,
    retainageCents,
    totalEarnedLessRetainageCents,
    previousCertificatesCents: input.previousCertificatesCents,
    currentPaymentDueCents,
    // G702 line 9 is line 3 less line 6. Because line 6 is earned less
    // retainage, the balance includes retainage still held.
    balanceToFinishCents: contractSumToDateCents - totalEarnedLessRetainageCents,
  }
}
