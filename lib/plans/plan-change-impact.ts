import {
  diffPlanTakeoffs,
  resolveTakeoffLineAmount,
  selectTakeoffLinesForElevation,
  type PlanTakeoffPricingLine,
  type TakeoffDiff,
} from "@/lib/financials/plan-pricing"

/**
 * What a new plan version means for a home that already carries the plan.
 *
 * A home's state decides what adopting the new version can honestly do to it:
 *
 *   unsold      a lot with the plan pinned and no home on it. Nothing is
 *               promised to anyone, so it re-pins.
 *   spec        a home with no binding agreement and no released start. Its
 *               budget, schedule and purchase orders are generated from the pin
 *               at start release, so it re-pins and nothing else moves.
 *   contracted  a binding purchase agreement. The agreement's price and
 *               configuration are locked, so the change is an amendment: a
 *               change order to the buyer for the price delta, and the pin moves
 *               only when the buyer has executed it.
 *   released    the start package was released: the budget and purchase orders
 *               already exist. Adopting is a change order (to the buyer, or an
 *               internal one on a spec home) and, when it executes, draft
 *               variance orders on the purchase orders that carry each changed
 *               cost code; the pin then moves too, because what the house is
 *               being built to has changed. The record of what it was released
 *               at (home_product_revisions) never moves.
 *
 * A home not sold yet is sold on the current edition, so it cannot decline;
 * a sold home can, and the decline is what lets it start on the version it was
 * sold at.
 */

export const AFFECTED_HOME_STATES = ["unsold", "spec", "contracted", "released"] as const
export type AffectedHomeState = (typeof AFFECTED_HOME_STATES)[number]

export const ADOPTION_DECISIONS = ["pending", "adopt", "decline", "defer"] as const
export type AdoptionDecision = (typeof ADOPTION_DECISIONS)[number]

export const AFFECTED_HOME_STATE_LABELS: Record<AffectedHomeState, string> = {
  unsold: "Unsold",
  spec: "Spec",
  contracted: "Contracted",
  released: "Released",
}

export const ADOPTION_DECISION_LABELS: Record<AdoptionDecision, string> = {
  pending: "Pending",
  adopt: "Adopt",
  decline: "Keep current",
  defer: "Deferred",
}

/** Where a home's purchase agreement stands: none, being written, or binding. */
export type AgreementStanding = "none" | "draft" | "binding"

export type AffectedHomeFacts = {
  hasHome: boolean
  agreement: AgreementStanding
  startReleased: boolean
}

export function classifyAffectedHome(facts: AffectedHomeFacts): AffectedHomeState {
  if (facts.startReleased) return "released"
  if (facts.agreement === "binding") return "contracted"
  if (facts.hasHome) return "spec"
  return "unsold"
}

export type AdoptionPath =
  | { kind: "repin" }
  | { kind: "change_order"; buyerSignature: boolean; varianceOrders: boolean }
  | { kind: "blocked"; reason: string }

/**
 * What adopting does to a home in this state, or why it cannot yet. A held lot
 * takes its plan from the agreement written for it, and a home whose agreement
 * is being written would be signed on a version it no longer carries.
 */
export function adoptionPath(input: {
  state: AffectedHomeState
  agreement: AgreementStanding
  held: boolean
  toVersionNumber: number
  toVersionReleased: boolean
}): AdoptionPath {
  if (!input.toVersionReleased) return { kind: "blocked", reason: `Release v${input.toVersionNumber} before homes adopt it.` }
  switch (input.state) {
    case "unsold":
      return input.held
        ? { kind: "blocked", reason: "A buyer is holding this lot; its plan is set by the agreement written for it." }
        : { kind: "repin" }
    case "spec":
      return input.agreement === "draft"
        ? { kind: "blocked", reason: "A purchase agreement is being written on this home. Sign or void it first." }
        : { kind: "repin" }
    case "contracted":
      return { kind: "change_order", buyerSignature: true, varianceOrders: false }
    case "released":
      return { kind: "change_order", buyerSignature: input.agreement === "binding", varianceOrders: true }
  }
}

/** The decisions a reviewer may record for a home in this state. */
export function allowedDecisions(state: AffectedHomeState): AdoptionDecision[] {
  return state === "unsold" || state === "spec" ? ["adopt", "defer"] : ["adopt", "decline", "defer"]
}

/** A decision that can no longer change. */
export function isFinalDecision(decision: AdoptionDecision): boolean {
  return decision === "adopt" || decision === "decline"
}

export const MIN_DECLINE_REASON_LENGTH = 10

export type HomeCostDelta = {
  costDeltaCents: number
  changes: TakeoffDiff[]
  byCostCode: Array<{ costCodeId: string; costDeltaCents: number }>
}

/**
 * The direct-cost difference between the version a home is pinned to and the
 * new one, for the lines that build the home's elevation: the base lines plus
 * that elevation's own. Valued at the takeoff's manual unit costs, the same
 * basis the editions drift reports. `byCostCode` is what variance orders route
 * on; a cost code whose lines net to zero is not a variance.
 */
export function homeCostDelta(
  fromLines: readonly PlanTakeoffPricingLine[],
  toLines: readonly PlanTakeoffPricingLine[],
  elevationId: string | null,
): HomeCostDelta {
  const before = selectTakeoffLinesForElevation([...fromLines], elevationId)
  const after = selectTakeoffLinesForElevation([...toLines], elevationId)
  const changes = diffPlanTakeoffs(before, after)
  const totals = new Map<string, number>()
  const add = (line: PlanTakeoffPricingLine, sign: 1 | -1) => {
    const amount = resolveTakeoffLineAmount(line.quantity, line.unit_cost_cents ?? 0)
    totals.set(line.cost_code_id, (totals.get(line.cost_code_id) ?? 0) + sign * amount)
  }
  for (const line of after) add(line, 1)
  for (const line of before) add(line, -1)
  const byCostCode = [...totals.entries()]
    .filter(([, cents]) => cents !== 0)
    .map(([costCodeId, costDeltaCents]) => ({ costCodeId, costDeltaCents }))
    .sort((a, b) => a.costCodeId.localeCompare(b.costCodeId))
  return {
    costDeltaCents: changes.reduce((sum, change) => sum + change.manual_price_delta_cents, 0),
    changes,
    byCostCode,
  }
}

/** A review is decided once no home in it is still waiting for a decision. */
export function reviewIsDecided(decisions: readonly AdoptionDecision[]): boolean {
  return decisions.every((decision) => decision !== "pending")
}
