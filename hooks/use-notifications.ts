'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useUser } from '@/lib/auth/client'
import { toast } from 'sonner'
import { getUserNotificationsAction, getUnreadCountAction, markNotificationAsReadAction } from '@/app/(app)/settings/actions'
import type { NotificationRecord, NotificationType } from '@/lib/types/notifications'

export function useNotifications() {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const { user } = useUser()

  const supabase = useMemo(() => createClient(), [])

  const mapNotification = useCallback((n: any): NotificationRecord => {
    return {
      id: n.id,
      org_id: n.org_id,
      user_id: n.user_id,
      type: n.notification_type as NotificationType,
      title: (n.payload as any)?.title ?? 'Notification',
      message: (n.payload as any)?.message ?? '',
      payload: n.payload ?? {},
      is_read: !!n.read_at,
      created_at: n.created_at,
      updated_at: n.updated_at ?? n.created_at,
      project_id: (n.payload as any)?.project_id,
      entity_type: (n.payload as any)?.entity_type,
      entity_id: (n.payload as any)?.entity_id,
    }
  }, [])

  const loadNotifications = useCallback(async () => {
    if (!user) return

    try {
      setIsLoading(true)
      const [allNotifications, count] = await Promise.all([
        getUserNotificationsAction(),
        getUnreadCountAction()
      ])

      setNotifications(allNotifications.map(mapNotification))
      setUnreadCount(count)
    } catch (error) {
      console.error('Failed to load notifications:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user, mapNotification])

  useEffect(() => {
    if (!user) return

    // Load initial notifications
    loadNotifications()

    // Subscribe to new notifications
    const channel = supabase
      .channel('notifications')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const newNotificationRaw = payload.new
          const newNotification = mapNotification(newNotificationRaw)

          // Add to notifications list
          setNotifications(prev => [newNotification, ...prev])
          setUnreadCount(prev => prev + 1)

          // Show toast for new notifications
          showNotificationToast(newNotification)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user, loadNotifications, supabase, mapNotification])

  const markAsRead = async (notificationId: string) => {
    try {
      await markNotificationAsReadAction(notificationId)

      // Update local state
      setNotifications(prev =>
        prev.map(n =>
          n.id === notificationId
            ? { ...n, is_read: true }
            : n
        )
      )
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch (error) {
      console.error('Failed to mark notification as read:', error)
    }
  }

  const markAllAsRead = async () => {
    try {
      // Mark all unread notifications as read
      const unreadNotifications = notifications.filter(n => !n.is_read)
      await Promise.all(
        unreadNotifications.map(n => markAsRead(n.id))
      )
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error)
    }
  }

  return {
    notifications,
    unreadCount,
    isLoading,
    markAsRead,
    markAllAsRead,
    refresh: loadNotifications
  }
}

function showNotificationToast(notification: NotificationRecord) {
  const payload = notification.payload as any
  const href = getNotificationHref(payload)
  const viewAction = href
    ? {
        label: "View",
        onClick: () => {
          if (typeof window !== "undefined") {
            window.location.assign(href)
          }
        },
      }
    : undefined

  // Show different toast types based on notification type
  switch (notification.type) {
    case 'task_completed':
      toast.success(notification.title, {
        description: notification.message,
        action: viewAction,
      })
      break

    case 'daily_log_created':
      toast.info(notification.title, {
        description: notification.message,
        action: viewAction,
      })
      break

    case 'schedule_item_updated':
    case 'schedule_risk':
      toast.warning(notification.title, {
        description: notification.message,
        action: viewAction,
      })
      break

    default:
      toast(notification.title, {
        description: notification.message,
        action: viewAction,
      })
  }
}

function getNotificationHref(payload: any): string | null {
  const projectId = typeof payload?.project_id === "string" ? payload.project_id : null
  const entityType = typeof payload?.entity_type === "string" ? payload.entity_type : null
  const entityId = typeof payload?.entity_id === "string" ? payload.entity_id : null

  if (!projectId) return null

  switch (entityType) {
    case "rfi":
      return `/projects/${projectId}/rfis`
    case "submittal":
      return `/projects/${projectId}/submittals`
    case "invoice":
      return `/projects/${projectId}/invoices`
    case "change_order":
      return `/projects/${projectId}/change-orders`
    case "file":
      return entityId ? `/projects/${projectId}/files?fileId=${entityId}` : `/projects/${projectId}/files`
    case "drawing_set":
    case "drawing_sheet":
    case "drawing_revision":
      return `/projects/${projectId}/drawings`
    case "task":
      return `/projects/${projectId}?tab=tasks`
    case "daily_log":
      return `/projects/${projectId}?tab=daily-logs`
    default:
      return `/projects/${projectId}`
  }
}
