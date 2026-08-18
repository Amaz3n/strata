/**
 * Pure selection-side policy: what a post-cutoff change costs the trades, when
 * a change actually *is* post-cutoff, which package members a package applies
 * to, and whether a purchase agreement still locks structural options.
 *
 * The buyer-facing change order carries the price. The commitments carry the
 * cost. Nothing reconciles the two unless every cost delta is routed onto the
 * purchase order that owns its cost code, so that routing lives here where it
 * can be tested without a database.
 */

export type SelectionCostDelta = {
  selection_id: string
  cost_code_id: string | null
  cost_delta_cents: number
  category_name: string
  option_name: string
}

/** cost_code_id → the purchase order that carries it. */
export type CommitmentByCostCode = ReadonlyMap<string, { commitmentId: string; companyId: string | null }>

export type PlannedVarianceOrderLine = {
  selection_id: string
  cost_code_id: string
  description: string
  unit_cost_cents: number
}

export type PlannedVarianceOrder = {
  commitment_id: string
  company_id: string | null
  total_cents: number
  selection_ids: string[]
  lines: PlannedVarianceOrderLine[]
}

export type UnroutedSelectionDelta = {
  selection_id: string
  cost_code_id: string | null
  cost_delta_cents: number
  description: string
  reason: "no_cost_code" | "no_commitment"
}

export function describeSelectionChange(change: Pick<SelectionCostDelta, "category_name" | "option_name">) {
  return `${change.category_name} — ${change.option_name}`
}

/**
 * Fan a set of executed selection changes out onto the purchase orders that
 * own their cost codes. A zero delta is not a variance and produces nothing;
 * a delta with nowhere to land is reported rather than dropped.
 */
export function planSelectionVarianceOrders(input: {
  changes: readonly SelectionCostDelta[]
  commitmentByCostCode: CommitmentByCostCode
}): { orders: PlannedVarianceOrder[]; unrouted: UnroutedSelectionDelta[] } {
  const orders = new Map<string, PlannedVarianceOrder>()
  const unrouted: UnroutedSelectionDelta[] = []

  for (const change of input.changes) {
    const deltaCents = Math.round(Number(change.cost_delta_cents ?? 0))
    if (!Number.isFinite(deltaCents) || deltaCents === 0) continue
    const description = describeSelectionChange(change)
    if (!change.cost_code_id) {
      unrouted.push({ selection_id: change.selection_id, cost_code_id: null, cost_delta_cents: deltaCents, description, reason: "no_cost_code" })
      continue
    }
    const target = input.commitmentByCostCode.get(change.cost_code_id)
    if (!target) {
      unrouted.push({ selection_id: change.selection_id, cost_code_id: change.cost_code_id, cost_delta_cents: deltaCents, description, reason: "no_commitment" })
      continue
    }
    const order = orders.get(target.commitmentId) ?? {
      commitment_id: target.commitmentId,
      company_id: target.companyId,
      total_cents: 0,
      selection_ids: [],
      lines: [],
    }
    order.total_cents += deltaCents
    order.selection_ids.push(change.selection_id)
    order.lines.push({
      selection_id: change.selection_id,
      cost_code_id: change.cost_code_id,
      description,
      unit_cost_cents: deltaCents,
    })
    orders.set(target.commitmentId, order)
  }

  return { orders: Array.from(orders.values()), unrouted }
}

export type SelectionCutoffState = {
  /** Set once the selection itself is frozen, independent of its group. */
  selectionLockedAt: string | null
  group: { status: string | null; cutoff_date: string | null } | null
  /** ISO date, `YYYY-MM-DD`. */
  today: string
}

/**
 * A change is only "post-cutoff" — and therefore only chargeable as one — once
 * the selection is frozen or its group is locked or past its date. Charging
 * the fee before that point bills the buyer for a change they were still
 * entitled to make for free.
 */
export function isSelectionPastCutoff(state: SelectionCutoffState): boolean {
  if (state.selectionLockedAt) return true
  if (!state.group) return false
  if (state.group.status === "locked") return true
  return Boolean(state.group.cutoff_date && state.group.cutoff_date < state.today)
}

/**
 * Contract statuses under which a purchase agreement still binds the buyer.
 * A voided, superseded or draft agreement does not — otherwise voiding a
 * spec home's agreement would leave its structural options locked forever.
 */
export const BINDING_AGREEMENT_STATUSES: readonly string[] = ["active", "signed", "executed"]

export function agreementLocksStructuralOptions(
  agreement: { status: string | null; signed_at: string | null } | null | undefined,
): boolean {
  if (!agreement?.signed_at) return false
  return BINDING_AGREEMENT_STATUSES.includes(agreement.status ?? "")
}

export type PackageMember = { option_id: string; category_id: string | null }
export type PackageTargetSelection = { id: string; category_id: string; group_id: string | null }
export type PlannedPackageMember = { selectionId: string; optionId: string; categoryId: string; index: number }

/**
 * Resolve every package member onto exactly one selection, anchored on a
 * single selection group — the same rule the post-cutoff change-order path
 * applies. A package whose categories straddle two groups would otherwise
 * write across a cutoff boundary, so it is rejected as a catalog error
 * instead of half-applied.
 */
export function planPackageSelection(input: {
  members: readonly PackageMember[]
  selections: readonly PackageTargetSelection[]
}): { groupId: string | null; members: PlannedPackageMember[] } {
  if (input.members.length === 0) throw new Error("Package has no available options")
  if (input.members.some((member) => !member.category_id)) {
    throw new Error("Package contains an option with no category")
  }

  const categoryIds = input.members.map((member) => member.category_id)
  const candidates = input.selections.filter((selection) => categoryIds.includes(selection.category_id))
  const groupIds = Array.from(new Set(candidates.map((selection) => selection.group_id)))
  if (groupIds.length > 1) {
    throw new Error("This package spans more than one selection group — split it so each package sits in one group")
  }

  const members = input.members.map((member, index) => {
    const selection = candidates.find((candidate) => candidate.category_id === member.category_id)
    if (!selection) throw new Error("Package does not match this lot's selection groups")
    return { selectionId: selection.id, optionId: member.option_id, categoryId: selection.category_id, index }
  })

  const distinct = new Set(members.map((member) => member.selectionId))
  if (distinct.size !== members.length) {
    throw new Error("Package assigns more than one option to the same selection")
  }

  return { groupId: groupIds[0] ?? null, members }
}
