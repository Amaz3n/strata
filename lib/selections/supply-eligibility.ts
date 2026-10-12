/**
 * Pure supply policy for a selection choice: whether an option can still be
 * had for this home (lead time, released procurement, availability), which
 * alternates can, and how late a change order's choice will land. The facts
 * come from `project_selection_choice_facts`, the same reads the database
 * write checks, so the explanation and the enforcement never disagree.
 */

export type SelectionChoiceFacts = {
  /** The home's community day, `YYYY-MM-DD`. */
  today: string
  timeZone: string
  selectionLocked: boolean
  groupStatus: "open" | "locked" | null
  cutoffDate: string | null
  /** Start of the schedule task the selection's group is anchored to. */
  neededBy: string | null
  releasedPurchaseOrderId: string | null
  releasedPurchaseOrderTitle: string | null
  options: Array<{ optionId: string; leadTimeDays: number | null; orderBy: string | null; waived: boolean }>
}

export type SelectionSupplyCode = "SELECTION_LEAD_TIME" | "SELECTION_PROCUREMENT_RELEASED" | "SELECTION_OPTION_UNAVAILABLE"

export type SelectionSupplyRefusal = {
  code: SelectionSupplyCode
  reason: "lead_time_exceeded" | "procurement_released" | "option_unavailable"
  orderBy: string | null
  message: string
}

export type SelectionAlternate = { optionId: string; name: string; priceCents: number; orderBy: string | null }

/**
 * The home cannot have this option as asked — it cannot arrive in time, the
 * trade already bought the selection, or it is no longer offered. The message
 * is the whole sentence; `reason` is the refusal alone, for a page that lists
 * the alternates itself. An exception is on record for the builder to resolve.
 */
export class SelectionEligibilityError extends Error {
  readonly reason: string
  readonly alternates: SelectionAlternate[]
  readonly exceptionId: string | null

  constructor(
    message: string,
    public readonly code: SelectionSupplyCode,
    detail: { reason?: string; alternates?: SelectionAlternate[]; exceptionId?: string | null } = {},
  ) {
    super(message)
    this.name = "SelectionEligibilityError"
    this.reason = detail.reason ?? message
    this.alternates = detail.alternates ?? []
    this.exceptionId = detail.exceptionId ?? null
  }
}

export function formatSupplyDate(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`). */
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)
}

/**
 * Why this option cannot be chosen directly on this home, or null when it can.
 * Released procurement wins over lead time: the trade already holds the order.
 */
export function supplyRefusal(
  facts: SelectionChoiceFacts,
  option: { optionId: string; name: string; available: boolean },
): SelectionSupplyRefusal | null {
  if (facts.releasedPurchaseOrderId) {
    return {
      code: "SELECTION_PROCUREMENT_RELEASED",
      reason: "procurement_released",
      orderBy: null,
      message: `This selection is already on ${facts.releasedPurchaseOrderTitle ?? "a released purchase order"}. Changing it needs a change order.`,
    }
  }
  if (!option.available) {
    return {
      code: "SELECTION_OPTION_UNAVAILABLE",
      reason: "option_unavailable",
      orderBy: null,
      message: `${option.name} is no longer offered for this home.`,
    }
  }
  const supply = facts.options.find((entry) => entry.optionId === option.optionId)
  if (supply?.orderBy && supply.orderBy < facts.today && !supply.waived) {
    return {
      code: "SELECTION_LEAD_TIME",
      reason: "lead_time_exceeded",
      orderBy: supply.orderBy,
      message: `${option.name} needs ${supply.leadTimeDays ?? "its"} days to arrive and had to be ordered by ${formatSupplyDate(supply.orderBy)}.`,
    }
  }
  return null
}

/**
 * The options the buyer can still have instead: available for this home and
 * orderable in time, cheapest first. Nothing is offered once procurement is
 * released, because no direct change is possible then.
 */
export function eligibleAlternates(
  facts: SelectionChoiceFacts,
  candidates: ReadonlyArray<{ optionId: string; name: string; priceCents: number; available: boolean }>,
  excludeOptionId: string | null,
  limit = 5,
): SelectionAlternate[] {
  if (facts.releasedPurchaseOrderId) return []
  return candidates
    .filter((candidate) => candidate.optionId !== excludeOptionId && candidate.available)
    .filter((candidate) => !supplyRefusal(facts, candidate))
    .map((candidate) => ({
      optionId: candidate.optionId,
      name: candidate.name,
      priceCents: candidate.priceCents,
      orderBy: facts.options.find((entry) => entry.optionId === candidate.optionId)?.orderBy ?? null,
    }))
    .sort((left, right) => left.priceCents - right.priceCents || left.name.localeCompare(right.name))
    .slice(0, limit)
}

/**
 * How many days late an option ordered today lands against the task it is
 * needed for: the schedule impact a change order for it should carry.
 */
export function suggestedScheduleImpactDays(facts: SelectionChoiceFacts, optionId: string) {
  const supply = facts.options.find((entry) => entry.optionId === optionId)
  if (!supply?.orderBy || supply.waived) return 0
  return Math.max(0, daysBetween(supply.orderBy, facts.today))
}

export type SelectionExceptionReason = "option_unavailable" | "lead_time_exceeded" | "procurement_released" | "variance_unrouted"
export type SelectionExceptionStatus = "open" | "resolved_alternate" | "resolved_change_order" | "resolved_manual" | "waived" | "void"

export const SELECTION_EXCEPTION_REASON_LABELS: Record<SelectionExceptionReason, string> = {
  option_unavailable: "No longer offered",
  lead_time_exceeded: "Cannot arrive in time",
  procurement_released: "Already purchased",
  variance_unrouted: "Cost change has no purchase order",
}

export const SELECTION_EXCEPTION_STATUS_LABELS: Record<SelectionExceptionStatus, string> = {
  open: "Open",
  resolved_alternate: "Alternate chosen",
  resolved_change_order: "Change order",
  resolved_manual: "Handled by hand",
  waived: "Expedite approved",
  void: "Dismissed",
}
