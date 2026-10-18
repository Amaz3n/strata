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

/** Homes sent per request: small enough that "n of m" moves, large enough to stay quick. */
export const RELEASE_BATCH_SIZE = 10

/** Splits a long release into the sequential requests that report progress between them. */
export function releaseBatches(ids: readonly string[], size: number = RELEASE_BATCH_SIZE): string[][] {
  const batches: string[][] = []
  for (let index = 0; index < ids.length; index += size) batches.push(ids.slice(index, index + size))
  return batches
}

/**
 * A changed filter rebases the selection onto what the new filter shows, so a
 * hidden home can never rejoin the selection when the filter changes back.
 */
export function rebaseSelection<T extends { id: string }>(visible: readonly T[], selected: ReadonlySet<string>): Set<string> {
  return new Set(selectionOnScreen(visible, selected).map((pkg) => pkg.id))
}

/** After a release run the selection keeps only the homes that are not yet released, so a retry never repeats finished work. */
export function selectionAfterRelease(selectedIds: readonly string[], releasedIds: Iterable<string>): string[] {
  const released = new Set(releasedIds)
  return selectedIds.filter((id) => !released.has(id))
}
