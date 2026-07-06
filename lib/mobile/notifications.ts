import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { MobileNotificationDTO, MobileNotificationsDTO } from "@/lib/mobile/contracts"

function mapNotification(row: any): MobileNotificationDTO {
  const payload = (row.payload ?? {}) as Record<string, unknown>
  const str = (value: unknown) => (typeof value === "string" && value.length ? value : null)
  return {
    id: row.id,
    type: row.notification_type ?? "notification",
    title: str(payload.title) ?? "Notification",
    message: str(payload.message) ?? "",
    is_read: row.read_at != null,
    project_id: str(payload.project_id),
    entity_type: str(payload.entity_type),
    entity_id: str(payload.entity_id),
    created_at: row.created_at,
  }
}

export async function listMobileNotifications(context: MobileOrgContext): Promise<MobileNotificationsDTO> {
  const { data, error } = await context.serviceSupabase
    .from("notifications")
    .select("id, notification_type, payload, read_at, created_at")
    .eq("org_id", context.orgId)
    .eq("user_id", context.user.id)
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) throw new MobileAPIError(500, "notifications_unavailable", "Notifications could not be loaded.")

  const notifications = (data ?? []).map(mapNotification)
  return {
    notifications,
    unread_count: notifications.filter((notification) => !notification.is_read).length,
  }
}

export async function markMobileNotificationRead(
  context: MobileOrgContext,
  notificationId: string,
): Promise<MobileNotificationDTO> {
  const { data, error } = await context.serviceSupabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("org_id", context.orgId)
    .eq("user_id", context.user.id)
    .eq("id", notificationId)
    .select("id, notification_type, payload, read_at, created_at")
    .maybeSingle()
  if (error) throw new MobileAPIError(500, "notification_update_failed", "The notification could not be updated.")
  if (!data) throw new MobileAPIError(404, "notification_not_found", "Notification not found.")
  return mapNotification(data)
}

export async function markAllMobileNotificationsRead(context: MobileOrgContext): Promise<{ updated: number }> {
  const { data, error } = await context.serviceSupabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("org_id", context.orgId)
    .eq("user_id", context.user.id)
    .is("read_at", null)
    .select("id")
  if (error) throw new MobileAPIError(500, "notification_update_failed", "Notifications could not be updated.")
  return { updated: (data ?? []).length }
}
