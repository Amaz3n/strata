'use server'

import { requireOrgMembership } from '@/lib/auth/context'
import { NotificationService } from '@/lib/services/notifications'

export async function getNotificationPreferencesAction() {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  return await service.getUserPreferences(user.id)
}

export async function updateNotificationPreferencesAction(emailEnabled: boolean) {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  await service.updateUserPreferences(user.id, emailEnabled)

  return { success: true }
}

export async function getUserNotificationsAction(unreadOnly = false) {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  return await service.getUserNotifications(user.id, unreadOnly)
}

export async function getUnreadCountAction() {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  return await service.getUnreadCount(user.id)
}

export async function markNotificationAsReadAction(notificationId: string) {
  await requireOrgMembership()

  const service = new NotificationService()
  await service.markAsRead(notificationId)

  return { success: true }
}
