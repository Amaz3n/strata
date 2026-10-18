/**
 * What a scheduled job's run history says about it. Pure: the Ops page and the
 * watchdog both read job_runs and ask this, so they cannot disagree.
 *
 * The distinction that matters for alerting is between work that was never
 * accepted and work that was accepted and never completed:
 *
 *   not-started  the scheduler has not started it inside its window (or ever: no-data)
 *   timed-out    it started, and its runtime died before reporting (a `running`
 *                row past its deadline, or one already reconciled to timed_out)
 *   failing      it ran and reported failure
 *   running      it started and is still inside its deadline
 *   healthy      it succeeded inside its window
 */
export type CronJobState = "healthy" | "running" | "failing" | "timed-out" | "not-started" | "no-data"

export interface CronRunFacts {
  /** The newest run still `running`, if any. */
  inFlight: { startedAt: string; deadlineAt: string | null } | null
  /** The newest run that reported an outcome (success, failed or timed_out). */
  lastFinished: { status: string; startedAt: string; durationMs: number | null; error: string | null } | null
  /** Runs inside the window whose runtime died before reporting. */
  timedOutInWindow: number
  lastSuccessAt: string | null
}

interface CronJobAssessment {
  state: CronJobState
  /** True when no success landed inside the window: the job's work is not being done. */
  stale: boolean
}

/**
 * The run in flight is never the whole story. A job whose deadline is longer
 * than its interval (the drawings pipeline runs every minute with a 15-minute
 * deadline) nearly always has one, and reading only the newest row let a run
 * still inside its deadline hide that every run before it had died or failed.
 * So a run in flight speaks only for itself (past its deadline it has died), and
 * what the job has been doing is read from the runs that finished.
 */
export function assessCronJob(facts: CronRunFacts, windowMs: number, nowMs: number): CronJobAssessment {
  const stale = !facts.lastSuccessAt || nowMs - Date.parse(facts.lastSuccessAt) > windowMs
  const { inFlight, lastFinished } = facts
  if (!inFlight && !lastFinished) return { state: "no-data", stale: true }
  if (inFlight?.deadlineAt && Date.parse(inFlight.deadlineAt) < nowMs) return { state: "timed-out", stale }
  if (lastFinished?.status === "timed_out") return { state: "timed-out", stale }
  if (stale) {
    if (facts.timedOutInWindow > 0) return { state: "timed-out", stale }
    if (lastFinished?.status === "failed" && nowMs - Date.parse(lastFinished.startedAt) <= windowMs) return { state: "failing", stale }
    return { state: "not-started", stale }
  }
  if (inFlight) return { state: "running", stale }
  return { state: lastFinished?.status === "failed" ? "failing" : "healthy", stale }
}

/**
 * The watchdog's question: does this state need a person? A timed-out run always
 * does (accepted work that never completed); a job that has not started, or that
 * keeps failing, does once its work is no longer being done.
 */
export type CronAlertKind = "cron_not_started" | "cron_timed_out" | "cron_failing"

export function cronAlertKind(assessment: CronJobAssessment): CronAlertKind | null {
  if (assessment.state === "timed-out") return "cron_timed_out"
  if (!assessment.stale) return null
  if (assessment.state === "no-data" || assessment.state === "not-started") return "cron_not_started"
  if (assessment.state === "failing") return "cron_failing"
  return null
}

export function cronAlertDetail(kind: CronAlertKind, job: { name: string; scheduleLabel: string }, lastSuccessAt: string | null, nowMs: number): string {
  const since = lastSuccessAt ? `last succeeded ${Math.round((nowMs - Date.parse(lastSuccessAt)) / 60_000)} minutes ago` : "has no successful run on record"
  if (kind === "cron_timed_out") return `${job.name} started but its runtime ended before it reported an outcome (accepted, never completed); it ${since}`
  if (kind === "cron_not_started") return `${job.name} has not been started by the scheduler (${job.scheduleLabel}); it ${since}`
  return `${job.name} runs but keeps failing; it ${since}`
}
