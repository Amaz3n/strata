import type { ProspectActivity } from "@/lib/services/prospects"

/**
 * How a consultant records touching a buyer. Deliberately a tiny closed set:
 * the point is a timestamped "we spoke" with a note, not a CRM taxonomy.
 *
 * Logged as `prospect_contact_logged` events, so it lands in the same timeline
 * as holds, pricing and signatures rather than a parallel notes table.
 */
export const ACTIVITY_KINDS = ["call", "visit", "text", "email", "note"] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  call: "Call",
  visit: "Visit",
  text: "Text",
  email: "Email",
  note: "Note",
}

export function isActivityKind(value: string | null | undefined): value is ActivityKind {
  return ACTIVITY_KINDS.some((kind) => kind === value)
}

/** How a lead arrived. Drives which traffic counter the registration increments. */
export const INQUIRY_CHANNELS = ["walk_in", "appointment", "web", "phone"] as const

export type InquiryChannel = (typeof INQUIRY_CHANNELS)[number]

export function isInquiryChannel(value: string | null | undefined): value is InquiryChannel {
  return INQUIRY_CHANNELS.some((channel) => channel === value)
}

export const INQUIRY_CHANNEL_LABELS: Record<InquiryChannel, string> = {
  walk_in: "Walk-in",
  appointment: "Appointment",
  web: "Web inquiry",
  phone: "Phone",
}

/**
 * A co-op broker is a person on the deal, not a field on it, so they are stored
 * as a secondary prospect contact. This role is how both the registration card
 * and the edit sheet find that one contact again.
 */
export const COOP_AGENT_ROLE = "Co-op agent"

/** The event a logged touch is written as. Everything else the system observed. */
export const CONTACT_EVENT = "prospect_contact_logged"

export interface DescribedActivity {
  title: string
  /** The consultant's note, or the state change the system recorded. */
  note: string | null
  /** True when a person logged this, false when the system observed it. */
  logged: boolean
  /** How the touch happened, when it was a touch. Null for observed events. */
  kind: ActivityKind | null
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " ").replace(/^./, (char) => char.toUpperCase())
}

/**
 * One timeline event in the words a consultant would use. Shared so the deal
 * file and the last-touch counter agree on what counts as a touch.
 */
export function describeActivity(event: ProspectActivity): DescribedActivity {
  if (event.event_type === CONTACT_EVENT) {
    const rawKind = event.payload?.kind
    const kind = typeof rawKind === "string" && isActivityKind(rawKind) ? rawKind : null
    const note = event.payload?.note
    return {
      title: kind ? ACTIVITY_LABELS[kind] : "Contact",
      note: typeof note === "string" && note.trim() ? note : null,
      logged: true,
      kind,
    }
  }
  const from = event.payload?.from
  const to = event.payload?.to
  const note = typeof from === "string" && typeof to === "string" ? `${humanize(from)} → ${humanize(to)}` : null
  return { title: humanize(event.event_type), note, logged: false, kind: null }
}
