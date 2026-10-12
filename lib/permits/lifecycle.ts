/**
 * A permit application's stage, aging and place in the coordinator queue.
 * Stage is derived, never stored: the tables hold submissions, correction
 * rounds, documents and the decision, and these functions read them. The
 * database enforces what an approval needs (record_permit_decision); the
 * blockers here say the same thing early so the workbench can explain a
 * disabled button.
 */

export const PERMIT_TYPES = ["building", "electrical", "plumbing", "mechanical", "roofing", "pool", "right_of_way", "other"] as const
export type PermitType = (typeof PERMIT_TYPES)[number]

export const PERMIT_TYPE_LABELS: Record<PermitType, string> = {
  building: "Building",
  electrical: "Electrical",
  plumbing: "Plumbing",
  mechanical: "Mechanical",
  roofing: "Roofing",
  pool: "Pool",
  right_of_way: "Right-of-way",
  other: "Other",
}

export const PERMIT_DECISIONS = ["approved", "denied", "withdrawn", "not_required"] as const
export type PermitDecision = (typeof PERMIT_DECISIONS)[number]

export const ROUND_STATUSES = ["open", "responded", "resolved", "withdrawn"] as const
export type RoundStatus = (typeof ROUND_STATUSES)[number]

export const PERMIT_STAGES = [
  "draft", "submitted", "corrections_requested", "approved", "not_required", "denied", "withdrawn", "expired", "superseded",
] as const
export type PermitStage = (typeof PERMIT_STAGES)[number]

export const PERMIT_STAGE_LABELS: Record<PermitStage, string> = {
  draft: "Not submitted",
  submitted: "In review",
  corrections_requested: "Corrections requested",
  approved: "Approved",
  not_required: "Not required",
  denied: "Denied",
  withdrawn: "Withdrawn",
  expired: "Expired",
  superseded: "Superseded",
}

/** Days before a due date the queue starts calling it out. */
const PERMIT_DUE_SOON_DAYS = 3

export interface PermitStageFacts {
  decision: PermitDecision | null
  supersededAt: string | null
  expiresOn: string | null
  submissionCount: number
  /** Rounds still waiting on the builder's response. */
  openRounds: number
}

export function permitApplicationStage(facts: PermitStageFacts, today: string): PermitStage {
  if (facts.supersededAt) return "superseded"
  if (facts.decision === "approved") return facts.expiresOn && facts.expiresOn < today ? "expired" : "approved"
  if (facts.decision) return facts.decision
  if (facts.submissionCount === 0) return "draft"
  return facts.openRounds > 0 ? "corrections_requested" : "submitted"
}

/** Whether the authority still owes or is owed something on this application. */
function isPermitInFlight(stage: PermitStage) {
  return stage === "draft" || stage === "submitted" || stage === "corrections_requested"
}

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

export type AgingState = "overdue" | "due_soon" | "on_track"

export interface DueVerdict {
  state: AgingState
  dueOn: string
  /** Days until due (negative when late). */
  daysOut: number
}

function dueVerdict(dueOn: string, today: string): DueVerdict {
  const daysOut = daysBetween(today, dueOn)
  return { state: daysOut < 0 ? "overdue" : daysOut <= PERMIT_DUE_SOON_DAYS ? "due_soon" : "on_track", dueOn, daysOut }
}

export interface PermitAgingInput {
  stage: PermitStage
  expectedDecisionOn: string | null
  /** Unresolved rounds: open ones the builder owes, responded ones the authority owes. */
  rounds: Array<{ status: RoundStatus; dueOn: string | null }>
}

export interface PermitAging {
  /** The authority's decision against its review clock, while one is owed. */
  decision: DueVerdict | null
  /** The builder's earliest response owed on an open round. */
  response: DueVerdict | null
  unresolvedRounds: number
  /** The worst of the two, for ranking and color. */
  attention: AgingState | null
}

const AGING_WEIGHT: Record<AgingState, number> = { overdue: 2, due_soon: 1, on_track: 0 }

