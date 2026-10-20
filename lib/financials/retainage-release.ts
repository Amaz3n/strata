/**
 * When retainage a customer is holding is expected to come back.
 *
 * Nothing stores a release date: the contract names a trigger, and the date
 * follows from the job. Substantial completion (the closeout package) is the
 * usual release event and wins when it is known; a trigger that names final
 * completion prefers the job's end date. When the job has neither, the
 * answer is "not set" rather than a guess.
 */

export type RetainageReleaseBasis = "substantial_completion" | "project_end"

export interface ExpectedRetainageRelease {
  /** ISO date, or null when nothing on the job says when. */
  date: string | null
  basis: RetainageReleaseBasis | null
}

export const RETAINAGE_RELEASE_BASIS_LABELS: Record<RetainageReleaseBasis, string> = {
  substantial_completion: "Substantial completion",
  project_end: "Job end date",
}

export const RETAINAGE_RELEASE_NOT_SET = "Not set"

function isoDay(value: string | null | undefined) {
  const match = value ? /^\d{4}-\d{2}-\d{2}/.exec(value) : null
  return match ? match[0] : null
}

export function expectedRetainageRelease(input: {
  releaseTrigger?: string | null
  substantialCompletionDate?: string | null
  projectEndDate?: string | null
}): ExpectedRetainageRelease {
  const substantial = isoDay(input.substantialCompletionDate)
  const projectEnd = isoDay(input.projectEndDate)
  const wantsFinal = /final/i.test(input.releaseTrigger ?? "")
  const candidates: Array<{ date: string | null; basis: RetainageReleaseBasis }> = wantsFinal
    ? [
        { date: projectEnd, basis: "project_end" },
        { date: substantial, basis: "substantial_completion" },
      ]
    : [
        { date: substantial, basis: "substantial_completion" },
        { date: projectEnd, basis: "project_end" },
      ]
  const found = candidates.find((candidate) => candidate.date)
  return found?.date ? { date: found.date, basis: found.basis } : { date: null, basis: null }
}

/** The soonest expected release across jobs; "not set" only when no job has a date. */
export function earliestRetainageRelease(releases: ExpectedRetainageRelease[]): ExpectedRetainageRelease {
  let best: ExpectedRetainageRelease = { date: null, basis: null }
  for (const release of releases) {
    if (release.date && (!best.date || release.date < best.date)) best = release
  }
  return best
}
