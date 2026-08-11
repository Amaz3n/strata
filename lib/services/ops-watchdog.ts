import "server-only"

import {
  isPaymentReconciliationStale,
  RECONCILIATION_STALE_HOURS,
} from "@/lib/payments/operations-monitor"
import { CRON_JOBS } from "@/lib/services/job-runs"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The heartbeat nobody was reading.
 *
 * `CRON_JOBS` already declared `expectedIntervalMinutes` and `withCronRun`
 * already wrote every invocation to `job_runs`, but nothing ever compared the
 * two. A cron that stopped firing looked exactly like a cron with nothing to do.
 *
 * Two independent classes of check, deliberately kept apart:
 *
 * - **Liveness** — did each registered job run inside its own declared cadence?
 *   Generic, covers all thirty-odd jobs, catches a dead scheduler.
 * - **Invariants** — is the world in the state a healthy job would have left it
 *   in? Specific, and the only kind that catches a job which ran, returned 200,
 *   and quietly did nothing. A release sweep that collects failures into a JSON
 *   response nobody reads is a success by every liveness measure.
 */

/** Grace on top of the declared cadence before a job counts as overdue. */
const LIVENESS_GRACE_MULTIPLIER = 3
const RECONCILIATION_INCIDENT_CODE = "payment_reconciliation_stale"

export interface WatchdogFinding {
  code:
    | "cron_overdue"
    | "outbox_jobs_failed"
    | "payment_release_past_due"
    | "payment_reconciliation_stale"
  severity: "warn" | "critical"
  detail: string
  context: Record<string, unknown>
}

async function checkCronLiveness(): Promise<WatchdogFinding[]> {
  const supabase = createServiceSupabaseClient()
  const findings: WatchdogFinding[] = []
  const { data, error } = await supabase
    .from("job_runs")
    .select("job_name,status,started_at")
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(2_000)
  if (error) throw new Error(`Unable to read job heartbeat: ${error.message}`)

  const lastSuccessByJob = new Map<string, string>()
  for (const row of data ?? []) {
    if (!lastSuccessByJob.has(row.job_name)) lastSuccessByJob.set(row.job_name, row.started_at)
  }

  for (const job of CRON_JOBS) {
    const lastSuccess = lastSuccessByJob.get(job.name)
    const overdueAfterMs = job.expectedIntervalMinutes * LIVENESS_GRACE_MULTIPLIER * 60_000
    // No row at all is only actionable once the job has had time to run; a job
    // registered minutes ago has legitimately never succeeded.
    if (!lastSuccess) {
      findings.push({
        code: "cron_overdue",
        // Money-moving jobs are the ones worth waking someone for.
        severity: job.name.startsWith("payment") ? "critical" : "warn",
        detail: `${job.name} has no successful run on record`,
        context: { job: job.name, schedule: job.scheduleLabel },
      })
      continue
    }
    const ageMs = Date.now() - new Date(lastSuccess).getTime()
    if (ageMs > overdueAfterMs) {
      findings.push({
        code: "cron_overdue",
        severity: job.name.startsWith("payment") ? "critical" : "warn",
        detail: `${job.name} last succeeded ${Math.round(ageMs / 60_000)} minutes ago, expected every ${job.expectedIntervalMinutes}`,
        context: { job: job.name, schedule: job.scheduleLabel, last_success: lastSuccess },
      })
    }
  }
  return findings
}

/**
 * Invariant: an approved run whose release date has passed should not still be
 * sitting at `approved`. This is the check that catches a release sweep which
 * ran, succeeded, and failed every run inside itself.
 */
async function checkPaymentReleaseBacklog(): Promise<WatchdogFinding[]> {
  const supabase = createServiceSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from("payment_runs")
    .select("id,org_id,scheduled_for")
    .eq("status", "approved")
    .not("scheduled_for", "is", null)
    .lt("scheduled_for", today)
    .limit(100)
  if (error) throw new Error(`Unable to check payment release backlog: ${error.message}`)
  if ((data ?? []).length === 0) return []
  return [{
    code: "payment_release_past_due",
    severity: "critical",
    detail: `${(data ?? []).length} approved payment run(s) are past their scheduled release date and still unreleased`,
    context: { run_ids: (data ?? []).map((row) => row.id).slice(0, 20) },
  }]
}

/**
 * Invariant: every org with the rail enabled reconciles daily. Checking the
 * cursor directly rather than the sweep's own report means an org falls out of
 * reconciliation loudly even if the sweep never ran.
 */
