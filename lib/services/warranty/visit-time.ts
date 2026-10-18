/**
 * Warranty visit times are instants; what a homeowner, a technician and a
 * coordinator read is the wall-clock time at the house. Everything here takes
 * the IANA zone explicitly — never the server's or the browser's — so the desk,
 * the portals and the emails all say the same thing, including across a
 * daylight-saving change.
 */

export const DEFAULT_WARRANTY_TIME_ZONE = "America/New_York"

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** The home's zone: the community's override, else the org's, else the product default. */
export function resolveWarrantyTimeZone(...candidates: unknown[]): string {
  return candidates.find(isValidTimeZone) ?? DEFAULT_WARRANTY_TIME_ZONE
}

function parseInstant(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid visit time: ${iso}`)
  return date
}

/** "Oct 12, 2026, 9:00 AM EDT" */
export function formatWarrantyVisitInstant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone }).format(parseInstant(iso))
}

/** "9:00 AM" at the house, or "9:00 AM EDT" with `withZone`. */
export function formatWarrantyVisitClock(iso: string, timeZone: string, withZone = false): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...(withZone ? { timeZoneName: "short" as const } : {}), timeZone }).format(parseInstant(iso))
}

/** The calendar day (YYYY-MM-DD) the instant falls on at the house. */
export function warrantyLocalDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(parseInstant(iso))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

/**
 * "Oct 12, 2026, 9:00 – 11:00 AM EDT". A window that ends on another local day
 * spells out both ends, so an overnight window is never misread.
 */
export function formatWarrantyVisitWindow(startIso: string, endIso: string, timeZone: string): string {
  if (warrantyLocalDate(startIso, timeZone) !== warrantyLocalDate(endIso, timeZone)) {
    return `${formatWarrantyVisitInstant(startIso, timeZone)} – ${formatWarrantyVisitInstant(endIso, timeZone)}`
  }
  const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(parseInstant(startIso))
  return `${day}, ${formatWarrantyVisitClock(startIso, timeZone)} – ${formatWarrantyVisitClock(endIso, timeZone, true)}`
}

function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instantMs))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return asUtc - Math.floor(instantMs / 1000) * 1000
}

/**
 * Turns the wall-clock time a coordinator typed ("2026-11-01T09:00") into the
 * instant it means at the house. A time that does not exist (the hour skipped
 * going into daylight time) resolves forward past the change; one that
 * happens twice resolves to its first occurrence.
 */
export function zonedWallTimeToUtc(local: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local)
  if (!match) throw new Error(`Invalid local time: ${local}`)
  const [, year, month, day, hour, minute, second] = match
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0))
  const first = wall - zoneOffsetMs(wall, timeZone)
  const second_ = wall - zoneOffsetMs(first, timeZone)
  // Whichever guess reads back as the typed wall time is the answer; in the
  // skipped hour neither does, and the later reading (after the change) wins.
  const resolved = [first, second_].find((candidate) => candidate + zoneOffsetMs(candidate, timeZone) === wall) ?? Math.max(first, second_)
  return new Date(resolved).toISOString()
}

/** The start of a local calendar day (YYYY-MM-DD) as a UTC instant. */
export function zonedStartOfDay(date: string, timeZone: string): string {
  return zonedWallTimeToUtc(`${date}T00:00`, timeZone)
}
