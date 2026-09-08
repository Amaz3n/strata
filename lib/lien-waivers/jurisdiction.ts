/**
 * Which state's waiver law governs a document.
 *
 * The property decides, never the org: a Florida builder's Georgia job is a
 * Georgia waiver. The org's payment policy default only fills in when the
 * project has no state on file. Payment runs used to read the policy at build
 * and the project at re-verify, and any job outside the org's home state
 * failed re-verification with "facts changed" — this is the one resolver both
 * sides now share.
 */

export const STATUTORY_WAIVER_STATES = ["FL", "CA", "TX"] as const
export type StatutoryWaiverState = (typeof STATUTORY_WAIVER_STATES)[number]

export function isStatutoryWaiverState(value: string | null | undefined): value is StatutoryWaiverState {
  return value === "FL" || value === "CA" || value === "TX"
}

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
}

const NAME_TO_CODE = new Map(Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]))

/** A two-letter state code from whatever a location field holds, or null. */
export function normalizeStateCode(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const upper = trimmed.toUpperCase()
  if (upper.length === 2 && STATE_NAMES[upper]) return upper
  return NAME_TO_CODE.get(trimmed.toLowerCase()) ?? null
}

/** The state of a project's location object, tolerant of every shape Arc has stored. */
export function locationState(location: unknown): string | null {
  if (!location) return null
  if (typeof location === "string") {
    // "123 Main St, Naples, FL 34102" — the state sits before an optional ZIP at the end.
    const match = /,\s*([A-Za-z]{2})\s*\d{0,5}(?:-\d{4})?\s*$/.exec(location)
    return match ? normalizeStateCode(match[1]) : null
  }
  if (typeof location !== "object" || Array.isArray(location)) return null
  const record = location as Record<string, unknown>
  const direct = normalizeStateCode(record.state) ?? normalizeStateCode(record.region) ?? normalizeStateCode(record.state_code)
  if (direct) return direct
  const formatted = typeof record.formatted === "string" ? record.formatted : typeof record.address === "string" ? record.address : null
  return formatted ? locationState(formatted) : null
}

export function stateName(code: string | null | undefined): string | null {
  if (!code) return null
  return STATE_NAMES[code.toUpperCase()] ?? null
}

/**
 * The governing state for a waiver on this project.
 * Property first; the org's policy default second; nothing third.
 */
export function resolveWaiverJurisdiction(input: {
  projectLocation: unknown
  policyDefault?: string | null
}): string | null {
  return locationState(input.projectLocation) ?? normalizeStateCode(input.policyDefault) ?? null
}
