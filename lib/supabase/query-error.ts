import { unstable_rethrow } from "next/navigation"

/** Preserve Next.js render cancellation before returning a database failure. */
export function preserveQueryError(error: unknown) {
  unstable_rethrow(error)
  return {
    data: null,
    error: error instanceof Error ? error : new Error(String(error)),
  }
}
