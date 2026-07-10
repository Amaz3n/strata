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

export async function getQboConnectionHealth(): Promise<QboConnectionHealth[]> {
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("qbo_connections")
    .select(
      "org_id, company_name, status, last_sync_at, last_error, token_expires_at, refresh_token_expires_at, refresh_failure_count, org:orgs(name)",
    )
    .is("disconnected_at", null)
    .order("last_sync_at", { ascending: true, nullsFirst: true })

  if (error) throw error

  return (data ?? []).map((row) => {
    const org = Array.isArray(row.org) ? row.org[0] : row.org
    return {
      orgId: row.org_id,
      orgName: org?.name ?? "Unknown",
      companyName: row.company_name ?? null,
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
