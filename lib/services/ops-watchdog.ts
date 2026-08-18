import "server-only"

import {
  incidentRenotifyCutoff,
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
 *
 * This module is also the single home for **payment-operations incident
 * alerting** — the open/resolved bookkeeping that turns a recurring observation
 * into one email per state change. Every payment surface that alerts a human
 * routes through the helpers below rather than calling `recordEvent` directly,
 * because a raw event on a recurring check is an email every tick.
 */

/** Grace on top of the declared cadence before a job counts as overdue. */
const LIVENESS_GRACE_MULTIPLIER = 3
const RECONCILIATION_INCIDENT_CODE = "payment_reconciliation_stale"
const RELEASE_BACKLOG_INCIDENT_CODE = "payment_release_past_due"
const RAIL_POLICY_PAGE_SIZE = 500

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

/**
 * One deduped alerting subject, owned by exactly one probe.
 *
 * `orgIds` is the *current* population, so an empty list is meaningful: it
 * resolves every open incident under this code. That is why a probe reports its
 * incident codes every tick, healthy or not, and why only a probe that actually
 * ran is allowed to speak — "could not check" is not evidence of recovery.
 */
interface WatchdogIncident {
  code: string
  orgIds: string[]
  detail: string
}

interface WatchdogProbeResult {
  findings: WatchdogFinding[]
  incidents: WatchdogIncident[]
}

/**
 * Open or refresh `code` for `orgIds`, resolve it everywhere else, and return the
 * organizations that should be told right now.
 *
 * Three things earn an email: a first observation, a condition that recovered
 * and came back, and one that has stayed broken for a full day without being
 * mentioned again. The third is the conditional UPDATE below rather than a read
 * followed by a write, so two overlapping ticks cannot both claim the same
 * reminder — the row lock on the matching UPDATE is the arbiter.
 */
export async function syncPaymentOperationsIncidents(input: {
  code: string
  orgIds: string[]
  detail: string
}): Promise<string[]> {
  const supabase = createServiceSupabaseClient()
  const activeOrgIds = [...new Set(input.orgIds)]
  const { data, error } = await supabase.rpc("sync_payment_operations_incidents", {
    p_finding_code: input.code,
    p_active_org_ids: activeOrgIds,
    p_detail: input.detail,
  })
  if (error) throw new Error(`Unable to sync payment operations incidents: ${error.message}`)

  const notify = new Set<string>()
  for (const row of data ?? []) {
    if (!row.should_notify || typeof row.org_id !== "string") continue
    notify.add(row.org_id)
  }
  const aged = await claimIncidentRenotifications(
    input.code,
    activeOrgIds.filter((orgId) => !notify.has(orgId)),
  )
  for (const orgId of aged) notify.add(orgId)
  return [...notify]
}

/**
 * The single-organization form. Used by webhook paths, where the caller knows
 * about exactly one org and must never resolve another org's still-open incident
 * as a side effect of its own health.
 */
export async function openPaymentOperationsIncident(input: {
  orgId: string
  code: string
  detail: string
}): Promise<boolean> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("open_payment_operations_incident", {
    p_org_id: input.orgId,
    p_finding_code: input.code,
    p_detail: input.detail,
  })
  if (error) throw new Error(`Unable to open the ${input.code} incident: ${error.message}`)
  if (data === true) return true
  const aged = await claimIncidentRenotifications(input.code, [input.orgId])
  return aged.length > 0
}

export async function resolvePaymentOperationsIncident(input: { orgId: string; code: string }) {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.rpc("resolve_payment_operations_incident", {
    p_org_id: input.orgId,
    p_finding_code: input.code,
  })
  if (error) throw new Error(`Unable to resolve the ${input.code} incident: ${error.message}`)
}

async function claimIncidentRenotifications(code: string, orgIds: string[]): Promise<string[]> {
  if (orgIds.length === 0) return []
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("payment_operations_incidents")
    .update({ last_notified_at: new Date().toISOString() })
    .eq("finding_code", code)
    .eq("status", "open")
    .in("org_id", orgIds)
    .lt("last_notified_at", incidentRenotifyCutoff())
    .select("org_id")
  if (error) throw new Error(`Unable to age payment operations incidents: ${error.message}`)
  return (data ?? []).map((row) => String(row.org_id))
}

/**
 * Rail-enabled organizations, for findings that have no org of their own.
 *
 * Paged rather than capped on purpose: this list is what the incident
 * synchronizer treats as the *complete* affected population, and anything left
 * off it would have its open incident resolved as though it had recovered.
 */
