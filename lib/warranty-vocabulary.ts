import type { ProjectPosture } from "@/lib/product-tier"

/**
 * Warranty vocabulary by posture. Production builders run literal 30- and 60-day
 * service lists off the buyer walkthrough; custom and commercial builders take the
 * same severities as ordinary callbacks. The stored enum values never change —
 * only what they're called.
 */
export interface WarrantySeverityVocabulary {
  key: "emergency" | "routine_30" | "routine_60"
  label: string
  hint: string
}

const PRODUCTION_SEVERITIES: WarrantySeverityVocabulary[] = [
  { key: "emergency", label: "Emergency", hint: "Immediate safety risk or active damage." },
  { key: "routine_30", label: "30-day service list", hint: "Routine items batched into the 30-day visit." },
  { key: "routine_60", label: "60-day service list", hint: "Routine items batched into the 60-day visit." },
]

const CALLBACK_SEVERITIES: WarrantySeverityVocabulary[] = [
  { key: "emergency", label: "Emergency", hint: "Immediate safety risk or active damage." },
  { key: "routine_30", label: "Routine", hint: "A normal callback — scheduled with the client." },
  { key: "routine_60", label: "Non-urgent", hint: "Cosmetic or low-impact items that can wait for a batch trip." },
]

export function getWarrantySeverities(posture: ProjectPosture): WarrantySeverityVocabulary[] {
  return posture === "production" ? PRODUCTION_SEVERITIES : CALLBACK_SEVERITIES
}

/** What starts the coverage clock — a closing for production, substantial completion otherwise. */
export function getCoverageStartLabel(posture: ProjectPosture) {
  return posture === "production" ? "closing" : "substantial completion"
}

/**
 * Production builders run several programs across communities and product lines.
 * Everyone else has exactly one warranty, so the roster, default flag, active
 * toggle, and structural-carrier flag are all noise.
 */
export function usesWarrantyProgramRoster(posture: ProjectPosture) {
  return posture === "production"
}
