/**
 * One clock for every compliance verdict.
 *
 * There used to be four. `compliance-documents.ts` expired a document the moment
 * `new Date(expiry) < new Date()` — 00:00 UTC on its expiry date, so a
 * certificate valid *through* the 30th lapsed at the start of the 30th.
 * `compliance-autopilot.ts` did UTC date-only arithmetic and called that same
 * day zero. The portal computed its own with `Math.ceil` on a local-time parse,
 * and `isActiveWaiver` compared date strings lexicographically. Four answers to
 * "is this current today", one of which decides whether a subcontractor is paid.
 *
 * The rule here: **a date is a day, not an instant.** Everything is UTC
 * date-only, and a document is current through the end of its expiry date.
 *
 * Pure, and deliberately outside `lib/services/` — the vendor portal's client
 * components read these, and `lib/services/*` reaches for the database and
 * `server-only`. Same placement as `lib/directory/roles.ts`, for the same reason.
 */

/** `YYYY-MM-DD`. The only date shape the compliance slice stores or compares. */
export type DateKey = string

const DAY_MS = 24 * 60 * 60 * 1000
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * A date key, or null when the value is not one.
 *
 * Rejects a well-formed string that names a day that does not exist — `Date`
 * rolls `2026-02-30` forward to March 2nd rather than failing, and a compliance
 * date that silently moves is worse than one that reads as absent.
 */
export function parseDateKey(value: string | null | undefined): DateKey | null {
  if (!value) return null
  const trimmed = value.trim()
  // A timestamp is a legitimate way to spell a day; take the day off the front.
  const candidate = trimmed.length > 10 ? trimmed.slice(0, 10) : trimmed
  if (!DATE_KEY_PATTERN.test(candidate)) return null
  const time = Date.parse(`${candidate}T00:00:00Z`)
  if (Number.isNaN(time)) return null
  return new Date(time).toISOString().slice(0, 10) === candidate ? candidate : null
}

export function isDateKey(value: string | null | undefined): value is DateKey {
  return parseDateKey(value) !== null
}

/** Today, as a date key. Accepts an instant so callers can pin one per pass. */
export function todayKey(now: Date | DateKey = new Date()): DateKey {
  if (typeof now === "string") return parseDateKey(now) ?? new Date().toISOString().slice(0, 10)
  return now.toISOString().slice(0, 10)
}

/**
 * Whole days from today to `value`. Negative once past, 0 on the day itself.
 *
 * Null when `value` is not a date — the caller then has no date to report,
 * which is the same position it is in when the field is empty. Returning 0
 * instead is how a malformed expiry came to read "expires today" indefinitely.
 */
export function daysUntil(
  value: string | null | undefined,
  now: Date | DateKey = new Date(),
): number | null {
  const target = parseDateKey(value)
  if (!target) return null
  const from = Date.parse(`${todayKey(now)}T00:00:00Z`)
  const to = Date.parse(`${target}T00:00:00Z`)
  return Math.round((to - from) / DAY_MS)
}

/**
 * Whether a date has passed. A document is current *through* its expiry date,
 * so the day itself is not expired.
 *
 * An absent date never expires, and an unparseable one is treated as absent —
 * every other reader in this slice already treats a missing expiry as "no
 * expiry", and a legacy row with a bad string must not silently start blocking
 * payment. `lib/validation/compliance-documents.ts` is what stops new ones.
 */
export function isExpiredOn(
  value: string | null | undefined,
  now: Date | DateKey = new Date(),
): boolean {
  const days = daysUntil(value, now)
  return days !== null && days < 0
}

/**
 * Whether a date falls inside a warning window ahead of it: on or after today,
 * and no further out than `windowDays`.
 */
export function isWithinDays(
  value: string | null | undefined,
  windowDays: number,
  now: Date | DateKey = new Date(),
): boolean {
  const days = daysUntil(value, now)
  return days !== null && days >= 0 && days <= windowDays
}
