/**
 * The invoice book's bulk selection is a list of ids that must keep meaning
 * "the rows I can see and have not finished": hidden rows leave it, and rows an
 * action already completed leave it, so a retry never repeats finished work.
 */

/** Selected ids that are still among the visible rows, in selection order. */
export function selectionStillVisible(selectedIds: readonly string[], visibleIds: Iterable<string>): string[] {
  const visible = new Set(visibleIds)
  return selectedIds.filter((id) => visible.has(id))
}

/** After a bulk run only the rows that failed stay selected. */
export function selectionAfterBulk(selectedIds: readonly string[], failedIds: ReadonlySet<string>): string[] {
  return selectedIds.filter((id) => failedIds.has(id))
}
