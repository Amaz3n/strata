import { createHash } from "node:crypto"

import { daysUntil } from "@/lib/compliance/dates"

/**
 * The reminder ladder for the company's own vault documents: 30, 14 and 3 days
 * ahead, then once on lapse. `0` is the lapse rung, not "today".
 */
export const OWN_DOCUMENT_REMINDER_RUNGS = [30, 14, 3, 0] as const
export type OwnDocumentReminderRung = (typeof OWN_DOCUMENT_REMINDER_RUNGS)[number]

/** The furthest-out expiry that has any rung to report. */
export const OWN_DOCUMENT_REMINDER_HORIZON_DAYS = 30

/**
 * The nearest rung a document has reached, or null while it is still further
 * out than the first. Keyed on the rung crossed rather than the exact day, so a
 * nightly run that is skipped does not lose a reminder; the rung's event id
 * (below) is what keeps the next night from repeating it.
 */
export function ownDocumentReminderRung(
  expiryDate: string | null,
  now: Date | string = new Date(),
): OwnDocumentReminderRung | null {
  const days = daysUntil(expiryDate, now)
  if (days === null || days > OWN_DOCUMENT_REMINDER_HORIZON_DAYS) return null
  if (days < 0) return 0
  if (days <= 3) return 3
  if (days <= 14) return 14
  return 30
}

/**
 * The event id that makes one document's one rung happen once. Bound to the
 * expiry date as well, so a document whose date is corrected in place earns
 * its reminders again.
 */
export function ownDocumentReminderEventId(
  orgId: string,
  documentId: string,
  expiryDate: string,
  rung: OwnDocumentReminderRung,
): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["arc.own_compliance.expiry.v1", orgId, documentId, expiryDate, rung]))
    .digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
