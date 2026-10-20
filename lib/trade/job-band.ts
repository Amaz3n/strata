/**
 * The numbers a trade job's overview band reports. Pure: the page loads the
 * existing billing and time summaries and this module only reads them.
 */

export interface CrewPeriod {
  /** Monday, YYYY-MM-DD. */
  start: string
  /** Sunday, YYYY-MM-DD. */
  end: string
}

export interface CrewTimeRow {
  work_date: string
  hours: number | string | null
  status: string
}

/** `listProjectTimeEntries` returns every reviewable entry but only this many settled ones. */
export const SETTLED_TIME_ENTRY_CAP = 50
const SETTLED_STATUSES = new Set(["client_approved", "locked", "rejected"])

const isoDate = (date: Date) => date.toISOString().slice(0, 10)

/** The Monday-to-Sunday week containing `today`, in UTC. */
export function crewPeriod(today: Date): CrewPeriod {
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const sinceMonday = (day.getUTCDay() + 6) % 7
  const start = new Date(day.getTime() - sinceMonday * 86_400_000)
  return { start: isoDate(start), end: isoDate(new Date(start.getTime() + 6 * 86_400_000)) }
}

/**
 * Hours crew logged on the job this period, rejected entries excluded.
 * `truncated` is true when the settled-entry cap may have cut entries that
 * belong to the period, so the total is a floor and the band says so.
 */
export function crewHoursInPeriod(rows: CrewTimeRow[], period: CrewPeriod) {
  let hours = 0
  for (const row of rows) {
    if (row.status === "rejected") continue
    if (row.work_date < period.start || row.work_date > period.end) continue
    hours += Number(row.hours ?? 0)
  }
  const settled = rows.filter((row) => SETTLED_STATUSES.has(row.status))
  const oldestSettled = settled.reduce<string | null>(
    (oldest, row) => (oldest === null || row.work_date < oldest ? row.work_date : oldest),
    null,
  )
  const truncated =
    settled.length >= SETTLED_TIME_ENTRY_CAP && oldestSettled !== null && oldestSettled >= period.start
  return { hours: Math.round(hours * 100) / 100, truncated }
}
