/**
 * Standing-inventory age for spec homes.
 *
 * The 60/90-day tiers a sales manager watches are tiers of *standing* inventory:
 * a finished house nobody has bought. A home still under construction is
 * pipeline, not stale stock, so it has no aging clock — measuring from the
 * ground-breaking date makes every in-progress spec look aged the moment it
 * starts, which is the opposite of the signal.
 *
 * The clock starts at a RECORDED completion fact — the date Books moved the home
 * into finished inventory (`books_inventory_completed_on`). `projects.end_date`
 * is the schedule's plan and is never read here: a home that is late would age
 * before it exists, and one that finished early would not age at all. A home
 * with no recorded completion, or one recorded for a day that has not arrived,
 * reports no age.
 */
export type SpecInventoryAge = {
  completedAt: string | null
  underConstruction: boolean
  agingDays: number
}

const DAY_MS = 86_400_000

export function specInventoryAge(
  project: { status?: string | null } | null | undefined,
  recordedCompletionOn: string | null | undefined,
  now: number = Date.now(),
): SpecInventoryAge {
  if (!project) return { completedAt: null, underConstruction: false, agingDays: 0 }
  const completedMs = recordedCompletionOn ? Date.parse(recordedCompletionOn) : Number.NaN
  if (Number.isNaN(completedMs) || completedMs > now) {
    // Completed on paper but never recorded: finished, with no date to age from.
    return { completedAt: null, underConstruction: project.status !== "completed", agingDays: 0 }
  }
  return {
    completedAt: recordedCompletionOn ?? null,
    underConstruction: false,
    agingDays: Math.floor((now - completedMs) / DAY_MS),
  }
}
