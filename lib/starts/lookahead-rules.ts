import { createHash } from "node:crypto"

/**
 * What a trade's look-ahead means, in one place. `read_trade_lookahead_workspace`
 * (20261014110000_trade_notice_deliveries.sql) restates these sets literally —
 * SQL cannot import them — and tests/trade-lookahead.test.js compares the two.
 */

/** Work in these states is not "what you owe us next". */
export const LOOKAHEAD_EXCLUDED_STATUSES = ["cancelled", "completed"] as const
/** Homes whose work is looked ahead: a presold home is "planning" until it is completed, even after release. */
export const LOOKAHEAD_HOME_STATUSES = ["planning", "active"] as const
/** A purchase order awards its vendor the work only once it is approved. */
export const LOOKAHEAD_PO_STATUSES = ["approved", "complete"] as const
/** The provider remembers an idempotency key for a day; past it a send is unknowable. */
export const NOTICE_KEY_WINDOW_MS = 24 * 60 * 60 * 1000
/** A schedule move is told to the trade when either date is this close. */
export const SCHEDULE_NOTICE_HORIZON_DAYS = 28

export function isLookaheadStatus(status: string) {
  return !(LOOKAHEAD_EXCLUDED_STATUSES as readonly string[]).includes(status)
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10)
}

export function addDays(day: string, days: number) {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return isoDay(date)
}

export function lookaheadWindow(now: Date, weeks: 2 | 3 | 4) {
  const start = isoDay(now)
  return { start, end: addDays(start, weeks * 7) }
}

/**
 * A task is in the window while any of its days is: one that started last
 * week and runs through next week belongs to this week's look-ahead, and so
 * does an overdue task that has not been completed.
 */
export function overlapsWindow(item: { startDate: string; endDate: string | null }, window: { start: string; end: string }) {
  return item.startDate <= window.end && (item.endDate ?? item.startDate) >= window.start
}

/** A move out of, into, or inside the horizon changes what the trade was told. */
export function scheduleChangeIsNotifiable(oldStart: string | null, newStart: string | null, today: string) {
  if (oldStart === newStart) return false
  const horizon = addDays(today, SCHEDULE_NOTICE_HORIZON_DAYS)
  return (oldStart !== null && oldStart <= horizon) || (newStart !== null && newStart <= horizon)
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** The hash a delivery stores: what the notice says, to whom, under which subject. */
export function noticeContentHash(parts: { snapshot: unknown; recipients: string[]; subject: string }) {
  return createHash("sha256").update(canonicalJson({ ...parts, recipients: [...parts.recipients].sort() })).digest("hex")
}

/** Same scope and same day is one look-ahead; a community-scoped one never blocks the full one. */
export function lookaheadDedupeKey(input: { companyId: string; weeks: number; communityId?: string; divisionId?: string; utcDay: string }) {
  const scope = createHash("sha256").update(canonicalJson({ weeks: input.weeks, communityId: input.communityId ?? null, divisionId: input.divisionId ?? null })).digest("hex").slice(0, 16)
  return `lookahead:${input.companyId}:${scope}:${input.utcDay}`
}

export function releaseNoticeDedupeKey(packageId: string, companyId: string) {
  return `release:${packageId}:${companyId}`
}

export function scheduleChangeDedupeKey(jobId: number | string) {
  return `schedule_change:${jobId}`
}
