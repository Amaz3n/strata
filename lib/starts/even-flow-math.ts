const DAY_MS = 86_400_000

export function mondayOfIsoWeek(value: string | Date) {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00.000Z`) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date")
  const day = date.getUTCDay()
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1))
  return date.toISOString().slice(0, 10)
}
export function addWeeks(weekStart: string, weeks: number) {
  const date = new Date(`${mondayOfIsoWeek(weekStart)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + weeks * 7)
  return date.toISOString().slice(0, 10)
}

export function normalizeWorkGroupKey(name: string) {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, " ")
}

export function percentile(values: number[], target: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * target) - 1)
  return sorted[index]
}

export function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]
}

/** Completed homes needed in each half before a cycle trend means anything. */
export const CYCLE_TREND_MIN_SAMPLE = 3

/**
 * Whether cycle time is improving: the median of the most recent half minus the
 * median of the earlier half, in days. Negative means the group is getting
 * faster. Null when either half is too thin to compare — two homes are not a
 * trend, and the hardcoded 0 this replaces read as a confident "flat".
 *
 * Input is each completed home's cycle length, ordered by start date.
 */
export function cycleTrendDelta(daysInStartOrder: number[]) {
  if (daysInStartOrder.length < CYCLE_TREND_MIN_SAMPLE * 2) return null
  const split = Math.floor(daysInStartOrder.length / 2)
  return median(daysInStartOrder.slice(daysInStartOrder.length - split)) - median(daysInStartOrder.slice(0, split))
}

export function calendarDaysBetween(start: string, end: string) {
  return Math.max(0, Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / DAY_MS))
}

export function releaseSlotVariance({
  weekStart,
  today,
  target,
  released,
  targeted,
}: {
  weekStart: string
  today: string
  target: number
  released: number
  targeted: number
}) {
  const currentWeek = mondayOfIsoWeek(today)
  return (weekStart <= currentWeek ? released : targeted) - target
}

/** How long trade schedule changes coalesce before one digest goes out. */
export const SCHEDULE_DIGEST_WINDOW_MS = 15 * 60_000

/**
 * The outbox dedupe key for a trade schedule-change digest. Dedupe keys are
 * permanently unique, so the coalescing window is part of the key: every change
 * inside one window merges into a single notice, and the next window opens a
 * fresh one rather than being suppressed forever.
 */
export function scheduleDigestKey(companyId: string, projectId: string, atMs: number) {
  const bucket = Math.floor(atMs / SCHEDULE_DIGEST_WINDOW_MS)
  return `trade_schedule_change_notice:company_id:${companyId}|project_id:${projectId}|bucket:${bucket}`
}
