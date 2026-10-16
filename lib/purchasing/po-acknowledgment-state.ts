import type { PoAckState, PoIssueSnapshot } from "@/lib/validation/po-acknowledgments"

/**
 * What a vendor's answer means for ONE issued purchase order. The state is
 * derived from the order's current version and the latest answer to it, never
 * stored: an answer to an earlier version says nothing about this one, so a VPO
 * or a re-issue puts the order back in front of the vendor by itself.
 */

export interface PoAckAnswer {
  response: "accepted" | "disputed"
  status: "open" | "resolved"
  resolution: "upheld" | "withdrawn" | null
}

export function derivePoAckState(input: {
  /** The latest non-superseded answer to the CURRENT version, if any. */
  answer: PoAckAnswer | null
  /** The vendor has answered an earlier version of this order. */
  answeredEarlierVersion: boolean
  /** The current version is a migration backfill nobody was asked to answer. */
  versionIsBackfill: boolean
}): PoAckState {
  const { answer } = input
  if (!answer) {
    if (input.answeredEarlierVersion) return "revised"
    return input.versionIsBackfill ? "unrequested" : "pending"
  }
  if (answer.status === "open") return answer.response === "accepted" ? "accepted" : "disputed"
  return answer.resolution === "withdrawn" ? "closed" : "pending"
}

/** States that put a purchase order on someone's list. */
export const PO_ACK_ACTION_STATES: readonly PoAckState[] = ["disputed", "revised", "pending"]

export const PO_ACK_STATE_LABELS: Record<PoAckState, string> = {
  unrequested: "Not requested",
  pending: "Awaiting vendor",
  revised: "Revised, awaiting vendor",
  disputed: "Disputed",
  accepted: "Accepted",
  closed: "Dispute closed",
}

/** What the vendor sees next to the version, in its own words. */
export function poAckVendorSentence(state: PoAckState, revision: number): string {
  switch (state) {
    case "pending": return revision > 1 ? `Revision ${revision} issued. Please accept or dispute it.` : "Issued to you. Please accept or dispute it."
    case "revised": return `Revision ${revision} issued after your last answer. Please answer it.`
    case "disputed": return "You disputed this order. The builder will respond."
    case "accepted": return "You accepted this order."
    case "closed": return "The builder closed your dispute."
    case "unrequested": return "Issued to you."
  }
}

/**
 * Whether completing or paying this order deserves a warning. Acknowledgment
 * gates nothing; a disputed or unanswered current version is only worth saying.
 */
export function poAckWarning(state: PoAckState): string | null {
  switch (state) {
    case "disputed": return "The vendor disputes this purchase order."
    case "pending": return "The vendor has not acknowledged this purchase order."
    case "revised": return "The vendor has not acknowledged the latest revision of this purchase order."
    default: return null
  }
}

const money = (cents: number | null) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100)

/**
 * What changed between two issued versions, as sentences. Lines are matched by
 * id; a variance order is a change of its own. Nothing to say returns [].
 */
export function describeVersionChanges(previous: PoIssueSnapshot | null, current: PoIssueSnapshot): string[] {
  if (!previous) return []
  const changes: string[] = []
  const header: Array<[string, string | null, string | null]> = [
    ["Title", previous.title, current.title],
    ["Scope", previous.scope, current.scope],
    ["Terms", previous.terms, current.terms],
    ["Start date", previous.start_date, current.start_date],
    ["End date", previous.end_date, current.end_date],
  ]
  for (const [label, before, after] of header) {
    if ((before ?? "") !== (after ?? "")) changes.push(`${label} changed`)
  }
  const before = new Map(previous.lines.map((line) => [line.id, line]))
  const after = new Map(current.lines.map((line) => [line.id, line]))
  for (const [id, line] of after) {
    const old = before.get(id)
    if (!old) { changes.push(`Line added: ${line.description ?? "line"}`); continue }
    if ((old.quantity ?? 0) !== (line.quantity ?? 0)) changes.push(`${line.description ?? "Line"}: quantity ${old.quantity ?? 0} to ${line.quantity ?? 0}`)
    if ((old.unit_cost_cents ?? 0) !== (line.unit_cost_cents ?? 0)) changes.push(`${line.description ?? "Line"}: unit price ${money(old.unit_cost_cents)} to ${money(line.unit_cost_cents)}`)
  }
  for (const [id, line] of before) if (!after.has(id)) changes.push(`Line removed: ${line.description ?? "line"}`)
  const knownChanges = new Set(previous.changes.map((change) => change.id))
  for (const change of current.changes) if (!knownChanges.has(change.id)) changes.push(`Variance order approved: ${change.title ?? "variance"} (${money(change.total_cents)})`)
  const currentChanges = new Set(current.changes.map((change) => change.id))
  for (const change of previous.changes) if (!currentChanges.has(change.id)) changes.push(`Variance order voided: ${change.title ?? "variance"} (${money(change.total_cents)})`)
  return changes
}

/** What the vendor is held to: the order plus the variance orders approved against it. */
export function revisedObligationCents(snapshot: PoIssueSnapshot): number {
  return (snapshot.total_cents ?? 0) + snapshot.changes.reduce((sum, change) => sum + (change.total_cents ?? 0), 0)
}
