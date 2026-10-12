/**
 * Whether a community's entitlements and conditions of approval let a lot be
 * delivered, a house started or a home closed.
 *
 * Every rule lives here, so the starts gate, the community header, the Land tab
 * and the lot inspector all name the same blockers:
 *
 * - An item applies to a lot when it covers the whole community (no phase) or
 *   the lot's phase. A community-level view (`phaseId: undefined`) sees every
 *   phase.
 * - An entitlement blocks a milestone when it must be in hand before it and is
 *   not approved -- or was approved and has since expired.
 * - A condition blocks while it is open.
 * - Milestones are ordered: a start (vertical_start) also needs everything
 *   required before lot delivery. Closing is reported, never enforced here.
 * - A blocker past its due date is overdue, and overdue blockers sort first.
 *
 * Pure: no data access.
 */

export const ENTITLEMENT_MILESTONES = ["lot_delivery", "vertical_start", "closing"] as const
export type EntitlementMilestone = (typeof ENTITLEMENT_MILESTONES)[number]

export const ENTITLEMENT_MILESTONE_LABELS: Record<EntitlementMilestone, string> = {
  lot_delivery: "Lot delivery",
  vertical_start: "Vertical start",
  closing: "Closing",
}

export const ENTITLEMENT_KINDS = [
  "zoning",
  "annexation",
  "preliminary_plat",
  "final_plat",
  "site_plan",
  "development_agreement",
  "utility_service",
  "environmental_permit",
  "other",
] as const
export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number]

export const ENTITLEMENT_KIND_LABELS: Record<EntitlementKind, string> = {
  zoning: "Zoning",
  annexation: "Annexation",
  preliminary_plat: "Preliminary plat",
  final_plat: "Final plat",
  site_plan: "Site plan",
  development_agreement: "Development agreement",
  utility_service: "Utility service",
  environmental_permit: "Environmental permit",
  other: "Other",
}

export const ENTITLEMENT_STATUSES = ["not_started", "submitted", "approved", "denied", "expired", "withdrawn"] as const
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number]

export const ENTITLEMENT_STATUS_LABELS: Record<EntitlementStatus, string> = {
  not_started: "Not started",
  submitted: "Submitted",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  withdrawn: "Withdrawn",
}

export const CONDITION_STATUSES = ["open", "met", "waived"] as const
export type ConditionStatus = (typeof CONDITION_STATUSES)[number]

export interface EntitlementFact {
  id: string
  name: string
  phaseId: string | null
  status: EntitlementStatus
  requiredBefore: EntitlementMilestone | null
  approvedOn: string | null
  expiresOn: string | null
  /** The date it is expected by; drives "overdue" while it is not in hand. */
  dueOn: string | null
}

export interface ConditionFact {
  id: string
  entitlementId: string
  title: string
  phaseId: string | null
  status: ConditionStatus
  requiredBefore: EntitlementMilestone | null
  dueOn: string | null
}

export type EntitlementBlockerReason = "not_approved" | "expired" | "denied" | "unmet"

export interface EntitlementBlocker {
  kind: "entitlement" | "condition"
  id: string
  entitlementId: string
  title: string
  phaseId: string | null
  requiredBefore: EntitlementMilestone
  reason: EntitlementBlockerReason
  dueOn: string | null
  /** Days past due, when it is. */
  overdueDays: number | null
}

function milestoneRank(milestone: EntitlementMilestone) {
  return ENTITLEMENT_MILESTONES.indexOf(milestone)
}

function daysPast(date: string, today: string) {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000)
}

function applies(itemPhaseId: string | null, phaseId: string | null | undefined) {
  if (phaseId === undefined) return true
  return itemPhaseId === null || itemPhaseId === phaseId
}

function entitlementReason(entitlement: EntitlementFact, today: string): EntitlementBlockerReason | null {
  if (entitlement.status === "approved") {
    return entitlement.expiresOn && entitlement.expiresOn < today ? "expired" : null
  }
  if (entitlement.status === "denied") return "denied"
  if (entitlement.status === "expired") return "expired"
  return "not_approved"
}

