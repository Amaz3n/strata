import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { requireOrgMembership } from "@/lib/auth/context"
import {
  EMAIL_NOTIFICATION_TYPES,
  type EmailNotificationTypeSettings,
  type NotificationType,
  type NotificationInput,
} from "@/lib/types/notifications"

// Re-export types for backward compatibility
export type { NotificationType, NotificationInput }

export interface UserNotificationPreferences {
  email_enabled: boolean
  weekly_snapshot_enabled: boolean
  weekly_snapshot_last_sent_for_week?: string | null
  email_type_settings: EmailNotificationTypeSettings
}

export interface NotificationRecord {
  id: string
  org_id: string
  user_id: string
  notification_type: string
  payload: Record<string, unknown>
  read_at: string | null
  created_at: string
}

export class NotificationService {
  // Create notification + queue delivery
  async createAndQueue(input: NotificationInput): Promise<string> {
    const supabase = createServiceSupabaseClient()

    // Create notification record
    const { data: notification, error } = await supabase
      .from('notifications')
      .insert({
        org_id: input.orgId,
        user_id: input.userId,
        notification_type: input.type,
        payload: {
          title: input.title,
          message: input.message,
          project_id: input.projectId,
          entity_type: input.entityType,
          entity_id: input.entityId,
          event_id: input.eventId,
        }
      })
      .select('id')
      .single()

    if (error) {
      console.error('Failed to create notification:', error)
      throw new Error(`Failed to create notification: ${error.message}`)
    }

    // Queue delivery for all channels
    await this.queueDelivery(notification.id, input.orgId)

    return notification.id
  }

  // Queue delivery for a notification
  private async queueDelivery(notificationId: string, orgId: string): Promise<void> {
    await enqueueOutboxJob({
      orgId,
      jobType: 'deliver_notification',
      payload: { notificationId },
      runAt: new Date().toISOString() // Immediate delivery
    })
  }

  // Mark as read
  async markAsRead(notificationId: string): Promise<void> {
    const { supabase } = await requireOrgMembership()

    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationId)

    if (error) {
      console.error('Failed to mark notification as read:', error)
      throw new Error(`Failed to mark notification as read: ${error.message}`)
    }
  }

  // Get user's notifications
  async getUserNotifications(userId: string, unreadOnly = false): Promise<NotificationRecord[]> {
    const { supabase } = await requireOrgMembership()

    let query = supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)

    if (unreadOnly) {
      query = query.is('read_at', null)
    }

    const { data, error } = await query

    if (error) {
      console.error('Failed to get user notifications:', error)
      return []
    }

    return data as NotificationRecord[]
  }

  // Get user's unread count
  async getUnreadCount(userId: string): Promise<number> {
    const { supabase } = await requireOrgMembership()

    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('read_at', null)

    if (error) {
      console.error('Failed to get unread count:', error)
      return 0
    }

    return count || 0
  }

  async getUserPreferences(userId: string, orgId?: string): Promise<UserNotificationPreferences> {
    if (!orgId) {
      // For server actions, we need to get the orgId from context
      const { supabase, orgId: resolvedOrgId } = await import('@/lib/auth/context').then(m => m.requireOrgMembership())

      const { data, error } = await supabase
        .from('user_notification_prefs')
        .select('email_enabled, weekly_snapshot_enabled, weekly_snapshot_last_sent_for_week, email_type_settings')
        .eq('user_id', userId)
        .eq('org_id', resolvedOrgId)
        .single()

      if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
        console.error('Failed to get user preferences:', error)
        return defaultNotificationPreferences()
      }

      return normalizeNotificationPreferences(data)
    }

    // For direct service calls with orgId provided
    const supabase = createServiceSupabaseClient()

    const { data, error } = await supabase
      .from('user_notification_prefs')
      .select('email_enabled, weekly_snapshot_enabled, weekly_snapshot_last_sent_for_week, email_type_settings')
      .eq('user_id', userId)
      .eq('org_id', orgId)
      .single()

    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
      console.error('Failed to get user preferences:', error)
      return defaultNotificationPreferences()
    }

    return normalizeNotificationPreferences(data)
  }

  async updateUserPreferences(
    userId: string,
    input: {
      email_enabled: boolean
      weekly_snapshot_enabled: boolean
      email_type_settings?: EmailNotificationTypeSettings
    },
    orgId?: string,
  ): Promise<void> {
    let resolvedOrgId = orgId

    if (!resolvedOrgId) {
      // For server actions, we need to get the orgId from context
      const context = await import('@/lib/auth/context').then(m => m.requireOrgMembership())
      resolvedOrgId = context.orgId
    }

    const supabase = createServiceSupabaseClient()

    const { error } = await supabase
      .from('user_notification_prefs')
      .upsert({
        org_id: resolvedOrgId,
        user_id: userId,
        email_enabled: input.email_enabled,
        weekly_snapshot_enabled: input.weekly_snapshot_enabled,
        ...(input.email_type_settings ? { email_type_settings: normalizeEmailTypeSettings(input.email_type_settings) } : {}),
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,org_id'
      })

    if (error) {
      console.error('Failed to update user preferences:', error)
      throw new Error(`Failed to update preferences: ${error.message}`)
    }
  }
}

export function defaultEmailTypeSettings(): EmailNotificationTypeSettings {
  return Object.fromEntries(EMAIL_NOTIFICATION_TYPES.map((type) => [type.key, true])) as EmailNotificationTypeSettings
}

export function normalizeEmailTypeSettings(input: unknown): EmailNotificationTypeSettings {
  const defaults = defaultEmailTypeSettings()
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaults

  const source = input as Record<string, unknown>
  return Object.fromEntries(
    EMAIL_NOTIFICATION_TYPES.map((type) => [type.key, source[type.key] !== false]),
  ) as EmailNotificationTypeSettings
}

export function isEmailNotificationTypeEnabled(
  settings: unknown,
  notificationType: string | null | undefined,
): boolean {
  if (!notificationType) return true
  if (!EMAIL_NOTIFICATION_TYPES.some((type) => type.key === notificationType)) return true
  return normalizeEmailTypeSettings(settings)[notificationType as keyof EmailNotificationTypeSettings] !== false
}

function defaultNotificationPreferences(): UserNotificationPreferences {
  return {
    email_enabled: true,
    weekly_snapshot_enabled: false,
    email_type_settings: defaultEmailTypeSettings(),
  }
}

function normalizeNotificationPreferences(data: any): UserNotificationPreferences {
  if (!data) return defaultNotificationPreferences()
  return {
    email_enabled: data.email_enabled !== false,
    weekly_snapshot_enabled: data.weekly_snapshot_enabled === true,
    weekly_snapshot_last_sent_for_week: data.weekly_snapshot_last_sent_for_week ?? null,
    email_type_settings: normalizeEmailTypeSettings(data.email_type_settings),
  }
}
