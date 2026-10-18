import { MobileAPIError } from "@/lib/mobile/api"

/**
 * A record's revision is its `updated_at`, exactly as the API last returned it.
 * Clients may re-serialize the timestamp at millisecond precision, so equality
 * is by instant at that precision, not by string.
 */
export function revisionMatches(expected: string, actual: string | null | undefined) {
  if (!actual) return false
  if (expected === actual) return true
  const expectedMs = Date.parse(expected)
  const actualMs = Date.parse(actual)
  return !Number.isNaN(expectedMs) && !Number.isNaN(actualMs) && expectedMs === actualMs
}

/** The 409 for a write made against an out-of-date record; carries the record as it is now. */
export function staleRevisionError(entity: string, current: unknown) {
  return new MobileAPIError(
    409,
    "stale_revision",
    `This ${entity} changed since you last loaded it. Review the current version before saving again.`,
    undefined,
    current,
  )
}