/**
 * Everything required before `through` (or earlier) that is not in hand, for a
 * lot in `phaseId` (`undefined` = every phase, the community view). Sorted:
 * overdue first (most overdue first), then by due date, then by title.
 */
export function entitlementBlockers(input: {
  entitlements: ReadonlyArray<EntitlementFact>
  conditions: ReadonlyArray<ConditionFact>
  phaseId?: string | null
  through: EntitlementMilestone
  today: string
}): EntitlementBlocker[] {
  const ceiling = milestoneRank(input.through)
  const blockers: EntitlementBlocker[] = []
  const overdue = (dueOn: string | null) => {
    if (!dueOn) return null
    const days = daysPast(dueOn, input.today)
    return days > 0 ? days : null
  }

  for (const entitlement of input.entitlements) {
    if (!entitlement.requiredBefore || milestoneRank(entitlement.requiredBefore) > ceiling) continue
    if (!applies(entitlement.phaseId, input.phaseId)) continue
    const reason = entitlementReason(entitlement, input.today)
    if (!reason) continue
    const dueOn = reason === "expired" && entitlement.status === "approved" ? entitlement.expiresOn : entitlement.dueOn
    blockers.push({
      kind: "entitlement",
      id: entitlement.id,
      entitlementId: entitlement.id,
      title: entitlement.name,
      phaseId: entitlement.phaseId,
      requiredBefore: entitlement.requiredBefore,
      reason,
      dueOn,
      overdueDays: overdue(dueOn),
    })
  }

  for (const condition of input.conditions) {
    if (condition.status !== "open") continue
    if (!condition.requiredBefore || milestoneRank(condition.requiredBefore) > ceiling) continue
    if (!applies(condition.phaseId, input.phaseId)) continue
    blockers.push({
      kind: "condition",
      id: condition.id,
      entitlementId: condition.entitlementId,
      title: condition.title,
      phaseId: condition.phaseId,
      requiredBefore: condition.requiredBefore,
      reason: "unmet",
      dueOn: condition.dueOn,
      overdueDays: overdue(condition.dueOn),
    })
  }

  return blockers.sort((a, b) => {
    const aLate = a.overdueDays ?? -1
    const bLate = b.overdueDays ?? -1
    if (aLate !== bLate) return bLate - aLate
    if (a.dueOn !== b.dueOn) {
      if (a.dueOn === null) return 1
      if (b.dueOn === null) return -1
      return a.dueOn < b.dueOn ? -1 : 1
    }
    return a.title.localeCompare(b.title)
  })
}

export interface PhaseReadiness {
  phaseId: string | null
  /** What holds lot delivery in this phase. */
  delivery: EntitlementBlocker[]
  /** What holds a vertical start in this phase (includes delivery blockers). */
  start: EntitlementBlocker[]
  overdue: number
}

/**
 * Readiness of each phase (and of lots in no phase, `phaseId: null`), for the
 * phases table and the community header.
 */
export function phaseReadiness(input: {
  entitlements: ReadonlyArray<EntitlementFact>
  conditions: ReadonlyArray<ConditionFact>
  phaseIds: ReadonlyArray<string>
  today: string
}): PhaseReadiness[] {
  return [null, ...input.phaseIds].map((phaseId) => {
    const delivery = entitlementBlockers({ ...input, phaseId, through: "lot_delivery" })
    const start = entitlementBlockers({ ...input, phaseId, through: "vertical_start" })
    return { phaseId, delivery, start, overdue: start.filter((blocker) => blocker.overdueDays !== null).length }
  })
}

export interface CommunityEntitlementPressure {
  /** Unmet items required before lot delivery or a start, anywhere in the community. */
  open: number
  overdue: number
}

/** The community header's one number: what is holding delivery or starts anywhere in it. */
export function communityEntitlementPressure(input: {
  entitlements: ReadonlyArray<EntitlementFact>
  conditions: ReadonlyArray<ConditionFact>
  today: string
}): CommunityEntitlementPressure {
  const blockers = entitlementBlockers({ ...input, phaseId: undefined, through: "vertical_start" })
  return { open: blockers.length, overdue: blockers.filter((blocker) => blocker.overdueDays !== null).length }
}
