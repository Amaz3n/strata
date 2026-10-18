/**
 * Pure selection-side policy: when a change actually *is* post-cutoff, which
 * package members a package applies to, and whether a purchase agreement still
 * locks structural options. Routing a change's cost onto the purchase orders
 * that own it happens inside the change order's approval
 * (`create_change_order_variance_orders`), so the buyer's price and the trades'
 * cost land together.
 */

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
