/**
 * Standing-inventory age for spec homes.
 *
 * The 60/90-day tiers a sales manager watches are tiers of *standing* inventory:
 * a finished house nobody has bought. A home still under construction is
 * pipeline, not stale stock, so it has no aging clock — measuring from the
 * ground-breaking date makes every in-progress spec look aged the moment it
 * starts, which is the opposite of the signal.
 */
export type SpecInventoryAge = {
  completedAt: string | null
  underConstruction: boolean
  agingDays: number
}

export function specInventoryAge(
  project: { status?: string | null; end_date?: string | null } | null | undefined,
  now: number = Date.now(),
): SpecInventoryAge {
  const completedAt = project?.status === "completed" && project.end_date ? project.end_date : null
  return {
    completedAt,
    underConstruction: Boolean(project) && !completedAt,
    agingDays: completedAt ? Math.max(0, Math.floor((now - Date.parse(completedAt)) / 86_400_000)) : 0,
  }
}
