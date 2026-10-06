export type BooksPostingState = "pending" | "posted" | "reversed" | "blocked" | "failed"
export function timestampMicros(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return null
  const milliseconds = Date.parse(`${match[1]}${match[3]}`)
  if (!Number.isFinite(milliseconds)) return null
  return BigInt(milliseconds) * BigInt(1000) + BigInt((match[2] ?? "").padEnd(6, "0"))
}
/** A current journal and a receipt for this source revision are both required. */
export function resolveBooksPostingState(input: {
  sourceUpdatedAt: string
  receipt: { sourceObservedAt: string; journalStatus: string } | null
  failureCategory?: string | null
  /** False once the source has left the projectable set (void, rejected). */
  sourceProjectable?: boolean
}): BooksPostingState {
  if (input.failureCategory === "projection_blocked_by_closed_period") return "blocked"
  if (input.failureCategory) return "failed"
  // A voided or rejected source whose entry was reversed carries no money; later
  // housekeeping on the document must not make it look like it awaits posting.
  if (input.sourceProjectable === false && input.receipt?.journalStatus === "reversed") return "reversed"
  if (!input.receipt || input.receipt.journalStatus !== "posted") return "pending"
  const sourceTime = timestampMicros(input.sourceUpdatedAt)
  const observedTime = timestampMicros(input.receipt.sourceObservedAt)
  if (sourceTime === null || observedTime === null || sourceTime > observedTime) return "pending"
  return "posted"
}
