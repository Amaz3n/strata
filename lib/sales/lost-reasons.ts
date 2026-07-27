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

export function isLostReasonCode(value: string | null | undefined): value is LostReasonCode {
  return LOST_REASON_CODES.some((code) => code === value)
}

/** `financing: lender denied` → `{ code: "financing", note: "lender denied" }`. */
export function parseLostReason(value: string | null): { code: LostReasonCode | null; note: string | null } {
  if (!value) return { code: null, note: null }
  const separator = value.indexOf(":")
  const head = (separator === -1 ? value : value.slice(0, separator)).trim()
  const tail = separator === -1 ? "" : value.slice(separator + 1).trim()
  if (isLostReasonCode(head)) return { code: head, note: tail || null }
  return { code: null, note: value }
}

export function formatLostReason(value: string | null): string | null {
  const { code, note } = parseLostReason(value)
  if (!code) return note
  return note ? `${LOST_REASON_LABELS[code]} — ${note}` : LOST_REASON_LABELS[code]
}

export function serializeLostReason(code: LostReasonCode, note?: string | null): string {
  const trimmed = note?.trim()
  return trimmed ? `${code}: ${trimmed}` : code
}
