/**
 * What a bulk release acts on. Selection is a set of ids that outlives the
 * filter it was made under, so both questions are answered against what is on
 * screen now and what the server said still needs a decision.
 */

/** The selected houses that are still visible; a narrowed filter drops the rest from every action. */
export function selectionOnScreen<T extends { id: string }>(visible: readonly T[], selected: ReadonlySet<string>): T[] {
  return visible.filter((pkg) => selected.has(pkg.id))
}

/**
 * First pass releases the whole on-screen selection. Confirming "over target"
 * resends only the houses the server held back: the others were already
 * released or already reported as failed, and must not be forced through.
 */
export function releaseTargetIds(selectedIds: readonly string[], overTargetIds: readonly string[], confirmOverTarget: boolean): string[] {
  return confirmOverTarget ? [...overTargetIds] : [...selectedIds]
}