async function loadRailEnabledOrgIds(): Promise<string[]> {
  const supabase = createServiceSupabaseClient()
  const orgIds: string[] = []
  for (let from = 0; ; from += RAIL_POLICY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("payment_rail_policies")
      .select("org_id")
      .eq("enabled", true)
      .order("org_id", { ascending: true })
      .range(from, from + RAIL_POLICY_PAGE_SIZE - 1)
    if (error) throw new Error(`Unable to load rail-enabled organizations: ${error.message}`)
    orgIds.push(...(data ?? []).map((row) => String(row.org_id)))
    if ((data ?? []).length < RAIL_POLICY_PAGE_SIZE) break
  }
  return [...new Set(orgIds)]
}

/**
 * Liveness, plus the money jobs' incident subjects.
 *
 * A dead cron names no organization of its own, which is exactly why nothing was
 * ever told about one: the alert router only forwarded findings that carried an
 * org. A payment job that stops firing freezes real money for every rail-enabled
 * builder, so those are the organizations it is recorded against — one incident
 * per job, so a second job dying is a second alert rather than being swallowed
 * by the first one's open incident.
 */
async function checkCronLiveness(): Promise<WatchdogProbeResult> {
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

  const overdueJobs = new Set<string>()
  for (const job of CRON_JOBS) {
    const lastSuccess = lastSuccessByJob.get(job.name)
    const overdueAfterMs = job.expectedIntervalMinutes * LIVENESS_GRACE_MULTIPLIER * 60_000
    // No row at all is only actionable once the job has had time to run; a job
    // registered minutes ago has legitimately never succeeded.
    if (!lastSuccess) {
      overdueJobs.add(job.name)
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
      overdueJobs.add(job.name)
      findings.push({
        code: "cron_overdue",
        severity: job.name.startsWith("payment") ? "critical" : "warn",
        detail: `${job.name} last succeeded ${Math.round(ageMs / 60_000)} minutes ago, expected every ${job.expectedIntervalMinutes}`,
        context: { job: job.name, schedule: job.scheduleLabel, last_success: lastSuccess },
      })
    }
  }

  const paymentJobs = CRON_JOBS.filter((job) => job.name.startsWith("payment"))
  const affectedOrgIds = paymentJobs.some((job) => overdueJobs.has(job.name))
    ? await loadRailEnabledOrgIds()
    : []
  return {
    findings,
    incidents: paymentJobs.map((job) => ({
      code: `cron_overdue:${job.name}`,
      orgIds: overdueJobs.has(job.name) ? affectedOrgIds : [],
      detail: `The ${job.name} job (${job.scheduleLabel}) has stopped running on schedule, so vendor payments are not being processed.`,
    })),
  }
}

/**
 * Invariant: an approved run whose release date has passed should not still be
 * sitting at `approved`. This is the check that catches a release sweep which
 * ran, succeeded, and failed every run inside itself.
 */
