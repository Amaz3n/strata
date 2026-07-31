import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { CRON_JOBS } from "@/lib/services/job-runs"

export type CronJobState = "healthy" | "failing" | "overdue" | "no-data"

export interface CronJobHealth {
  name: string
  path: string
  scheduleLabel: string
  state: CronJobState
  lastRunAt: string | null
  lastRunStatus: string | null
  lastRunDurationMs: number | null
  lastSuccessAt: string | null
  lastError: string | null
  failuresLast24h: number
}

export interface OutboxFailedItem {
  id: number
  jobType: string
  orgId: string | null
  orgName: string | null
  retryCount: number
  lastError: string | null
  runAt: string | null
  updatedAt: string
  createdAt: string
}

export interface OutboxHealth {
  pendingCount: number
  processingCount: number
  failedCount: number
  completedLast24h: number
  oldestPendingAt: string | null
  failedItems: OutboxFailedItem[]
}

export interface StuckOutboxGroup {
  jobType: string
  pendingCount: number
  processingCount: number
  totalCount: number
  /** run_at for pending, updated_at for processing — whichever stalled first. */
  oldestStuckSince: string
  /** Distinct orgs in the scan; `orgNames` may show only the first few. */
  orgCount: number
  orgNames: string[]
  sampleLastError: string | null
}

export interface StuckOutboxHealth {
  /** Exact totals, independent of the sampling cap. */
  totalStuck: number
  pendingStuck: number
  processingStuck: number
  groups: StuckOutboxGroup[]
  /** True when more stuck rows exist than were scanned to build the groups. */
  truncated: boolean
  scannedCount: number
  thresholdMinutes: number
}

export interface QboConnectionHealth {
  orgId: string
  orgName: string
  companyName: string | null
  status: string
  lastSyncAt: string | null
  lastError: string | null
  tokenExpiresAt: string | null
  refreshTokenExpiresAt: string | null
  refreshFailureCount: number
}

// A job is overdue when its last success is older than twice its cadence
// (plus slack so a slow run doesn't flap the badge).
const OVERDUE_SLACK_MS = 5 * 60 * 1000

export async function getCronHealth(): Promise<CronJobHealth[]> {
  const supabase = createServiceSupabaseClient()
  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  return Promise.all(
    CRON_JOBS.map(async (job) => {
      const [lastRunRes, lastSuccessRes, failuresRes] = await Promise.all([
        supabase
          .from("job_runs")
          .select("started_at, status, duration_ms, error")
          .eq("job_name", job.name)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("job_runs")
          .select("started_at")
          .eq("job_name", job.name)
          .eq("status", "success")
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("job_runs")
          .select("*", { count: "exact", head: true })
          .eq("job_name", job.name)
          .eq("status", "failed")
          .gte("started_at", dayAgoIso),
      ])

      const lastRun = lastRunRes.data
      const lastSuccessAt = lastSuccessRes.data?.started_at ?? null
      const failuresLast24h = failuresRes.count ?? 0

      let state: CronJobState
      if (!lastRun) {
        state = "no-data"
      } else {
        const overdueThreshold =
          job.expectedIntervalMinutes * 2 * 60 * 1000 + OVERDUE_SLACK_MS
        const successAge = lastSuccessAt
          ? Date.now() - new Date(lastSuccessAt).getTime()
          : Number.POSITIVE_INFINITY
        if (successAge > overdueThreshold) {
          state = "overdue"
        } else if (lastRun.status === "failed") {
          state = "failing"
        } else {
          state = "healthy"
        }
      }

      return {
        name: job.name,
        path: job.path,
        scheduleLabel: job.scheduleLabel,
        state,
        lastRunAt: lastRun?.started_at ?? null,
        lastRunStatus: lastRun?.status ?? null,
        lastRunDurationMs: lastRun?.duration_ms ?? null,
        lastSuccessAt,
        lastError: lastRun?.status === "failed" ? (lastRun?.error ?? null) : null,
        failuresLast24h,
      }
    }),
  )
}

const FAILED_ITEMS_LIMIT = 50

