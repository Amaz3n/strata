/**
 * "This record does not exist", distinct from "the lookup failed".
 *
 * Services used to collapse both into one throw, and callers turned the whole
 * category into `notFound()`. That meant a transient database error rendered as
 * a 404 — the page told the user a vendor had been deleted when in fact Arc
 * could not reach the database. On a surface that gates payments, degraded has
 * to look degraded.
 *
 * Follows the `code` convention set by `AuthorizationError` so it can be
 * recognized structurally, without importing server-only code.
 */
export class NotFoundError extends Error {
  code = "NOT_FOUND" as const

  constructor(message: string) {
    super(message)
    this.name = "NotFoundError"
  }
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "NOT_FOUND"
  )
}

/**
 * Resolve a lookup to `null` when the record is genuinely absent, while letting
 * real failures propagate to an error boundary.
 */
export async function nullIfNotFound<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}
