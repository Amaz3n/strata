import "server-only"
import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import type { SupabaseClient } from "@supabase/supabase-js"
import { FEATURE_FLAGS } from "@/lib/feature-flags/registry"

const contextSchema = z.object({ orgId: z.string().uuid(), jobId: z.string().regex(/^[1-9][0-9]*$/), receiptId: z.string().uuid(), notificationId: z.string().uuid(), channel: z.enum(["deliver_notification", "deliver_push"]) })
export type NotificationDeliveryContext = z.infer<typeof contextSchema>
const notificationSchema = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), user_id: z.string().uuid(), notification_type: z.literal("start_released"), payload: z.record(z.string(), z.unknown()), created_at: z.string() })
export type AuthorizedNotification = z.infer<typeof notificationSchema>

export function notificationDeliveryContext(job: unknown): NotificationDeliveryContext | null {
  const row = z.object({ payload: z.record(z.string(), z.unknown()).nullable().optional() }).parse(job)
  if (!row.payload || !Object.hasOwn(row.payload, "deliveryReceiptId")) return null
  const scoped = z.object({ id: z.union([z.string(), z.number().int().safe()]).transform(String), org_id: z.string(), job_type: z.string() }).parse(job)
  return contextSchema.parse({ orgId: scoped.org_id, jobId: scoped.id, channel: scoped.job_type, receiptId: row.payload.deliveryReceiptId, notificationId: row.payload.notificationId })
}
export async function authorizeNotificationDelivery(supabase: SupabaseClient, input: NotificationDeliveryContext): Promise<AuthorizedNotification> {
  const context = contextSchema.parse(input)
  const { data: flag, error: flagError } = await supabase.from("feature_flags").select("enabled,expires_at")
    .eq("org_id", context.orgId).eq("flag_key", FEATURE_FLAGS.notificationDeliveryReceipts)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (flagError) throw new Error(`Unable to verify delivery authorization controls: ${flagError.message}`)
  if (flag?.enabled !== true || flag.expires_at) throw new Error("Restore non-expiring notification delivery controls before sending this receipt")
  const { data, error } = await supabase.rpc("authorize_start_notification_delivery", { p_org_id: context.orgId, p_job_id: context.jobId, p_receipt_id: context.receiptId })
  if (error) throw new Error(`Notification delivery authorization failed: ${error.message}`)
  const note = notificationSchema.parse(data)
  if (note.id !== context.notificationId || note.org_id !== context.orgId) throw new Error("Authorized notification differs from this delivery job")
  return note
}
export async function recheckNotificationDelivery(supabase: SupabaseClient, context: NotificationDeliveryContext, original: AuthorizedNotification) {
  const current = await authorizeNotificationDelivery(supabase, context)
  if (!isDeepStrictEqual(current, original)) throw new Error("Notification source changed before provider send")
}