export function permitAging(input: PermitAgingInput, today: string): PermitAging {
  const unresolved = input.rounds.filter((round) => round.status === "open" || round.status === "responded")
  const inFlight = isPermitInFlight(input.stage) && input.stage !== "draft"
  // The authority owes a decision while nothing is waiting on the builder.
  const awaitingAuthority = inFlight && !unresolved.some((round) => round.status === "open")
  const decision = awaitingAuthority && input.expectedDecisionOn ? dueVerdict(input.expectedDecisionOn, today) : null
  const responseDue = unresolved
    .filter((round) => round.status === "open" && round.dueOn)
    .map((round) => round.dueOn as string)
    .sort()[0]
  const response = inFlight && responseDue ? dueVerdict(responseDue, today) : null
  const verdicts = [decision, response].filter((verdict): verdict is DueVerdict => verdict !== null)
  const attention = verdicts.length
    ? verdicts.reduce((worst, verdict) => (AGING_WEIGHT[verdict.state] > AGING_WEIGHT[worst.state] ? verdict : worst)).state
    : null
  return { decision, response, unresolvedRounds: inFlight ? unresolved.length : 0, attention }
}

export interface PermitQueueCandidate {
  id: string
  aging: PermitAging
  /** The lot's start target week, when it has a package. */
  startTargetWeek: string | null
}

/**
 * What belongs in the coordinator's queue: an application whose decision or
 * response is overdue or coming due, or which has an unresolved correction
 * round. Ranked by lateness first, then by how soon the house is meant to
 * start (a house targeted next week outranks one with no target), then by how
 * late it is.
 */
export function rankPermitQueue<T extends PermitQueueCandidate>(rows: T[]): T[] {
  const lateness = (row: T) => Math.min(row.aging.decision?.daysOut ?? Infinity, row.aging.response?.daysOut ?? Infinity)
  return rows
    .filter((row) => row.aging.unresolvedRounds > 0 || row.aging.attention === "overdue" || row.aging.attention === "due_soon")
    .sort((a, b) => {
      const weight = AGING_WEIGHT[b.aging.attention ?? "on_track"] - AGING_WEIGHT[a.aging.attention ?? "on_track"]
      if (weight) return weight
      if (a.startTargetWeek !== b.startTargetWeek) {
        if (!a.startTargetWeek) return 1
        if (!b.startTargetWeek) return -1
        return a.startTargetWeek < b.startTargetWeek ? -1 : 1
      }
      return lateness(a) - lateness(b) || a.id.localeCompare(b.id)
    })
}

export interface ApprovalFacts {
  submissionCount: number
  missingDocuments: string[]
  openRounds: number
  /** The lot's pinned plan was captured by a submission. */
  needsReviewedPlan: boolean
  unpaidPreIssuanceFees: string[]
}

/** Why an approval cannot be recorded yet, in the order someone would fix it. */
export function approvalBlockers(facts: ApprovalFacts): string[] {
  const blockers: string[] = []
  if (facts.submissionCount === 0) blockers.push("Record the submission to the authority")
  if (facts.missingDocuments.length) blockers.push(`Attach ${facts.missingDocuments.join(", ")}`)
  if (facts.openRounds > 0) blockers.push(`Respond to ${facts.openRounds === 1 ? "the open correction round" : `${facts.openRounds} open correction rounds`}`)
  if (facts.needsReviewedPlan) blockers.push("Submit with the lot's plan pinned so the approval names the plan reviewed")
  if (facts.unpaidPreIssuanceFees.length) blockers.push(`Pay the fees due before issuance: ${facts.unpaidPreIssuanceFees.join(", ")}`)
  return blockers
}

export type PermitReminder = "due_soon" | "overdue"

export function permitReminderKey(reminder: PermitReminder, scope = "") {
  return scope ? `reminded_${reminder}_${scope}` : `reminded_${reminder}`
}

/**
 * The reminder a date earns today, once each: coming due, then late. `scope`
 * separates reminders that recur (a decision owed per submission).
 */
export function permitReminderDue(dueOn: string, today: string, sent: Record<string, unknown>, scope = ""): PermitReminder | null {
  const verdict = dueVerdict(dueOn, today)
  const reminder: PermitReminder | null = verdict.state === "overdue" ? "overdue" : verdict.state === "due_soon" ? "due_soon" : null
  if (!reminder || sent[permitReminderKey(reminder, scope)]) return null
  return reminder
}
