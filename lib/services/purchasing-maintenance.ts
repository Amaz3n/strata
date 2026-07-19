import { NotificationService } from "@/lib/services/notifications"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function expirePastDueAgreements() {
  const supabase = createServiceSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase.from("vendor_price_agreements").update({ status: "expired" })
    .eq("status", "active").lt("effective_to", today).select("id,org_id")
  if (error) throw new Error(`Failed to expire price agreements: ${error.message}`)
  if (data?.length) {
    const { error: eventError } = await supabase.from("events").insert(data.map((row) => ({
      org_id: row.org_id, event_type: "price_agreement.expired", entity_type: "price_agreement",
      entity_id: row.id, payload: { effective_date: today, source: "purchasing_maintenance" }, channel: "activity",
    })))
    if (eventError) throw new Error(`Failed to record price agreement expiry: ${eventError.message}`)
  }
  return data?.length ?? 0
}

async function sendWeeklyVarianceDigest(now = new Date()) {
  if (now.getUTCDay() !== 5) return { sent: 0, organizations: 0 }
  const supabase = createServiceSupabaseClient()
  const weekStartDate = new Date(now)
  weekStartDate.setUTCDate(now.getUTCDate() - 7)
  const weekStart = weekStartDate.toISOString().slice(0, 10)
  const { data: rows, error } = await supabase.from("commitment_change_orders")
    .select("org_id,total_cents").not("reason_code_id", "is", null).eq("status", "approved").gte("approved_at", `${weekStart}T00:00:00.000Z`)
  if (error) throw new Error(`Failed to load weekly variance digest: ${error.message}`)
  const totals = new Map<string, { count: number; cents: number }>()
  for (const row of rows ?? []) {
    const current = totals.get(row.org_id) ?? { count: 0, cents: 0 }
    totals.set(row.org_id, { count: current.count + 1, cents: current.cents + Math.abs(Number(row.total_cents ?? 0)) })
  }
  const notificationService = new NotificationService()
  let sent = 0
  let organizations = 0
  for (const [orgId, summary] of totals) {
    const { data: existing } = await supabase.from("events").select("id").eq("org_id", orgId).eq("event_type", "variance_digest").eq("payload->>week_start", weekStart).limit(1)
    if (existing?.length) continue
    const { data: roleRows } = await supabase.from("role_permissions").select("role_id").eq("permission_key", "vpo.approve_large")
    const roleIds = (roleRows ?? []).map((row) => row.role_id)
    if (!roleIds.length) continue
    const { data: members } = await supabase.from("memberships").select("user_id").eq("org_id", orgId).eq("status", "active").in("role_id", roleIds)
    const { data: event } = await supabase.from("events").insert({ org_id: orgId, event_type: "variance_digest", entity_type: "organization", entity_id: orgId, payload: { week_start: weekStart, count: summary.count, absolute_variance_cents: summary.cents }, channel: "notification" }).select("id").single()
    for (const userId of new Set((members ?? []).map((row) => row.user_id).filter(Boolean))) {
      await notificationService.createAndQueue({ orgId, userId, type: "variance_digest", title: "Weekly variance review", message: `${summary.count} approved VPO${summary.count === 1 ? "" : "s"} totaled ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(summary.cents / 100)} in absolute variance.`, entityType: "organization", entityId: orgId, eventId: event?.id, metadata: { href: "/purchasing?tab=variance", week_start: weekStart } })
      sent += 1
    }
    organizations += 1
  }
  return { sent, organizations }
}

export async function runPurchasingMaintenance(now = new Date()) {
  const expired = await expirePastDueAgreements()
  const digest = await sendWeeklyVarianceDigest(now)
  return { expired, digest }
}
