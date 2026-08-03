/**
 * Shared vocabulary for the project correspondence log. Kept out of
 * `lib/services/project-email-ingest.ts` so client components can import the
 * labels without pulling the server-only ingest pipeline into the bundle.
 */

export const CORRESPONDENCE_CLASSIFICATIONS = [
  "general",
  "correspondence",
  "rfi_related",
  "co_trigger",
  "bill",
  "submittal_related",
] as const

export type CorrespondenceClassification = (typeof CORRESPONDENCE_CLASSIFICATIONS)[number]

export type CorrespondenceDirection = "inbound" | "outbound"

export type CorrespondenceClassifiedBy = "ai" | "user"

/**
 * `correspondence` is the schema value for a formal notice — a letter that
 * carries contractual weight rather than day-to-day chatter. The stored value
 * stays as-is; only the label distinguishes it from the log it lives in.
 */
export const CLASSIFICATION_LABELS: Record<CorrespondenceClassification, string> = {
  general: "General",
  correspondence: "Formal notice",
  rfi_related: "RFI",
  co_trigger: "Change trigger",
  bill: "Bill",
  submittal_related: "Submittal",
}

export const CLASSIFICATION_HINTS: Record<CorrespondenceClassification, string> = {
  general: "Routine project traffic with no contractual consequence.",
  correspondence: "A formal notice, claim, or letter of record.",
  rfi_related: "Answers or raises a request for information.",
  co_trigger: "A credible scope, cost, or schedule change.",
  bill: "An invoice or bill from a vendor.",
  submittal_related: "Concerns a submittal, shop drawing, or product data.",
}

export function isCorrespondenceClassification(value: string): value is CorrespondenceClassification {
  return (CORRESPONDENCE_CLASSIFICATIONS as readonly string[]).includes(value)
}

/** Entity types a filed email can be linked to, and where that entity lives. */
export const LINKED_ENTITY_LABELS: Record<string, string> = {
  change_event: "Change event",
}

/**
 * Only `change_event` gets a link, because it is the only thing the ingest
 * pipeline ever links an email to. The fragment matches the row id rendered by
 * `ChangeEventsClient`, so the destination scrolls to the event itself.
 */
export function linkedEntityHref(
  projectId: string,
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (!entityType || !entityId) return null
  if (entityType !== "change_event") return null
  return `/projects/${projectId}/change-orders#ce-${entityId}`
}

export function linkedEntityLabel(entityType: string | null): string | null {
  if (!entityType) return null
  return LINKED_ENTITY_LABELS[entityType] ?? entityType.replaceAll("_", " ")
}
