import type { NextRequest } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

// Registry of every scheduled job. `schedule` mirrors vercel.json (source of
// truth for when Vercel fires the route); `expectedIntervalMinutes` is the
// cadence the Ops page uses to flag a job as overdue.
export interface CronJobDefinition {
  name: string
  path: string
  schedule: string
  scheduleLabel: string
  expectedIntervalMinutes: number
}

export const CRON_JOBS: CronJobDefinition[] = [
  { name: "accounting-process-outbox", path: "/api/accounting/process-outbox", schedule: "*/10 * * * *", scheduleLabel: "Every 10 min", expectedIntervalMinutes: 10 },
  { name: "accounting-process-changes", path: "/api/accounting/process-changes", schedule: "*/15 * * * *", scheduleLabel: "Every 15 min", expectedIntervalMinutes: 15 },
  { name: "accounting-process-inbound", path: "/api/accounting/process-inbound", schedule: "5-59/15 * * * *", scheduleLabel: "Every 15 min", expectedIntervalMinutes: 15 },
  // Carries notification delivery, so its cadence is how long someone waits to
  // be told a payable needs them. An hour behind the in-app badge made email
  // the slower channel for the one queue people work from email.
  { name: "process-outbox", path: "/api/jobs/process-outbox", schedule: "*/10 * * * *", scheduleLabel: "Every 10 min", expectedIntervalMinutes: 10 },
  { name: "drawings-pipeline", path: "/api/jobs/drawings-pipeline", schedule: "*/5 * * * *", scheduleLabel: "Every 5 min", expectedIntervalMinutes: 5 },
  { name: "specs-pipeline", path: "/api/jobs/specs-pipeline", schedule: "*/5 * * * *", scheduleLabel: "Every 5 min", expectedIntervalMinutes: 5 },
  { name: "meeting-transcription", path: "/api/jobs/meeting-transcription", schedule: "*/5 * * * *", scheduleLabel: "Every 5 min", expectedIntervalMinutes: 5 },
  { name: "meeting-audio-cleanup", path: "/api/jobs/meeting-audio-cleanup", schedule: "10 3 * * *", scheduleLabel: "Daily 3:10 UTC", expectedIntervalMinutes: 1440 },
  { name: "rbac-evidence", path: "/api/jobs/rbac-evidence", schedule: "15 2 * * *", scheduleLabel: "Daily 2:15 UTC", expectedIntervalMinutes: 1440 },
  { name: "weekly-executive-snapshot", path: "/api/jobs/weekly-executive-snapshot", schedule: "0 13 * * 5", scheduleLabel: "Fridays 13:00 UTC", expectedIntervalMinutes: 10080 },
  { name: "follow-up-reminders", path: "/api/jobs/follow-up-reminders", schedule: "0 13 * * *", scheduleLabel: "Daily 13:00 UTC", expectedIntervalMinutes: 1440 },
  { name: "reminders", path: "/api/jobs/reminders", schedule: "15 13 * * *", scheduleLabel: "Daily 13:15 UTC", expectedIntervalMinutes: 1440 },
  { name: "compliance-autopilot", path: "/api/jobs/compliance-autopilot", schedule: "20 13 * * *", scheduleLabel: "Daily 13:20 UTC", expectedIntervalMinutes: 1440 },
  { name: "esign", path: "/api/jobs/esign", schedule: "25 13 * * *", scheduleLabel: "Daily 13:25 UTC", expectedIntervalMinutes: 1440 },
  { name: "late-fees", path: "/api/jobs/late-fees", schedule: "30 13 * * *", scheduleLabel: "Daily 13:30 UTC", expectedIntervalMinutes: 1440 },
  // The money tick. Release and submission recovery are minute-sensitive; the
  // security and reconciliation halves of the old payment-controls job are not.
  { name: "payment-release", path: "/api/jobs/payment-release", schedule: "*/5 * * * *", scheduleLabel: "Every 5 min", expectedIntervalMinutes: 5 },
  { name: "payment-controls", path: "/api/jobs/payment-controls", schedule: "35 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60 },
  { name: "payment-reconciliation", path: "/api/jobs/payment-reconciliation", schedule: "50 13 * * *", scheduleLabel: "Daily 13:50 UTC", expectedIntervalMinutes: 1440 },
  { name: "task-reminders", path: "/api/jobs/task-reminders", schedule: "*/15 * * * *", scheduleLabel: "Every 15 min", expectedIntervalMinutes: 15 },
  { name: "selection-cutoff-sweep", path: "/api/jobs/selection-cutoff-sweep", schedule: "45 12 * * *", scheduleLabel: "Daily 12:45 UTC", expectedIntervalMinutes: 1440 },
  { name: "purchasing-maintenance", path: "/api/jobs/purchasing-maintenance", schedule: "50 12 * * *", scheduleLabel: "Daily 12:50 UTC", expectedIntervalMinutes: 1440 },
  { name: "starts-pipeline", path: "/api/jobs/starts-pipeline", schedule: "*/5 * * * *", scheduleLabel: "Every 5 min", expectedIntervalMinutes: 5 },
  { name: "warranty-sla-sweep", path: "/api/jobs/warranty-sla-sweep", schedule: "5 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60 },
  { name: "invoice-schedules", path: "/api/jobs/invoice-schedules", schedule: "40 13 * * *", scheduleLabel: "Daily 13:40 UTC", expectedIntervalMinutes: 1440 },
  { name: "forecast-snapshots", path: "/api/jobs/forecast-snapshots", schedule: "15 4 * * *", scheduleLabel: "Daily 04:15 UTC", expectedIntervalMinutes: 1440 },
  { name: "books-projection", path: "/api/jobs/books-projection", schedule: "*/10 * * * *", scheduleLabel: "Every 10 min", expectedIntervalMinutes: 10 },
  { name: "books-maintenance", path: "/api/jobs/books-maintenance", schedule: "15 5 * * *", scheduleLabel: "Daily 05:15 UTC", expectedIntervalMinutes: 1440 },
  { name: "accounting-reconciliation", path: "/api/jobs/accounting-reconciliation", schedule: "45 4 * * *", scheduleLabel: "Daily 04:45 UTC", expectedIntervalMinutes: 1440 },
  { name: "bank-feed-sync", path: "/api/jobs/bank-feed-sync", schedule: "*/15 * * * *", scheduleLabel: "Every 15 min", expectedIntervalMinutes: 15 },
  { name: "report-schedules", path: "/api/jobs/report-schedules", schedule: "0 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60 },
  { name: "session-cleanup", path: "/api/jobs/session-cleanup", schedule: "45 3 * * *", scheduleLabel: "Daily 3:45 UTC", expectedIntervalMinutes: 1440 },
  // Reads every other job's heartbeat. Registered here too, so a watchdog that
  // itself stops running is visible on the same Ops surface.
  { name: "ops-watchdog", path: "/api/jobs/ops-watchdog", schedule: "20 * * * *", scheduleLabel: "Hourly", expectedIntervalMinutes: 60 },
]

const RETENTION_DAYS = 60
const ERROR_SNIPPET_MAX = 2000

async function readErrorSnippet(response: Response): Promise<string | null> {
  try {
    const text = await response.clone().text()
    return text ? text.slice(0, ERROR_SNIPPET_MAX) : null
  } catch {
    return null
  }
}

async function recordRun(run: {
  jobName: string
  status: "success" | "failed"
  startedAt: Date
  httpStatus: number | null
  error: string | null
}) {
  try {
    const supabase = createServiceSupabaseClient()
    const finishedAt = new Date()
    await supabase.from("job_runs").insert({
      job_name: run.jobName,
      status: run.status,
      started_at: run.startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - run.startedAt.getTime(),
      http_status: run.httpStatus,
      error: run.error,
    })
    await supabase
      .from("job_runs")
      .delete()
      .lt("started_at", new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString())
  } catch (error) {
    // Heartbeat bookkeeping must never break the job itself.
    console.error(`Failed to record job run for ${run.jobName}`, error)
  }
}

// Wraps a cron route handler so every invocation lands in job_runs. 401s are
// skipped (unauthorized probes are not runs); thrown errors are recorded as
// failed runs and rethrown.
export function withCronRun(
  jobName: string,
  handler: (request: NextRequest) => Promise<Response>,
) {
  return async (request: NextRequest): Promise<Response> => {
    const startedAt = new Date()
    let response: Response
    try {
      response = await handler(request)
    } catch (error) {
      await recordRun({
        jobName,
        status: "failed",
        startedAt,
        httpStatus: null,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    if (response.status === 401) return response

    await recordRun({
      jobName,
      status: response.ok ? "success" : "failed",
      startedAt,
      httpStatus: response.status,
      error: response.ok ? null : await readErrorSnippet(response),
    })
    return response
  }
}
