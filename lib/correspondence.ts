/**
 * Shared vocabulary for the project correspondence log. Kept out of
 * `lib/services/correspondence.ts` so client components can import the labels
 * without pulling the server-only service into the bundle.
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

/**
 * `system` is the state a message is filed in — nobody has ruled on it yet.
 * Without it there was no way to tell an untouched message from one a person
 * had confirmed, which is exactly the distinction the triage queue runs on.
 */
export type CorrespondenceClassifiedBy = "ai" | "user" | "system"

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

/**
 * Where an attachment belongs in the project's documents once the message it
 * arrived on has been classified. Everything used to land as `other` in one
 * `/correspondence` folder, so a shop drawing emailed by a sub never reached
 * the module that needed it.
 */
export const CLASSIFICATION_FILE_CATEGORIES: Record<CorrespondenceClassification, string | null> = {
  general: null,
  correspondence: null,
  rfi_related: "rfis",
  co_trigger: null,
  bill: "financials",
  submittal_related: "submittals",
}

/** Records a filed message can be attached to, and where each one lives. */
export const LINKABLE_ENTITY_TYPES = ["change_event", "rfi", "submittal", "vendor_bill"] as const

export type LinkableEntityType = (typeof LINKABLE_ENTITY_TYPES)[number]

export const LINKABLE_ENTITY_LABELS: Record<LinkableEntityType, string> = {
  change_event: "Change event",
  rfi: "RFI",
  submittal: "Submittal",
  vendor_bill: "Bill",
}

/** The permission that governs reading the records of each kind. */
export const LINKABLE_ENTITY_PERMISSIONS: Record<LinkableEntityType, string> = {
  change_event: "change_events.read",
  rfi: "rfi.read",
  submittal: "submittal.read",
  vendor_bill: "bill.read",
}

export function isLinkableEntityType(value: string): value is LinkableEntityType {
  return (LINKABLE_ENTITY_TYPES as readonly string[]).includes(value)
}

/**
 * The classification a link of this kind implies. Linking an email to an RFI
 * says what the email is about more precisely than the model's guess did, so
 * the link carries the classification with it.
 */
export const LINK_IMPLIED_CLASSIFICATION: Record<LinkableEntityType, CorrespondenceClassification> = {
  change_event: "co_trigger",
  rfi: "rfi_related",
  submittal: "submittal_related",
  vendor_bill: "bill",
}

export function linkedEntityHref(
  projectId: string,
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (!entityType || !entityId || !isLinkableEntityType(entityType)) return null
  switch (entityType) {
    case "change_event":
      return `/projects/${projectId}/change-orders?event=${entityId}`
    case "rfi":
      return `/projects/${projectId}/rfis?rfi=${entityId}`
    case "submittal":
      return `/projects/${projectId}/submittals?submittal=${entityId}`
    case "vendor_bill":
      return `/projects/${projectId}/financials/payables?bill=${entityId}`
  }
}

export function linkedEntityLabel(entityType: string | null): string | null {
  if (!entityType) return null
  if (isLinkableEntityType(entityType)) return LINKABLE_ENTITY_LABELS[entityType]
  return entityType.replaceAll("_", " ")
}

/** Strips reply/forward prefixes so a subject can be compared across a thread. */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^((re|fwd?)\s*:\s*)+/i, "").trim().toLowerCase()
}
