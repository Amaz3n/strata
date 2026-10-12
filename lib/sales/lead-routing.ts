/**
 * Who a new lead belongs to. Pure: the service reads the org's rules, the
 * community's consultants and who may take the lead, and this decides.
 *
 * Order, first answer wins:
 *   1. an active routing rule that matches (priority, then oldest), for the
 *      exceptions — "Zillow leads go to the online sales counselor";
 *   2. the community's sales consultants, round-robin: whoever was handed a new
 *      lead in this community least recently;
 *   3. the division's fallback owner;
 *   4. the source's default owner;
 *   5. nobody — the lead is filed unrouted and shows on the desk until someone
 *      takes it.
 *
 * Every candidate must be able to work leads and reach the community's
 * division; anyone skipped is named in the reason, so "why did this go to
 * Pat?" has an answer on the delivery log.
 */

export const LEAD_ROUTING_OUTCOMES = [
  "rule",
  "community_assignee",
  "division_default",
  "source_default",
  "existing_owner",
  "unrouted",
] as const

export type LeadRoutingOutcome = (typeof LEAD_ROUTING_OUTCOMES)[number]

export const LEAD_ROUTING_OUTCOME_LABELS: Record<LeadRoutingOutcome, string> = {
  rule: "Routing rule",
  community_assignee: "Community rotation",
  division_default: "Division fallback",
  source_default: "Source default",
  existing_owner: "Existing owner",
  unrouted: "Unrouted",
}

export function isLeadRoutingOutcome(value: unknown): value is LeadRoutingOutcome {
  return LEAD_ROUTING_OUTCOMES.some((outcome) => outcome === value)
}

export interface LeadRoutingRule {
  id: string
  name: string
  priority: number
  createdAt: string
  isActive: boolean
  sourceId: string | null
  communityId: string | null
  divisionId: string | null
  utmSource: string | null
  utmCampaign: string | null
  assignedUserId: string
}

export interface LeadRoutingInput {
  lead: {
    sourceId: string | null
    communityId: string | null
    divisionId: string | null
    utmSource: string | null
    utmCampaign: string | null
  }
  rules: LeadRoutingRule[]
  /** The community's sales consultants. Order does not matter; recency decides. */
  communityAssignees: Array<{ userId: string; lastAssignedAt: string | null }>
  divisionDefaultUserId: string | null
  sourceDefaultUserId: string | null
  /** Who may take this lead: works leads, reaches the division. */
  eligibleUserIds: ReadonlySet<string>
}

export interface LeadRoutingDecision {
  ownerUserId: string | null
  outcome: LeadRoutingOutcome
  reason: string
  /**
   * For the community rotation, every eligible consultant in turn order. Two
   * leads routed at the same moment read the same recency, so filing re-takes
   * the turn from this pool under the community's lock; empty otherwise.
   */
  rotation: string[]
}

function sameText(a: string | null, b: string | null) {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase()
}

function ruleMatches(rule: LeadRoutingRule, lead: LeadRoutingInput["lead"]) {
  return (
    rule.isActive &&
    (rule.sourceId === null || rule.sourceId === lead.sourceId) &&
    (rule.communityId === null || rule.communityId === lead.communityId) &&
    (rule.divisionId === null || rule.divisionId === lead.divisionId) &&
    (rule.utmSource === null || sameText(rule.utmSource, lead.utmSource)) &&
    (rule.utmCampaign === null || sameText(rule.utmCampaign, lead.utmCampaign))
  )
}

function skippedNote(count: number) {
  if (count === 0) return ""
  return count === 1 ? " (1 candidate skipped: cannot take leads here)" : ` (${count} candidates skipped: cannot take leads here)`
}

export function routeLead(input: LeadRoutingInput): LeadRoutingDecision {
  const eligible = (userId: string | null): userId is string => userId !== null && input.eligibleUserIds.has(userId)
  let skipped = 0

  const rules = input.rules
    .filter((rule) => ruleMatches(rule, input.lead))
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  for (const rule of rules) {
    if (eligible(rule.assignedUserId)) {
      return { ownerUserId: rule.assignedUserId, outcome: "rule", reason: `Rule “${rule.name}”${skippedNote(skipped)}`, rotation: [] }
    }
    skipped += 1
  }

  if (input.lead.communityId) {
    const rotation = [...input.communityAssignees].sort(
      (a, b) =>
        (a.lastAssignedAt ?? "").localeCompare(b.lastAssignedAt ?? "") || a.userId.localeCompare(b.userId),
    )
    const takers = rotation.filter((assignee) => eligible(assignee.userId))
    skipped += rotation.length - takers.length
    const next = takers[0]
    if (next) {
      return {
        ownerUserId: next.userId,
        outcome: "community_assignee",
        reason: `Next of ${takers.length} community consultant${takers.length === 1 ? "" : "s"}${skippedNote(skipped)}`,
        rotation: takers.map((taker) => taker.userId),
      }
    }
  }

  if (input.divisionDefaultUserId) {
    if (eligible(input.divisionDefaultUserId)) {
      return { ownerUserId: input.divisionDefaultUserId, outcome: "division_default", reason: `Division fallback owner${skippedNote(skipped)}`, rotation: [] }
    }
    skipped += 1
  }

  if (input.sourceDefaultUserId) {
    if (eligible(input.sourceDefaultUserId)) {
      return { ownerUserId: input.sourceDefaultUserId, outcome: "source_default", reason: `Source default owner${skippedNote(skipped)}`, rotation: [] }
    }
    skipped += 1
  }

  return {
    ownerUserId: null,
    outcome: "unrouted",
    reason: input.lead.communityId
      ? `No consultant can take leads for this community${skippedNote(skipped)}`
      : `No community and no default owner${skippedNote(skipped)}`,
    rotation: [],
  }
}
