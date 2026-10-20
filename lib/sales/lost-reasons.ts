/**
 * Why deals die. A free-text "lost reason" is a note nobody can report on; a
 * fixed code set is what makes the sales manager's cancellation report
 * actionable, and these five are what production builders actually track.
 *
 * Stored in `prospects.lost_reason` as `code` (optionally `code: note`), so no
 * schema change is needed and legacy free text still reads back.
 */
export const LOST_REASON_CODES = [
  "financing",
  "resale",
  "competitor",
  "price",
  "life_event",
  "other",
] as const

export type LostReasonCode = (typeof LOST_REASON_CODES)[number]

export const LOST_REASON_LABELS: Record<LostReasonCode, string> = {
  financing: "Financing fell through",
  resale: "Bought resale",
  competitor: "Went to a competitor",
  price: "Price",
  life_event: "Life event",
  other: "Other",
}

/**
 * Declining is the other way a quote closes: the company chose not to price the
 * work. It is a lost deal with a declined code, so every lost-deal reader keeps
 * working and the outcome still counts.
 */
export const DECLINE_REASON_CODES = ["declined_capacity", "declined_scope", "declined_terms", "declined_other"] as const

export type DeclineReasonCode = (typeof DECLINE_REASON_CODES)[number]

export const DECLINE_REASON_LABELS: Record<DeclineReasonCode, string> = {
  declined_capacity: "Declined: no capacity",
  declined_scope: "Declined: not our scope",
  declined_terms: "Declined: terms or schedule",
  declined_other: "Declined: other",
}

/** The reasons a quote is lost on, from the builder set: a trade is not sold resale or financing. */
export const QUOTE_LOST_REASON_CODES = ["price", "competitor", "other"] as const satisfies readonly LostReasonCode[]

export type CloseReasonCode = LostReasonCode | DeclineReasonCode

const CLOSE_REASON_LABELS: Record<CloseReasonCode, string> = { ...LOST_REASON_LABELS, ...DECLINE_REASON_LABELS }

export function isLostReasonCode(value: string | null | undefined): value is LostReasonCode {
  return LOST_REASON_CODES.some((code) => code === value)
}

export function isDeclineReasonCode(value: string | null | undefined): value is DeclineReasonCode {
  return DECLINE_REASON_CODES.some((code) => code === value)
}

function isCloseReasonCode(value: string): value is CloseReasonCode {
  return isLostReasonCode(value) || isDeclineReasonCode(value)
}

/** `financing: lender denied` → `{ code: "financing", note: "lender denied" }`. */
export function parseLostReason(value: string | null): { code: CloseReasonCode | null; note: string | null } {
  if (!value) return { code: null, note: null }
  const separator = value.indexOf(":")
  const head = (separator === -1 ? value : value.slice(0, separator)).trim()
  const tail = separator === -1 ? "" : value.slice(separator + 1).trim()
  if (isCloseReasonCode(head)) return { code: head, note: tail || null }
  return { code: null, note: value }
}

export function formatLostReason(value: string | null): string | null {
  const { code, note } = parseLostReason(value)
  if (!code) return note
  return note ? `${CLOSE_REASON_LABELS[code]} — ${note}` : CLOSE_REASON_LABELS[code]
}

export function serializeLostReason(code: CloseReasonCode, note?: string | null): string {
  const trimmed = note?.trim()
  return trimmed ? `${code}: ${trimmed}` : code
}