async function checkReconciliationFreshness(): Promise<WatchdogFinding[]> {
  const supabase = createServiceSupabaseClient()
  const pageSize = 500
  const policies: Array<{
    org_id: string
    last_reconciled_at: string | null
    reconciliation_monitoring_started_at: string | null
    created_at: string
  }> = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("payment_rail_policies")
      .select("org_id,last_reconciled_at,reconciliation_monitoring_started_at,created_at")
      .eq("enabled", true)
      .order("org_id", { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`Unable to check reconciliation freshness: ${error.message}`)
    policies.push(...(data ?? []))
    if ((data ?? []).length < pageSize) break
  }
  const stale = policies.filter((policy) => isPaymentReconciliationStale(policy))
  if (stale.length === 0) return []
  return [{
    code: RECONCILIATION_INCIDENT_CODE,
    severity: "critical",
    detail: `${stale.length} rail-enabled org(s) have not reconciled in ${RECONCILIATION_STALE_HOURS} hours`,
    context: { org_ids: stale.map((row) => row.org_id) },
  }]
}

async function syncReconciliationIncidents(
  finding: WatchdogFinding | undefined,
): Promise<Map<string, WatchdogFinding[]>> {
  const supabase = createServiceSupabaseClient()
  const orgIds = Array.isArray(finding?.context.org_ids)
    ? finding.context.org_ids.filter((value): value is string => typeof value === "string")
    : []
  const detail = `Vendor payment reconciliation has not completed for this organization in ${RECONCILIATION_STALE_HOURS} hours.`
  const { data, error } = await supabase.rpc("sync_payment_operations_incidents", {
    p_finding_code: RECONCILIATION_INCIDENT_CODE,
    p_active_org_ids: orgIds,
    p_detail: detail,
  })
  if (error) throw new Error(`Unable to sync payment operations incidents: ${error.message}`)

  const notifications = new Map<string, WatchdogFinding[]>()
  for (const row of data ?? []) {
    if (!row.should_notify || typeof row.org_id !== "string") continue
    notifications.set(row.org_id, [{
      code: RECONCILIATION_INCIDENT_CODE,
      severity: "critical",
      detail,
      context: { org_ids: [row.org_id] },
    }])
  }
  return notifications
}

/** Jobs that exhausted their retries are work a human owns, not noise. */
async function checkFailedOutboxJobs(): Promise<WatchdogFinding[]> {
  const supabase = createServiceSupabaseClient()
  const { count, error } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("updated_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  if (error) throw new Error(`Unable to count failed outbox jobs: ${error.message}`)
  if ((count ?? 0) === 0) return []
  return [{
    code: "outbox_jobs_failed",
    severity: "warn",
    detail: `${count} background job(s) exhausted their retries in the last 24 hours`,
    context: { failed_count: count },
  }]
}

export async function runOpsWatchdog(): Promise<{ findings: WatchdogFinding[] }> {
  // One failing probe must not hide the others — a watchdog that goes dark on
  // its own first error is worse than no watchdog, because it reads as healthy.
  const probes = await Promise.allSettled([
    checkCronLiveness(),
    checkPaymentReleaseBacklog(),
    checkReconciliationFreshness(),
    checkFailedOutboxJobs(),
  ])
  const findings: WatchdogFinding[] = []
  for (const probe of probes) {
    if (probe.status === "fulfilled") {
      findings.push(...probe.value)
    } else {
      findings.push({
        code: "cron_overdue",
        severity: "critical",
        detail: `A watchdog probe failed: ${probe.reason instanceof Error ? probe.reason.message : String(probe.reason)}`,
        context: {},
      })
    }
  }

  // Platform-level conditions have no owning org, so they are recorded against
  // the orgs they name rather than invented onto an arbitrary one.
  // Only a healthy reconciliation probe may resolve an existing incident. If
  // the probe itself failed, leaving the incident open is safer than treating
  // "could not check" as recovery.
  const reconciliationFinding = findings.find((finding) => finding.code === RECONCILIATION_INCIDENT_CODE)
  const criticalByOrg = probes[2].status === "fulfilled"
    ? await syncReconciliationIncidents(reconciliationFinding)
    : new Map<string, WatchdogFinding[]>()
  await Promise.all(
    [...criticalByOrg.entries()].map(([orgId, orgFindings]) =>
      recordEvent({
        orgId,
        eventType: "payment_operations_alert",
        entityType: "payment_rail_policy",
        entityId: orgId,
        payload: { findings: orgFindings.map((finding) => ({ code: finding.code, detail: finding.detail })) },
      }).catch(() => undefined),
    ),
  )

  return { findings }
}
