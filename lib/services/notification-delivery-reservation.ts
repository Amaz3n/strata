import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { FEATURE_FLAGS } from "@/lib/feature-flags/registry"

type DeliveryChannel = "deliver_notification" | "deliver_push"
const reservationSchema = z.object({
  receipt_id: z.string().uuid(),
  job_id: z.string().regex(/^[1-9][0-9]*$/).nullable(),
  status: z.enum(["pending", "processing", "completed", "failed"]),
})

/** Returns false only for an alert that has never entered the receipt workflow. */
export async function reserveNotificationDeliveries(input: {
  supabase: SupabaseClient; orgId: string; notificationId: string; channels: DeliveryChannel[]
}): Promise<boolean> {
  const { supabase, orgId, notificationId } = input
  const { data: flag, error: flagError } = await supabase.from("feature_flags").select("enabled,expires_at")
    .eq("org_id", orgId).eq("flag_key", FEATURE_FLAGS.notificationDeliveryReceipts)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (flagError) throw new Error(`Unable to verify notification delivery controls: ${flagError.message}`)
  if (flag?.enabled === true && flag.expires_at) throw new Error("Notification delivery rollout cannot use an expiring flag")
  if (flag && typeof flag.enabled !== "boolean") throw new Error("Invalid notification delivery rollout state")

  if (flag?.enabled !== true) {
    const { data: receipt, error } = await supabase.from("notification_delivery_receipts").select("id")
      .eq("org_id", orgId).eq("notification_id", notificationId).limit(1).maybeSingle()
    // The gate defaults off before the additive migration exists. Other read
    // failures cannot establish that legacy enqueue is safe.
    if (error && error.code !== "42P01" && error.code !== "PGRST205") {
      throw new Error(`Unable to recover notification delivery controls: ${error.message}`)
    }
    if (receipt) throw new Error("Restore notification delivery receipts before replaying this alert")
    return false
  }

  // Each channel commits independently. If the second reservation loses its
  // response, replay recovers both identities instead of inserting new jobs.
  for (const channel of new Set(input.channels)) {
    const { data, error } = await supabase.rpc("reserve_notification_delivery", {
      p_org_id: orgId, p_notification_id: notificationId, p_job_type: channel,
    })
    if (error) throw new Error(`Unable to reserve notification delivery: ${error.message}`)
    const reservation = reservationSchema.parse(data)
    if (reservation.status === "failed") throw new Error("Notification delivery requires failed-job recovery")
    if (reservation.status !== "completed" && reservation.job_id === null) throw new Error("Active notification delivery has lost its job")
  }
  return true
}
