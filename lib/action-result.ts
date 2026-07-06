import { ZodError } from "zod"

/**
 * Standard server-action result envelope. Actions must return this instead of throwing:
 * thrown errors get redacted to an opaque digest in production, so the client would
 * never see the real message.
 */
export type ActionResult<T> = { success: true; data: T } | { success: false; error: string }

export function actionError(error: unknown, fallback = "Something went wrong. Please try again."): {
  success: false
  error: string
} {
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    const path = issue?.path?.length ? `${issue.path.join(".")}: ` : ""
    return { success: false, error: issue ? `${path}${issue.message}` : fallback }
  }
  if (error instanceof Error && error.message) {
    return { success: false, error: error.message }
  }
  return { success: false, error: fallback }
}

/** Client-side helper: unwrap a result, throwing locally (safe — no prod redaction in the browser). */
export function unwrapAction<T>(result: ActionResult<T>): T {
  if (!result.success) throw new Error(result.error)
  return result.data
}