async function checkPaymentReleaseBacklog(): Promise<WatchdogProbeResult> {
  const supabase = createServiceSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const byOrg = new Map<string, string[]>()
  // Paged, and ordered by org, because the org set this produces is what the
  // incident synchronizer treats as the whole affected population. A flat
  // truncation would let one org with a large backlog push another org off the
  // list, and being off the list reads as "recovered".
  for (let from = 0; ; from += RAIL_POLICY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("payment_runs")
      .select("id,org_id,scheduled_for")
      .eq("status", "approved")
      .not("scheduled_for", "is", null)
      .lt("scheduled_for", today)
      .order("org_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + RAIL_POLICY_PAGE_SIZE - 1)
    if (error) throw new Error(`Unable to check payment release backlog: ${error.message}`)
    for (const row of data ?? []) {
      const ids = byOrg.get(row.org_id) ?? []
      ids.push(row.id)
      byOrg.set(row.org_id, ids)
    }
    if ((data ?? []).length < RAIL_POLICY_PAGE_SIZE) break
  }
  return {
    findings: [...byOrg.entries()].map(([orgId, runIds]) => ({
      code: "payment_release_past_due" as const,
      severity: "critical" as const,
      detail: `${runIds.length} approved payment run(s) are past their scheduled release date and still unreleased`,
      context: { org_id: orgId, run_ids: runIds.slice(0, 20) },
    })),
    incidents: [{
      code: RELEASE_BACKLOG_INCIDENT_CODE,
      orgIds: [...byOrg.keys()],
      detail: "One or more approved payment runs are past their scheduled release date and remain unreleased.",
    }],
  }
}

/**
 * Invariant: every org with the rail enabled reconciles daily. Checking the
 * cursor directly rather than the sweep's own report means an org falls out of
 * reconciliation loudly even if the sweep never ran.
 */
async function checkReconciliationFreshness(): Promise<WatchdogProbeResult> {
  const supabase = createServiceSupabaseClient()
  const policies: Array<{
    org_id: string
    last_reconciled_at: string | null
    reconciliation_monitoring_started_at: string | null
    created_at: string
  }> = []
  for (let from = 0; ; from += RAIL_POLICY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("payment_rail_policies")
      .select("org_id,last_reconciled_at,reconciliation_monitoring_started_at,created_at")
      .eq("enabled", true)
      .order("org_id", { ascending: true })
      .range(from, from + RAIL_POLICY_PAGE_SIZE - 1)
    if (error) throw new Error(`Unable to check reconciliation freshness: ${error.message}`)
    policies.push(...(data ?? []))
    if ((data ?? []).length < RAIL_POLICY_PAGE_SIZE) break
  }
  if (process.env.FINTECH_PAYMENTS_RECONCILIATION_ENABLED !== "true" && policies.length > 0) {
    const detail = "Payment rails are enabled but FINTECH_PAYMENTS_RECONCILIATION_ENABLED is not true; reconciliation is not running."
    const orgIds = policies.map((policy) => policy.org_id)
    return {
      findings: [{
        code: RECONCILIATION_INCIDENT_CODE,
        severity: "critical",
        detail,
        context: { org_ids: orgIds, configuration_missing: true },
      }],
      incidents: [{ code: RECONCILIATION_INCIDENT_CODE, orgIds, detail }],
    }
  }
  const stale = policies.filter((policy) => isPaymentReconciliationStale(policy))
  const staleOrgIds = stale.map((row) => row.org_id)
  return {
    findings: stale.length === 0 ? [] : [{
      code: RECONCILIATION_INCIDENT_CODE,
      severity: "critical",
      detail: `${stale.length} rail-enabled org(s) have not reconciled in ${RECONCILIATION_STALE_HOURS} hours`,
      context: { org_ids: staleOrgIds },
    }],
    incidents: [{
      code: RECONCILIATION_INCIDENT_CODE,
      orgIds: staleOrgIds,
      detail: `Vendor payment reconciliation has not completed for this organization in ${RECONCILIATION_STALE_HOURS} hours.`,
    }],
  }
}

/** Jobs that exhausted their retries are work a human owns, not noise. */
async function checkFailedOutboxJobs(): Promise<WatchdogProbeResult> {
  const supabase = createServiceSupabaseClient()
  const { count, error } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("updated_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  if (error) throw new Error(`Unable to count failed outbox jobs: ${error.message}`)
  if ((count ?? 0) === 0) return { findings: [], incidents: [] }
  return {
    findings: [{
      code: "outbox_jobs_failed",
      severity: "warn",
      detail: `${count} background job(s) exhausted their retries in the last 24 hours`,
      context: { failed_count: count },
    }],
    incidents: [],
  }
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
  const incidents: WatchdogIncident[] = []
  for (const probe of probes) {
    if (probe.status === "fulfilled") {
      findings.push(...probe.value.findings)
      // Only a probe that actually ran may speak for its incident codes. A probe
      // that threw contributes nothing, so an incident it would have resolved
      // stays open: "could not check" must never read as recovery.
      incidents.push(...probe.value.incidents)
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
  // the organizations they affect rather than invented onto an arbitrary one.
  // Every critical subject goes through the same incident dedup — one email per
  // state change plus a daily reminder while it stays broken — instead of the
  // per-tick event that made a week-old stuck payment seven emails.
  const synced = await Promise.all(
    incidents.map(async (incident) => ({ incident, notifyOrgIds: await syncPaymentOperationsIncidents(incident) })),
  )
  const detailByOrg = new Map<string, Array<{ code: string; detail: string }>>()
  for (const { incident, notifyOrgIds } of synced) {
    for (const orgId of notifyOrgIds) {
      detailByOrg.set(orgId, [...(detailByOrg.get(orgId) ?? []), { code: incident.code, detail: incident.detail }])
    }
  }
  const alertWrites = await Promise.allSettled(
    [...detailByOrg.entries()].map(([orgId, orgFindings]) =>
      recordEvent({
        orgId,
        eventType: "payment_operations_alert",
        entityType: "payment_rail_policy",
        entityId: orgId,
        payload: { findings: orgFindings },
      }),
    ),
  )
  const failedAlertWrites = alertWrites.filter((result) => result.status === "rejected")
  if (failedAlertWrites.length > 0) {
    throw new Error(`Unable to persist ${failedAlertWrites.length} critical payment watchdog alert(s)`)
  }

  return { findings }
}
