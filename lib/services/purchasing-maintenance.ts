import { NotificationService } from "@/lib/services/notifications"
import { collectPagedRows } from "@/lib/services/price-book"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const EXPIRY_BATCH_SIZE = 500
const EXPIRY_BATCH_LIMIT = 200
const DIGEST_LOOKBACK_WEEKS = 4

export async function expirePastDueAgreements() {
  const supabase = createServiceSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  let expired = 0
  // Batched rather than one blanket update: PostgREST returns at most 1000 rows,
  // so a single `update(...).select()` would flip every past-due agreement while
  // reporting — and recording expiry events for — only the first page of them.
  for (let batch = 0; batch < EXPIRY_BATCH_LIMIT; batch += 1) {
    const { data: due, error: dueError } = await supabase.from("vendor_price_agreements").select("id")
      .eq("status", "active").lt("effective_to", today).order("id").limit(EXPIRY_BATCH_SIZE)
    if (dueError) throw new Error(`Failed to find past-due price agreements: ${dueError.message}`)
    if (!due?.length) return expired

    const { data, error } = await supabase.from("vendor_price_agreements").update({ status: "expired" })
      .eq("status", "active").in("id", due.map((row) => row.id)).select("id,org_id")
    if (error) throw new Error(`Failed to expire price agreements: ${error.message}`)
    if (!data?.length) return expired

    const { error: eventError } = await supabase.from("events").insert(data.map((row) => ({
      org_id: row.org_id, event_type: "price_agreement.expired", entity_type: "price_agreement",
      entity_id: row.id, payload: { effective_date: today, source: "purchasing_maintenance" }, channel: "activity",
    })))
    if (eventError) throw new Error(`Failed to record price agreement expiry: ${eventError.message}`)
    expired += data.length
  }
  return expired
}

function startOfUtcWeek(date: Date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
  return start
}

/**
 * Every fully completed week in the lookback window, most recent first.
 *
 * The digest used to fire only when the cron happened to land on a Friday in UTC,
 * so a US-Pacific run late Thursday or a single missed window skipped the week for
 * good — the `week_start` dedupe on `events` prevents any backfill. Sending for any
 * un-sent completed week makes the schedule self-healing instead.
 */
export function completedWeekWindows(now: Date, lookbackWeeks = DIGEST_LOOKBACK_WEEKS) {
  const currentWeekStart = startOfUtcWeek(now)
  const windows: Array<{ weekStart: string; weekEndExclusive: string }> = []
  for (let index = 1; index <= lookbackWeeks; index += 1) {
    const start = new Date(currentWeekStart)
    start.setUTCDate(start.getUTCDate() - 7 * index)
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 7)
    windows.push({ weekStart: start.toISOString().slice(0, 10), weekEndExclusive: end.toISOString().slice(0, 10) })
  }
  return windows
}

export function summarizeVarianceByOrg(rows: Array<{ org_id: string; total_cents: number | string | null }>) {
  const totals = new Map<string, { count: number; cents: number }>()
  for (const row of rows) {
    const current = totals.get(row.org_id) ?? { count: 0, cents: 0 }
    totals.set(row.org_id, { count: current.count + 1, cents: current.cents + Math.abs(Number(row.total_cents ?? 0)) })
  }
  return totals
}

async function loadVarianceApproverRoleIds(supabase: ReturnType<typeof createServiceSupabaseClient>) {
  const { data, error } = await supabase.from("role_permissions").select("role_id")
    .eq("permission_key", "vpo.approve_large").limit(5000)
  if (error) throw new Error(`Failed to load variance approver roles: ${error.message}`)
  return Array.from(new Set((data ?? []).map((row) => row.role_id).filter(Boolean)))
}

async function sendWeeklyVarianceDigest(now = new Date()) {
  const supabase = createServiceSupabaseClient()
  const roleIds = await loadVarianceApproverRoleIds(supabase)
  if (!roleIds.length) return { sent: 0, organizations: 0 }
  const notificationService = new NotificationService()
  let sent = 0
  let organizations = 0

  for (const { weekStart, weekEndExclusive } of completedWeekWindows(now)) {
    // Paged: the digest reports money across every org, and a 1000-row PostgREST
    // cap would quietly report the wrong totals at volume rather than fail.
    const rows = await collectPagedRows<{ org_id: string; total_cents: number | string | null }>({
      label: "approved variance orders",
      fetchPage: (from, to) => supabase.from("commitment_change_orders").select("org_id,total_cents")
        .not("reason_code_id", "is", null).eq("status", "approved")
        .gte("approved_at", `${weekStart}T00:00:00.000Z`).lt("approved_at", `${weekEndExclusive}T00:00:00.000Z`)
        .order("id").range(from, to),
    })
    for (const [orgId, summary] of summarizeVarianceByOrg(rows)) {
      const { data: existing } = await supabase.from("events").select("id").eq("org_id", orgId)
        .eq("event_type", "variance_digest").eq("payload->>week_start", weekStart).limit(1)
      if (existing?.length) continue
      const { data: members } = await supabase.from("memberships").select("user_id")
        .eq("org_id", orgId).eq("status", "active").in("role_id", roleIds)
      const { data: event } = await supabase.from("events").insert({ org_id: orgId, event_type: "variance_digest", entity_type: "organization", entity_id: orgId, payload: { week_start: weekStart, week_end: weekEndExclusive, count: summary.count, absolute_variance_cents: summary.cents }, channel: "notification" }).select("id").single()
      for (const userId of new Set((members ?? []).map((row) => row.user_id).filter(Boolean))) {
        await notificationService.createAndQueue({ orgId, userId, type: "variance_digest", title: "Weekly variance review", message: `${summary.count} approved VPO${summary.count === 1 ? "" : "s"} totaled ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(summary.cents / 100)} in absolute variance for the week of ${weekStart}.`, entityType: "organization", entityId: orgId, eventId: event?.id, metadata: { href: "/purchasing?tab=variance", week_start: weekStart } })
        sent += 1
      }
      organizations += 1
    }
  }
  return { sent, organizations }
}

export async function runPurchasingMaintenance(now = new Date()) {
  const expired = await expirePastDueAgreements()
  const digest = await sendWeeklyVarianceDigest(now)
  return { expired, digest }
}
