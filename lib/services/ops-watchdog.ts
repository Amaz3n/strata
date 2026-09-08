import "server-only"

import { mapWithConcurrency } from "@/lib/payments/concurrency"
import {
  detectExecutionConfigMismatch,
  incidentRenotifyCutoff,
  isPaymentReconciliationStale,
  RECONCILIATION_STALE_HOURS,
} from "@/lib/payments/operations-monitor"
import { CRON_JOBS } from "@/lib/services/job-runs"
import { ACCOUNTING_JOB_TYPES } from "@/lib/services/accounting-job-types"
import { recordEvent } from "@/lib/services/events"
import { readPaymentExecutionConfig } from "@/lib/services/payment-launch-readiness"
import {
  groupStaleStateByOrg,
  loadStalePaymentState,
  STALE_PAYMENT_STATE_HOURS,
  STALE_PAYMENT_STATE_INCIDENT_CODE,
} from "@/lib/services/payment-stale-state"
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
const EXECUTION_CONFIG_INCIDENT_CODE = "payment_execution_config_mismatch"
const RAIL_POLICY_PAGE_SIZE = 500
const ACCOUNTING_SCAN_PAGE_SIZE = 200
const ACCOUNTING_PENDING_STALE_HOURS = 6
/** Enough to finish the roster in one round trip's worth of time, low enough to stay polite. */
const LIVENESS_LOOKUP_CONCURRENCY = 8

export interface WatchdogFinding {
  code:
    | "cron_overdue"
    | "outbox_jobs_failed"
    | "payment_release_past_due"
    | "payment_reconciliation_stale"
    | "payment_execution_config_mismatch"
    | "stale_payment_state"
    | "accounting_sync_needs_review"
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
  eventType?: "payment_operations_alert" | "accounting_sync_needs_review"
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
 * The last successful run of each registered job, asked one job at a time.
 *
 * This used to be a single scan of the 2,000 most recent successful runs, which
 * silently became a *time* window rather than a per-job one: the busiest jobs
 * fire every five minutes, so 2,000 rows covered barely four days, and any job
 * whose last success fell outside it was reported as having "no successful run
 * on record". In production that produced false criticals for healthy daily jobs
 * and made a genuinely dead `payment-release` indistinguishable from
 * `late-fees`, which had succeeded fourteen hours earlier. A watchdog that cries
 * wolf about healthy jobs is one nobody reads when a real one dies.
 *
 * One indexed lookup per job (`job_runs (job_name, started_at desc)`) is exact
 * regardless of history, and thirty-odd of them on an hourly job costs nothing.
 */
async function loadLastSuccessByJob(): Promise<Map<string, string>> {
  const supabase = createServiceSupabaseClient()
  const entries = await mapWithConcurrency(CRON_JOBS, LIVENESS_LOOKUP_CONCURRENCY, async (job) => {
    const { data, error } = await supabase
      .from("job_runs")
      .select("started_at")
      .eq("job_name", job.name)
      .eq("status", "success")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`Unable to read the ${job.name} heartbeat: ${error.message}`)
    return [job.name, data?.started_at ?? null] as const
  })
  const lastSuccessByJob = new Map<string, string>()
  for (const [name, startedAt] of entries) {
    if (typeof startedAt === "string") lastSuccessByJob.set(name, startedAt)
  }
  return lastSuccessByJob
}

/**
 * Configuration faults, reported as themselves.
 *
 * Every other probe here asks whether the world is in the state a healthy job
 * would have left it in. This one asks whether the jobs can succeed at all. The
 * distinction earned its own probe the hard way: a deployment with execution on
 * and reconciliation off failed the money tick every five minutes for twenty
 * days, and because a configuration fault names no organization, the alert
 * router had nothing to send and nobody was told.
 *
 * So the finding is platform-level and unconditional — it fires whether or not
 * any rail is enabled, which is exactly the case that was invisible — while the
 * org-scoped incident is raised only for builders actually on the rail, who are
 * the only ones whose money is affected.
 */
