import { randomUUID } from "node:crypto"
import type { NextRequest } from "next/server"

import type { CronRunFacts } from "@/lib/ops/cron-health"
import { withCorrelation } from "@/lib/observability/correlation"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

// Registry of every scheduled job. `schedule` mirrors vercel.json (source of
// truth for when Vercel fires the route); `expectedIntervalMinutes` is the
// cadence the Ops page uses to flag a job as overdue; `maxDurationSeconds`
// mirrors the route's function limit (vercel.json `functions`, or the route's
// own `maxDuration`, else the platform default of 300), which is how long a
// started run may stay `running` before it counts as dead.
export interface CronJobDefinition {
  name: string
  path: string
  schedule: string
  scheduleLabel: string
  expectedIntervalMinutes: number
  maxDurationSeconds: number
}

export const CRON_JOBS: CronJobDefinition[] = [
  { name: "accounting-process-outbox", path: "/api/accounting/process-outbox", schedule: "*/10 * * * *", scheduleLabel: "Every 10 min", expectedIntervalMinutes: 10, maxDurationSeconds: 120 },
  { name: "accounting-process-changes", path: "/api/accounting/process-changes", schedule: "*/15 * * * *", scheduleLabel: "Every 15 min", expectedIntervalMinutes: 15, maxDurationSeconds: 120 },
  { name: "accounting-process-inbound", path: "/api/accounting/process-inbound", schedule: "5-59/15 * * * *", scheduleLabel: "Every 15 min", expectedIntervalMinutes: 15, maxDurationSeconds: 120 },
  // Carries notification delivery, so its cadence is how long someone waits to
  // be told a payable needs them. An hour behind the in-app badge made email
  // the slower channel for the one queue people work from email.
  { name: "process-outbox", path: "/api/jobs/process-outbox", schedule: "*/10 * * * *", scheduleLabel: "Every 10 min", expectedIntervalMinutes: 10, maxDurationSeconds: 300 },
  { name: "drawings-pipeline", path: "/api/jobs/drawings-pipeline", schedule: "* * * * *", scheduleLabel: "Every minute", expectedIntervalMinutes: 1, maxDurationSeconds: 800 },
  { name: "specs-pipeline", path: "/api/jobs/specs-pipeline", schedule: "*/5 * * * *", scheduleLabel: "Every 5 min", expectedIntervalMinutes: 5, maxDurationSeconds: 300 },
  { name: "meeting-transcription", path: "/api/jobs/meeting-transcription", schedule: "*/5 * * * *", scheduleLabel: "Every 5 min", expectedIntervalMinutes: 5, maxDurationSeconds: 300 },
  { name: "meeting-audio-cleanup", path: "/api/jobs/meeting-audio-cleanup", schedule: "10 3 * * *", scheduleLabel: "Daily 3:10 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 120 },
  { name: "rbac-evidence", path: "/api/jobs/rbac-evidence", schedule: "15 2 * * *", scheduleLabel: "Daily 2:15 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 60 },
  { name: "weekly-executive-snapshot", path: "/api/jobs/weekly-executive-snapshot", schedule: "0 13 * * 5", scheduleLabel: "Fridays 13:00 UTC", expectedIntervalMinutes: 10080, maxDurationSeconds: 300 },
  { name: "follow-up-reminders", path: "/api/jobs/follow-up-reminders", schedule: "0 13 * * *", scheduleLabel: "Daily 13:00 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 120 },
  { name: "reminders", path: "/api/jobs/reminders", schedule: "15 13 * * *", scheduleLabel: "Daily 13:15 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 120 },
  { name: "compliance-autopilot", path: "/api/jobs/compliance-autopilot", schedule: "20 13 * * *", scheduleLabel: "Daily 13:20 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 180 },
  { name: "esign", path: "/api/jobs/esign", schedule: "25 13 * * *", scheduleLabel: "Daily 13:25 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 120 },
  { name: "late-fees", path: "/api/jobs/late-fees", schedule: "30 13 * * *", scheduleLabel: "Daily 13:30 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 120 },
  // The money tick. Release and submission recovery are minute-sensitive; the
  // security and reconciliation halves of the old payment-controls job are not.
  { name: "payment-release", path: "/api/jobs/payment-release", schedule: "*/5 * * * *", scheduleLabel: "Every 5 min", expectedIntervalMinutes: 5, maxDurationSeconds: 300 },
  { name: "payment-controls", path: "/api/jobs/payment-controls", schedule: "35 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60, maxDurationSeconds: 120 },
  { name: "payment-reconciliation", path: "/api/jobs/payment-reconciliation", schedule: "50 13 * * *", scheduleLabel: "Daily 13:50 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 300 },
  { name: "task-reminders", path: "/api/jobs/task-reminders", schedule: "*/15 * * * *", scheduleLabel: "Every 15 min", expectedIntervalMinutes: 15, maxDurationSeconds: 120 },
  { name: "selection-cutoff-sweep", path: "/api/jobs/selection-cutoff-sweep", schedule: "45 12 * * *", scheduleLabel: "Daily 12:45 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 300 },
  { name: "purchasing-maintenance", path: "/api/jobs/purchasing-maintenance", schedule: "50 12 * * *", scheduleLabel: "Daily 12:50 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 300 },
  { name: "starts-pipeline", path: "/api/jobs/starts-pipeline", schedule: "*/5 * * * *", scheduleLabel: "Every 5 min", expectedIntervalMinutes: 5, maxDurationSeconds: 300 },
  { name: "warranty-sla-sweep", path: "/api/jobs/warranty-sla-sweep", schedule: "5 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60, maxDurationSeconds: 120 },
  { name: "lot-hold-sweep", path: "/api/jobs/lot-hold-sweep", schedule: "10 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60, maxDurationSeconds: 120 },
  { name: "takedown-reminders", path: "/api/jobs/takedown-reminders", schedule: "55 12 * * *", scheduleLabel: "Daily 12:55 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 120 },
  { name: "permit-reminders", path: "/api/jobs/permit-reminders", schedule: "5 13 * * *", scheduleLabel: "Daily 13:05 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 120 },
  { name: "warranty-courtesy-inspections", path: "/api/jobs/warranty-courtesy-inspections", schedule: "10 12 * * *", scheduleLabel: "Daily 12:10 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 300 },
  { name: "invoice-schedules", path: "/api/jobs/invoice-schedules", schedule: "40 13 * * *", scheduleLabel: "Daily 13:40 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 300 },
  { name: "forecast-snapshots", path: "/api/jobs/forecast-snapshots", schedule: "15 4 * * *", scheduleLabel: "Daily 04:15 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 300 },
  // Standing assistant questions. Hourly so an "hourly" cadence is actually
  // hourly; a daily question simply is not due on most ticks.
  { name: "ai-standing-questions", path: "/api/jobs/ai-standing-questions", schedule: "40 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60, maxDurationSeconds: 300 },
  { name: "books-projection", path: "/api/jobs/books-projection", schedule: "*/10 * * * *", scheduleLabel: "Every 10 min", expectedIntervalMinutes: 10, maxDurationSeconds: 300 },
  { name: "books-maintenance", path: "/api/jobs/books-maintenance", schedule: "15 5 * * *", scheduleLabel: "Daily 05:15 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 300 },
  { name: "accounting-reconciliation", path: "/api/jobs/accounting-reconciliation", schedule: "45 4 * * *", scheduleLabel: "Daily 04:45 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 300 },
  { name: "bank-feed-sync", path: "/api/jobs/bank-feed-sync", schedule: "*/15 * * * *", scheduleLabel: "Every 15 min", expectedIntervalMinutes: 15, maxDurationSeconds: 300 },
  { name: "report-schedules", path: "/api/jobs/report-schedules", schedule: "0 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60, maxDurationSeconds: 300 },
  { name: "session-cleanup", path: "/api/jobs/session-cleanup", schedule: "45 3 * * *", scheduleLabel: "Daily 3:45 UTC", expectedIntervalMinutes: 1440, maxDurationSeconds: 60 },
  // Reads every other job's heartbeat. Registered here too, so a watchdog that
  // itself stops running is visible on the same Ops surface.
  { name: "ops-watchdog", path: "/api/jobs/ops-watchdog", schedule: "20 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60, maxDurationSeconds: 300 },
]

const RETENTION_DAYS = 60
const ERROR_SNIPPET_MAX = 2000
/** Past the function limit, a run that has not reported is dead; the grace absorbs clock skew and the write itself. */
const DEADLINE_GRACE_SECONDS = 120
const DEFAULT_MAX_DURATION_SECONDS = 300
const TIMED_OUT_RUN_ERROR = "The runtime ended before the job reported an outcome (past its deadline)"

type RunId = string | number

async function readErrorSnippet(response: Response): Promise<string | null> {
  try {
    const text = await response.clone().text()
    return text ? text.slice(0, ERROR_SNIPPET_MAX) : null
  } catch {
    return null
  }
}

/**
 * Marks every `running` row past its deadline as `timed_out`: the runtime that
 * owned it died without reporting (a function timeout, a crash inside
 * `after()`). Scoped to one job when a run of that job starts; unscoped from
 * the watchdog. Returns how many rows it closed.
 */
export async function reconcileOverdueJobRuns(jobName?: string): Promise<number> {
  const supabase = createServiceSupabaseClient()
  let query = supabase
    .from("job_runs")
    .update({ status: "timed_out", error: TIMED_OUT_RUN_ERROR })
    .eq("status", "running")
    .lt("deadline_at", new Date().toISOString())
  if (jobName) query = query.eq("job_name", jobName)
  const { data, error } = await query.select("id")
  if (error) throw new Error(`Unable to reconcile overdue job runs: ${error.message}`)
  return (data ?? []).length
}

/**
 * What one job's run history says, for `assessCronJob`: the run in flight, the
 * newest run that finished, how many died inside the window, and the last
 * success. Four indexed reads on `job_runs (job_name, started_at desc)`.
 */
export async function loadCronRunFacts(jobName: string, windowMs: number, nowMs: number): Promise<CronRunFacts> {
  const supabase = createServiceSupabaseClient()
  const [inFlight, lastFinished, timedOut, lastSuccess] = await Promise.all([
    supabase.from("job_runs").select("started_at,deadline_at").eq("job_name", jobName).eq("status", "running")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("job_runs").select("status,started_at,duration_ms,error").eq("job_name", jobName).neq("status", "running")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("job_runs").select("id", { count: "exact", head: true }).eq("job_name", jobName).eq("status", "timed_out")
      .gte("started_at", new Date(nowMs - windowMs).toISOString()),
    supabase.from("job_runs").select("started_at").eq("job_name", jobName).eq("status", "success")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  const failure = inFlight.error ?? lastFinished.error ?? timedOut.error ?? lastSuccess.error
  if (failure) throw new Error(`Unable to read the ${jobName} run history: ${failure.message}`)
  return {
    inFlight: inFlight.data ? { startedAt: inFlight.data.started_at, deadlineAt: inFlight.data.deadline_at ?? null } : null,
    lastFinished: lastFinished.data
      ? { status: lastFinished.data.status, startedAt: lastFinished.data.started_at, durationMs: lastFinished.data.duration_ms ?? null, error: lastFinished.data.error ?? null }
      : null,
    timedOutInWindow: timedOut.count ?? 0,
    lastSuccessAt: lastSuccess.data?.started_at ?? null,
  }
}

/** Writes the `running` row a run starts with. Returns its id, or null when telemetry is down. */
async function openRun(jobName: string, startedAt: Date, correlationId: string): Promise<RunId | null> {
  try {
    await reconcileOverdueJobRuns(jobName)
    const maxDurationSeconds = CRON_JOBS.find((job) => job.name === jobName)?.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS
    const deadline = new Date(startedAt.getTime() + (maxDurationSeconds + DEADLINE_GRACE_SECONDS) * 1000)
    const { data, error } = await createServiceSupabaseClient()
      .from("job_runs")
      .insert({ job_name: jobName, status: "running", started_at: startedAt.toISOString(), deadline_at: deadline.toISOString(), correlation_id: correlationId })
      .select("id")
      .single()
    if (error || !data) throw new Error(`Unable to open the run record: ${error?.message ?? "no row returned"}`)
    return data.id as RunId
  } catch (error) {
    // Heartbeat bookkeeping must never break the job itself.
    console.error(`Failed to open job run for ${jobName}`, error)
    return null
  }
}

/** Closes the run's own row with its outcome; without one (telemetry was down at start) writes the finished row. */
async function closeRun(runId: RunId | null, run: {
  jobName: string
  status: "success" | "failed"
  startedAt: Date
  httpStatus: number | null
  error: string | null
  correlationId: string
}) {
  try {
    const supabase = createServiceSupabaseClient()
    const finishedAt = new Date()
    const outcome = {
      status: run.status,
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - run.startedAt.getTime(),
      http_status: run.httpStatus,
      error: run.error,
    }
    const { error: recordError } = runId === null
      ? await supabase.from("job_runs").insert({ job_name: run.jobName, started_at: run.startedAt.toISOString(), correlation_id: run.correlationId, ...outcome })
      // Only a row still running: one the watchdog already closed as timed_out
      // keeps that verdict rather than being rewritten by a late finish.
      : await supabase.from("job_runs").update(outcome).eq("id", runId).eq("status", "running")
    if (recordError) throw new Error(`Unable to persist cron result: ${recordError.message}`)
    const { error: pruneError } = await supabase
      .from("job_runs")
      .delete()
      .lt("started_at", new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString())
    if (pruneError) throw new Error(`Unable to prune cron history: ${pruneError.message}`)
  } catch (error) {
    // Heartbeat bookkeeping must never break the job itself.
    console.error(`Failed to record job run for ${run.jobName}`, error)
  }
}

/**
 * Closes the run a wrapper abandoned before its handler returned (the accounting
 * worker's final cutoff answers 503 and leaves the work behind), so the row
 * reads failed now instead of timing out a deadline later. Matches the job's
 * running row opened at or after `startedAt`; those jobs never overlap a run of
 * their own inside the cutoff.
 */
export async function failAbandonedJobRun(jobName: string, startedAt: Date, error: string, httpStatus: number) {
  const finishedAt = new Date()
  const { error: recordError } = await createServiceSupabaseClient()
    .from("job_runs")
    .update({ status: "failed", finished_at: finishedAt.toISOString(), duration_ms: finishedAt.getTime() - startedAt.getTime(), http_status: httpStatus, error })
    .eq("job_name", jobName)
    .eq("status", "running")
    .gte("started_at", startedAt.toISOString())
  // Heartbeat bookkeeping must never break the job itself.
  if (recordError) console.error(`Failed to close the abandoned run of ${jobName}`, recordError)
}

// Wraps a cron route handler so every invocation lands in job_runs: a `running`
// row with a deadline when it starts, closed with the outcome when it ends. A
// runtime that dies in between leaves the running row, which the next run of
// the job (or the watchdog) closes as `timed_out` — so a job that started and
// died is told apart from one that never started. An unauthorized request is not
// a run: it goes to the handler (which answers 401) before any row is written, so
// a caller without the secret cannot write job telemetry. Thrown errors are recorded as failed runs and rethrown. Every
// write the run makes is correlated to `cron:<job>:<id>`, as its row is.
export function withCronRun(
  jobName: string,
  handler: (request: NextRequest) => Promise<Response>,
) {
  return async (request: NextRequest): Promise<Response> => {
    if (!isAuthorizedCronRequest(request)) return handler(request)
    const startedAt = new Date()
    const correlationId = `cron:${jobName}:${randomUUID()}`
    const runId = await openRun(jobName, startedAt, correlationId)
    let response: Response
    try {
      response = await withCorrelation(correlationId, () => handler(request))
    } catch (error) {
      await closeRun(runId, {
        jobName,
        status: "failed",
        startedAt,
        httpStatus: null,
        error: error instanceof Error ? error.message : String(error),
        correlationId,
      })
      throw error
    }

    // A 207 means the handler ran but some units inside it failed — the convention
    // every fan-out job here uses. `Response.ok` is true for 207, so recording by
    // `ok` alone filed a partial failure as green telemetry, which is the exact
    // shape of every silent-failure defect this system has had: a job reporting
    // success over work that did not happen. `http_status` still tells a partial
    // failure apart from a total one.
    const succeeded = response.ok && response.status !== 207
    await closeRun(runId, {
      jobName,
      status: succeeded ? "success" : "failed",
      startedAt,
      httpStatus: response.status,
      error: succeeded ? null : await readErrorSnippet(response),
      correlationId,
    })
    return response
  }
}
