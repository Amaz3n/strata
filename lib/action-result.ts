import { ZodError } from "zod"

/**
 * Standard server-action result envelope. Actions must return this instead of throwing:
 * thrown errors get redacted to an opaque digest in production, so the client would
 * never see the real message.
 */
export type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }

/**
 * Structural check for AuthorizationError without importing it — that class pulls in
 * server-only Supabase code, and this module is imported by client components too.
 */
function isAuthorizationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "AUTH_FORBIDDEN"
  )
}

export function actionError(error: unknown, fallback = "Something went wrong. Please try again."): {
  success: false
  error: string
  code?: string
} {
  if (isAuthorizationError(error)) {
    return { success: false, error: "You don't have permission to do that." }
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    const path = issue?.path?.length ? `${issue.path.join(".")}: ` : ""
    return { success: false, error: issue ? `${path}${issue.message}` : fallback }
  }
  if (error instanceof Error && error.message) {
    const codedError: Error & { code?: unknown } = error
    const code = typeof codedError.code === "string"
      ? codedError.code
      : undefined
    return { success: false, error: error.message, ...(code ? { code } : {}) }
  }
  return { success: false, error: fallback }
}

/**
 * Wrap a server action body so it returns a result instead of throwing.
 *
 * Every action file grew its own private copy of this three-line helper; the
 * directory alone had it three times. Actions must not throw — a thrown error
 * is redacted to an opaque digest in production, so the toast would say nothing.
 */
export async function runAction<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await work() }
  } catch (error) {
    return actionError(error)
  }
}

/** Client-side helper: unwrap a result, throwing locally (safe — no prod redaction in the browser). */
export function unwrapAction<T>(result: ActionResult<T>): T {
  if (!result.success) throw new Error(result.error)
  return result.data
}