async function checkPaymentExecutionConfig(): Promise<WatchdogProbeResult> {
  const problem = detectExecutionConfigMismatch(readPaymentExecutionConfig())
  if (!problem) {
    return { findings: [], incidents: [{ code: EXECUTION_CONFIG_INCIDENT_CODE, orgIds: [], detail: "" }] }
  }
  const orgIds = await loadRailEnabledOrgIds()
  return {
    findings: [{
      code: "payment_execution_config_mismatch",
      severity: "critical",
      detail: `${problem.detail} ${problem.remedy}`,
      context: { affected_org_count: orgIds.length, remedy: problem.remedy },
    }],
    incidents: [{
      code: EXECUTION_CONFIG_INCIDENT_CODE,
      orgIds,
      detail: `Vendor payments are configured in a state that cannot process releases. ${problem.detail}`,
    }],
  }
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
  const findings: WatchdogFinding[] = []
  const lastSuccessByJob = await loadLastSuccessByJob()

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

/**
 * Invariant: money that stopped moving, across the whole deployment.
 *
 * The same 96-hour scan runs inside daily reconciliation, where it raises the
 * exception rows a human works. That copy is unreachable exactly when it matters
 * most: it is gated on the reconciliation flag and only visits organizations
 * whose rail is currently enabled. Production held a disbursement at
 * `transfer_pending` for four weeks with both gates off, so the check written in
 * response to that very incident could never see it.
 *
 * A payment is stuck whether or not the rail is switched on today, so this probe
 * takes no flag into account. Both callers share one scan and one incident code,
 * so they agree by construction; the difference is reach. Reconciliation sees a
 * single organization and can only ever say "still stuck" about it, while this
 * scan covers the deployment, which is what makes resolving safe here.
 */
async function checkStalePaymentStates(): Promise<WatchdogProbeResult> {
  const state = await loadStalePaymentState()
  const byOrg = groupStaleStateByOrg(state)
  return {
    findings: [...byOrg.entries()].map(([orgId, counts]) => ({
      code: "stale_payment_state" as const,
      severity: "critical" as const,
      detail: `${counts.disbursements} disbursement(s) and ${counts.runs} payment run(s) have been non-terminal for more than ${STALE_PAYMENT_STATE_HOURS} hours`,
      context: { org_id: orgId, stale_disbursements: counts.disbursements, stale_runs: counts.runs, threshold_hours: STALE_PAYMENT_STATE_HOURS },
    })),
    incidents: [{
      code: STALE_PAYMENT_STATE_INCIDENT_CODE,
      orgIds: [...byOrg.keys()],
      detail: `Vendor payments have been in a non-terminal state for more than ${STALE_PAYMENT_STATE_HOURS} hours. Review provider and ledger state before taking corrective action.`,
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

function appendByOrg(map: Map<string, string[]>, orgId: string, id: string) {
  const ids = map.get(orgId) ?? []
  ids.push(id)
  map.set(orgId, ids)
}

/**
 * Accounting invariants are checked independently of the accounting worker.
 * A worker that is running but dropping intent must not be able to report its
 * own output as healthy.
 */
async function checkAccountingSyncTruthfulness(): Promise<WatchdogProbeResult> {
  const supabase = createServiceSupabaseClient()
  const staleCutoff = new Date(Date.now() - ACCOUNTING_PENDING_STALE_HOURS * 60 * 60 * 1000).toISOString()
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const staleByOrg = new Map<string, string[]>()
  const missingByOrg = new Map<string, string[]>()
  const failedByOrg = new Map<string, string[]>()

  for (let from = 0; ; from += ACCOUNTING_SCAN_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("accounting_sync_records")
      .select("id,org_id")
      .eq("status", "pending")
      .lt("updated_at", staleCutoff)
      .order("org_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + ACCOUNTING_SCAN_PAGE_SIZE - 1)
    if (error) throw new Error(`Unable to check stale accounting sync records: ${error.message}`)
    for (const row of data ?? []) appendByOrg(staleByOrg, String(row.org_id), String(row.id))
    if ((data ?? []).length < ACCOUNTING_SCAN_PAGE_SIZE) break
  }

  // Arc Books deliberately has no outbound bill-payment sync record. Exclude
  // those orgs so the watchdog does not turn correct sole-ledger behavior into
  // a permanent false incident.
  const arcAuthorityOrgIds = new Set<string>()
  for (let from = 0; ; from += ACCOUNTING_SCAN_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("books_settings")
      .select("org_id")
      .eq("ledger_authority", "arc")
      .order("org_id", { ascending: true })
      .range(from, from + ACCOUNTING_SCAN_PAGE_SIZE - 1)
    if (error) throw new Error(`Unable to load accounting ledger authority: ${error.message}`)
    for (const row of data ?? []) arcAuthorityOrgIds.add(String(row.org_id))
    if ((data ?? []).length < ACCOUNTING_SCAN_PAGE_SIZE) break
  }

  for (let from = 0; ; from += ACCOUNTING_SCAN_PAGE_SIZE) {
    const { data: payments, error: paymentsError } = await supabase
      .from("payments")
      .select("id,org_id")
      .not("bill_id", "is", null)
      .not("provider", "is", null)
      .like("idempotency_key", "disbursement:%")
      .eq("status", "succeeded")
      .order("org_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + ACCOUNTING_SCAN_PAGE_SIZE - 1)
    if (paymentsError) throw new Error(`Unable to check rail-paid bill payments: ${paymentsError.message}`)
    const eligible = (payments ?? []).filter((payment) => !arcAuthorityOrgIds.has(String(payment.org_id)))
    if (eligible.length > 0) {
      const { data: records, error: recordsError } = await supabase
        .from("accounting_sync_records")
        .select("entity_id")
        .eq("entity_type", "bill_payment")
        .in("entity_id", eligible.map((payment) => payment.id))
      if (recordsError) throw new Error(`Unable to match bill-payment sync records: ${recordsError.message}`)
      const recorded = new Set((records ?? []).map((record) => String(record.entity_id)))
      for (const payment of eligible) {
        if (!recorded.has(String(payment.id))) appendByOrg(missingByOrg, String(payment.org_id), String(payment.id))
      }
    }
    if ((payments ?? []).length < ACCOUNTING_SCAN_PAGE_SIZE) break
  }

  for (let from = 0; ; from += ACCOUNTING_SCAN_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("outbox")
      .select("id,org_id")
      .eq("status", "failed")
      .in("job_type", [...ACCOUNTING_JOB_TYPES])
      .gte("updated_at", dayAgo)
      .order("org_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + ACCOUNTING_SCAN_PAGE_SIZE - 1)
    if (error) throw new Error(`Unable to check failed accounting outbox jobs: ${error.message}`)
    for (const row of data ?? []) {
      if (row.org_id) appendByOrg(failedByOrg, String(row.org_id), String(row.id))
    }
    if ((data ?? []).length < ACCOUNTING_SCAN_PAGE_SIZE) break
  }

  const findings: WatchdogFinding[] = [
    ...[...staleByOrg.entries()].map(([orgId, ids]) => ({
      code: "accounting_sync_needs_review" as const,
      severity: "critical" as const,
      detail: `${ids.length} accounting sync record(s) have remained pending for more than ${ACCOUNTING_PENDING_STALE_HOURS} hours`,
      context: { org_id: orgId, reason: "pending_stale", sync_record_ids: ids.slice(0, 20) },
    })),
    ...[...missingByOrg.entries()].map(([orgId, ids]) => ({
      code: "accounting_sync_needs_review" as const,
      severity: "critical" as const,
      detail: `${ids.length} rail-paid bill payment(s) have no accounting sync record`,
      context: { org_id: orgId, reason: "bill_payment_record_missing", payment_ids: ids.slice(0, 20) },
    })),
    ...[...failedByOrg.entries()].map(([orgId, ids]) => ({
      code: "accounting_sync_needs_review" as const,
      severity: "warn" as const,
      detail: `${ids.length} accounting outbox job(s) exhausted retries in the last 24 hours`,
      context: { org_id: orgId, reason: "outbox_failed", outbox_ids: ids.slice(0, 20) },
    })),
  ]
  return {
    findings,
    incidents: [
      {
        code: "accounting_sync_pending_stale",
        orgIds: [...staleByOrg.keys()],
        detail: `Accounting sync records have remained pending for more than ${ACCOUNTING_PENDING_STALE_HOURS} hours.`,
        eventType: "accounting_sync_needs_review",
      },
      {
        code: "accounting_bill_payment_record_missing",
        orgIds: [...missingByOrg.keys()],
        detail: "One or more rail-paid bill payments have no durable accounting sync record.",
        eventType: "accounting_sync_needs_review",
      },
      {
        code: "accounting_outbox_failed",
        orgIds: [...failedByOrg.keys()],
        detail: "One or more accounting outbox jobs exhausted retries in the last 24 hours.",
        eventType: "accounting_sync_needs_review",
      },
    ],
  }
}

export async function runOpsWatchdog(): Promise<{ findings: WatchdogFinding[] }> {
  // One failing probe must not hide the others — a watchdog that goes dark on
  // its own first error is worse than no watchdog, because it reads as healthy.
  const probes = await Promise.allSettled([
    checkCronLiveness(),
    checkPaymentReleaseBacklog(),
    checkReconciliationFreshness(),
    checkPaymentExecutionConfig(),
    checkStalePaymentStates(),
    checkFailedOutboxJobs(),
    checkAccountingSyncTruthfulness(),
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
  const detailByDestination = new Map<string, {
    orgId: string
    eventType: "payment_operations_alert" | "accounting_sync_needs_review"
    findings: Array<{ code: string; detail: string }>
  }>()
  for (const { incident, notifyOrgIds } of synced) {
    for (const orgId of notifyOrgIds) {
      const eventType = incident.eventType ?? "payment_operations_alert"
      const key = `${eventType}:${orgId}`
      const destination = detailByDestination.get(key) ?? { orgId, eventType, findings: [] }
      destination.findings.push({ code: incident.code, detail: incident.detail })
      detailByDestination.set(key, destination)
    }
  }
  const alertWrites = await Promise.allSettled(
    [...detailByDestination.values()].map((destination) =>
      recordEvent({
        orgId: destination.orgId,
        eventType: destination.eventType,
        entityType: destination.eventType === "accounting_sync_needs_review" ? "accounting_sync_record" : "payment_rail_policy",
        entityId: destination.orgId,
        payload: { findings: destination.findings },
      }),
    ),
  )
  const failedAlertWrites = alertWrites.filter((result) => result.status === "rejected")
  if (failedAlertWrites.length > 0) {
    throw new Error(`Unable to persist ${failedAlertWrites.length} critical payment watchdog alert(s)`)
  }

  return { findings }
}
