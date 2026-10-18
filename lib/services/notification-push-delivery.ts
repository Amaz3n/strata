import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { isApnsConfigured, sendApnsNotification } from "@/lib/services/apns"
import { readAllRows } from "@/lib/land/paging"
import { authorizeNotificationDelivery, notificationDeliveryContext, recheckNotificationDelivery } from "@/lib/services/notification-delivery-authorization"

export async function deliverNotificationPush(supabase: SupabaseClient, job: unknown): Promise<void> {
  if (!isApnsConfigured()) throw new Error("APNs unavailable for queued delivery")
  const scoped = z.object({ org_id: z.string().uuid(), job_type: z.literal("deliver_push"), payload: z.record(z.string(), z.unknown()) }).parse(job)
  const context = notificationDeliveryContext(job)
  const notificationId = z.string().uuid().parse(scoped.payload.notificationId ?? scoped.payload.notification_id)
  const authorized = context ? await authorizeNotificationDelivery(supabase, context) : null
  const { data, error } = authorized ? { data: authorized, error: null } : await supabase.from("notifications")
    .select("id,org_id,user_id,notification_type,payload").eq("org_id", scoped.org_id).eq("id", notificationId).maybeSingle()
  if (error || !data) throw new Error(`Notification unavailable: ${error?.message ?? "missing source"}`)
  const notification = z.object({ id: z.string().uuid(), user_id: z.string().uuid(), notification_type: z.string(), payload: z.record(z.string(), z.unknown()) }).parse(data)
  const devices = await readAllRows((from, to) => supabase.from("device_tokens").select("id,token")
    .eq("user_id", notification.user_id).order("id").range(from, to), { cap: 1001, label: "Unable to load push devices" })
  if (devices.truncated) throw new Error("Push device roster exceeds the supported limit")
  const tokens = z.array(z.object({ id: z.string().uuid(), token: z.string().min(1) })).parse(devices.rows)
  const title = typeof notification.payload.title === "string" ? notification.payload.title : "Arc"
  const body = typeof notification.payload.message === "string" ? notification.payload.message : ""
  for (const token of tokens) {
    if (context && authorized) await recheckNotificationDelivery(supabase, context, authorized)
    const result = await sendApnsNotification({ deviceToken: token.token, title, body,
      collapseId: `notification-${notification.id}`,
      data: { notification_id: notification.id, type: notification.notification_type,
        project_id: typeof notification.payload.project_id === "string" ? notification.payload.project_id : undefined } })
    if (result.unregistered) {
      const { error: pruneError } = await supabase.from("device_tokens").delete().eq("user_id", notification.user_id).eq("id", token.id)
      if (pruneError) throw new Error(`Unable to remove invalid push device: ${pruneError.message}`)
    } else if (!result.ok) throw new Error(`APNs rejected notification (${result.status}: ${result.reason ?? "provider failure"})`)
  }
}
