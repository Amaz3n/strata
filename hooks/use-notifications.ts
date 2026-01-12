'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useUser } from '@/lib/auth/client'
import { toast } from 'sonner'
import { getUserNotificationsAction, getUnreadCountAction, markNotificationAsReadAction } from '@/app/(app)/settings/actions'

interface NotificationRecord {
  id: string
  org_id: string
  user_id: string
  notification_type: string
  payload: Record<string, unknown>
  read_at: string | null
  created_at: string
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const { user } = useUser()

  const supabase = createClient()

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
          const newNotification = payload.new as NotificationRecord

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
  }, [user])

  const loadNotifications = async () => {
    if (!user) return

    try {
      setIsLoading(true)
      const [allNotifications, count] = await Promise.all([
        getUserNotificationsAction(),
        getUnreadCountAction()
      ])

      setNotifications(allNotifications)
      setUnreadCount(count)
    } catch (error) {
      console.error('Failed to load notifications:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const markAsRead = async (notificationId: string) => {
    try {
      await markNotificationAsReadAction(notificationId)

      // Update local state
      setNotifications(prev =>
        prev.map(n =>
          n.id === notificationId
            ? { ...n, read_at: new Date().toISOString() }
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
      const unreadNotifications = notifications.filter(n => !n.read_at)
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
  switch (notification.notification_type) {
    case 'task_completed':
      toast.success(payload.title, {
        description: payload.message,
        action: viewAction,
      })
      break

    case 'daily_log_submitted':
    case 'daily_log_created':
      toast.info(payload.title, {
        description: payload.message,
        action: viewAction,
      })
      break

    case 'photo_uploaded':
      toast.success(payload.title, {
        description: payload.message,
        action: viewAction,
      })
      break

    case 'schedule_changed':
    case 'schedule_item_updated':
    case 'schedule_risk':
      toast.warning(payload.title, {
        description: payload.message,
        action: viewAction,
      })
      break

    default:
      toast(payload.title, {
        description: payload.message,
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