export async function getOutboxHealth(): Promise<OutboxHealth> {
  const supabase = createServiceSupabaseClient()
  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [pendingRes, processingRes, failedRes, completedRes, oldestPendingRes, failedItemsRes] =
    await Promise.all([
      supabase.from("outbox").select("*", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("outbox").select("*", { count: "exact", head: true }).eq("status", "processing"),
      supabase.from("outbox").select("*", { count: "exact", head: true }).eq("status", "failed"),
      supabase
        .from("outbox")
        .select("*", { count: "exact", head: true })
        .eq("status", "completed")
        .gte("updated_at", dayAgoIso),
      supabase
        .from("outbox")
        .select("created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("outbox")
        .select("id, job_type, org_id, retry_count, last_error, run_at, updated_at, created_at, org:orgs(name)")
        .eq("status", "failed")
        .order("updated_at", { ascending: false })
        .limit(FAILED_ITEMS_LIMIT),
    ])

  const failedItems: OutboxFailedItem[] = (failedItemsRes.data ?? []).map((row) => {
    const org = Array.isArray(row.org) ? row.org[0] : row.org
    return {
      id: row.id,
      jobType: row.job_type,
      orgId: row.org_id ?? null,
      orgName: org?.name ?? null,
      retryCount: row.retry_count ?? 0,
      lastError: row.last_error ?? null,
      runAt: row.run_at ?? null,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    }
  })

  return {
    pendingCount: pendingRes.count ?? 0,
    processingCount: processingRes.count ?? 0,
    failedCount: failedRes.count ?? 0,
    completedLast24h: completedRes.count ?? 0,
    oldestPendingAt: oldestPendingRes.data?.created_at ?? null,
    failedItems,
  }
}

// A job that hasn't moved in this long isn't "in flight", it's wedged — the
// outbox drain runs every 5 minutes, so 10 covers a missed tick plus slack.
const STUCK_THRESHOLD_MINUTES = 10
// Groups shown in the detail table. Exact totals are counted separately so a
// truncated list still reports honest numbers.
const STUCK_GROUP_LIMIT = 50
// How many stuck rows we pull to build the groups.
const STUCK_SCAN_LIMIT = 2000
const STUCK_ORG_NAMES_PER_GROUP = 8

/**
 * Jobs the queue has silently dropped: pending past their run_at, or claimed by
 * a worker that never finished. Grouped by job type so a broken trigger chain
 * (drawing-set fan-out, for one) shows up as a single obvious row.
 */
export async function listStuckOutboxJobs(): Promise<StuckOutboxHealth> {
  const supabase = createServiceSupabaseClient()
  const cutoffIso = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString()

  const [pendingRes, processingRes, rowsRes] = await Promise.all([
    supabase
      .from("outbox")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("run_at", cutoffIso),
    supabase
      .from("outbox")
      .select("*", { count: "exact", head: true })
      .eq("status", "processing")
      .lt("updated_at", cutoffIso),
    supabase
      .from("outbox")
      .select("job_type, status, run_at, updated_at, last_error, org:orgs(name)")
      .or(
        `and(status.eq.pending,run_at.lt.${cutoffIso}),and(status.eq.processing,updated_at.lt.${cutoffIso})`,
      )
      .order("run_at", { ascending: true })
      .limit(STUCK_SCAN_LIMIT),
  ])

  if (pendingRes.error) throw pendingRes.error
  if (processingRes.error) throw processingRes.error
  if (rowsRes.error) throw rowsRes.error

  const rows = rowsRes.data ?? []
  const pendingStuck = pendingRes.count ?? 0
  const processingStuck = processingRes.count ?? 0

  interface Accumulator extends Omit<StuckOutboxGroup, "orgNames" | "orgCount"> {
    orgNames: Set<string>
  }
  const byJobType = new Map<string, Accumulator>()

  for (const row of rows) {
    const org = Array.isArray(row.org) ? row.org[0] : row.org
    const stuckSince = row.status === "processing" ? row.updated_at : row.run_at
    let group = byJobType.get(row.job_type)
    if (!group) {
      group = {
        jobType: row.job_type,
        pendingCount: 0,
        processingCount: 0,
        totalCount: 0,
        oldestStuckSince: stuckSince,
        orgNames: new Set<string>(),
        sampleLastError: null,
      }
      byJobType.set(row.job_type, group)
    }

    group.totalCount += 1
    if (row.status === "processing") group.processingCount += 1
    else group.pendingCount += 1

    if (new Date(stuckSince).getTime() < new Date(group.oldestStuckSince).getTime()) {
      group.oldestStuckSince = stuckSince
    }
    group.orgNames.add(org?.name ?? "Unknown")
    if (!group.sampleLastError && row.last_error) group.sampleLastError = row.last_error
  }

  const groups: StuckOutboxGroup[] = Array.from(byJobType.values())
    .sort(
      (a, b) =>
        new Date(a.oldestStuckSince).getTime() - new Date(b.oldestStuckSince).getTime() ||
        b.totalCount - a.totalCount,
    )
    .slice(0, STUCK_GROUP_LIMIT)
    .map((group) => ({
      ...group,
      orgCount: group.orgNames.size,
      orgNames: Array.from(group.orgNames).sort().slice(0, STUCK_ORG_NAMES_PER_GROUP),
    }))

  return {
    totalStuck: pendingStuck + processingStuck,
    pendingStuck,
    processingStuck,
    groups,
    truncated: pendingStuck + processingStuck > rows.length,
    scannedCount: rows.length,
    thresholdMinutes: STUCK_THRESHOLD_MINUTES,
  }
}

export async function getQboConnectionHealth(): Promise<QboConnectionHealth[]> {
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("accounting_connections")
    .select(
      "org_id, external_account_name, status, last_sync_at, last_error, token_expires_at, refresh_token_expires_at, refresh_failure_count, org:orgs(name)",
    )
    .is("disconnected_at", null)
    .order("last_sync_at", { ascending: true, nullsFirst: true })

  if (error) throw error

  return (data ?? []).map((row) => {
    const org = Array.isArray(row.org) ? row.org[0] : row.org
    return {
      orgId: row.org_id,
      orgName: org?.name ?? "Unknown",
      companyName: row.external_account_name ?? null,
      status: row.status,
      lastSyncAt: row.last_sync_at ?? null,
      lastError: row.last_error ?? null,
      tokenExpiresAt: row.token_expires_at ?? null,
      refreshTokenExpiresAt: row.refresh_token_expires_at ?? null,
      refreshFailureCount: row.refresh_failure_count ?? 0,
    }
  })
}

export async function retryOutboxItem(id: number, actorId?: string): Promise<void> {
  const supabase = createServiceSupabaseClient()

  const { data: item, error: itemError } = await supabase
    .from("outbox")
    .select("id, org_id, job_type, retry_count, last_error")
    .eq("id", id)
    .eq("status", "failed")
    .maybeSingle()
  if (itemError) throw itemError
  if (!item) throw new Error("Failed outbox item not found — it may have been retried already.")

  const { error } = await supabase
    .from("outbox")
    .update({ status: "pending", run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "failed")
  if (error) throw error

  await recordAudit({
    orgId: item.org_id,
    actorId,
    action: "update",
    entityType: "outbox",
    entityId: String(item.id),
    before: { status: "failed", retry_count: item.retry_count, last_error: item.last_error },
    after: { status: "pending", job_type: item.job_type },
    source: "platform_ops",
  })
}

export async function retryAllFailedOutbox(actorId?: string): Promise<number> {
  const supabase = createServiceSupabaseClient()

  const { data: items, error: itemsError } = await supabase
    .from("outbox")
    .select("id, org_id")
    .eq("status", "failed")
  if (itemsError) throw itemsError
  if (!items || items.length === 0) return 0

  const { error } = await supabase
    .from("outbox")
    .update({ status: "pending", run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("status", "failed")
  if (error) throw error

  const countByOrg = new Map<string, number>()
  for (const item of items) {
    if (!item.org_id) continue
    countByOrg.set(item.org_id, (countByOrg.get(item.org_id) ?? 0) + 1)
  }
  await Promise.all(
    Array.from(countByOrg.entries()).map(([orgId, count]) =>
      recordAudit({
        orgId,
        actorId,
        action: "update",
        entityType: "outbox",
        after: { retried_failed_jobs: count },
        source: "platform_ops",
      }),
    ),
  )

  return items.length
}
