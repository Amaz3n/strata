/**
 * When to ask a subcontractor for a lien waiver again.
 *
 * Chasing used to be one deduplicated email per payable, sent the first time a
 * payment run noticed the hold. If the sub did not act on it, nothing ever
 * asked again, and the payable sat blocked until somebody noticed by hand.
 *
 * There are two documents to chase and they are not the same conversation:
 *
 * - The SIGNATURE chase asks for the conditional (and, where retainage is
 *   held, the final) waiver that releases the payment. It is urgent because
 *   the sub's own money is waiting on it, so it repeats sooner and more often.
 * - The UNCONDITIONAL chase happens after the payable has been paid. Nothing
 *   is blocked by it, but the builder still needs it for the owner's package,
 *   the lender and the title company, and it is the document the sub is least
 *   motivated to send. It is patient and gives up sooner.
 *
 * Pure so the cadence is testable without a database or a clock.
 */

export type WaiverChaseKind = "signature" | "unconditional"

export interface WaiverChaseFacts {
  billId: string
  projectId: string | null
  /** Org policy or the project's sub-tier rule asks for a waiver on this payable. */
  waiverRequired: boolean
  /** `vendor_bills.lien_waiver_status === "received"`. */
  waiverReceived: boolean
  paidInFull: boolean
  paidAt: string | null
  /** A signed unconditional or final waiver already exists on the payable. */
  hasUnconditional: boolean
  /** Chasing an address nobody reads is noise, not diligence. */
  hasVendorEmail: boolean
  lastChase: { kind: WaiverChaseKind; at: string; attempt: number } | null
}

export interface WaiverChasePlan {
  billId: string
  projectId: string
  kind: WaiverChaseKind
  /** 1 for the first ask. Drives the copy and the next interval. */
  attempt: number
}

/**
 * Days to wait before each attempt, measured from the previous one. The first
 * entry is the wait before the FIRST ask: a signature chase goes out at once
 * because the hold is already live, while an unconditional waiver is not asked
 * for the moment the payment clears.
 */
const INTERVAL_DAYS: Record<WaiverChaseKind, number[]> = {
  signature: [0, 3, 4, 7, 7],
  unconditional: [2, 7, 7],
}

const DAY_MS = 86_400_000

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.POSITIVE_INFINITY
  return (to - from) / DAY_MS
}

/** Which document, if any, this payable still owes. */
export function waiverChaseKind(facts: WaiverChaseFacts): WaiverChaseKind | null {
  if (!facts.waiverRequired || !facts.projectId) return null
  // The releasing waiver comes first even on a paid payable: a bill that was
  // paid without one is a gap in the record, not a reason to stop asking.
  if (!facts.waiverReceived) return "signature"
  if (facts.paidInFull && !facts.hasUnconditional) return "unconditional"
  return null
}

/**
 * The chase this payable is due for right now, or null. `nowIso` is passed in
 * rather than read, so a sweep evaluates every payable against one instant.
 */
export function planWaiverChase(facts: WaiverChaseFacts, nowIso: string): WaiverChasePlan | null {
  if (!facts.hasVendorEmail) return null
  const kind = waiverChaseKind(facts)
  if (!kind || !facts.projectId) return null

  const intervals = INTERVAL_DAYS[kind]
  // A chase of a different kind does not count against this one's attempts:
  // asking for the unconditional waiver is a new conversation.
  const previous = facts.lastChase && facts.lastChase.kind === kind ? facts.lastChase : null
  const attempt = (previous?.attempt ?? 0) + 1
  if (attempt > intervals.length) return null

  const waitDays = intervals[attempt - 1]
  const since = previous?.at ?? (kind === "unconditional" ? facts.paidAt : null)
  // No previous ask and no clock to measure from: the wait has already passed.
  if (since && daysBetween(since, nowIso) < waitDays) return null

  return { billId: facts.billId, projectId: facts.projectId, kind, attempt }
}

/** How many times each kind is ever asked. */
export function maxWaiverChaseAttempts(kind: WaiverChaseKind): number {
  return INTERVAL_DAYS[kind].length
}

/** The shape stored at `vendor_bills.metadata.waiver_chase`. */
export function readLastWaiverChase(
  metadata: Record<string, unknown> | null | undefined,
): WaiverChaseFacts["lastChase"] {
  const raw = metadata?.waiver_chase
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const kind = record.kind === "unconditional" ? "unconditional" : record.kind === "signature" ? "signature" : null
  const at = typeof record.at === "string" ? record.at : null
  const attempt = Number(record.attempt ?? 0)
  if (!kind || !at || !Number.isFinite(attempt) || attempt < 1) return null
  return { kind, at, attempt: Math.floor(attempt) }
}
