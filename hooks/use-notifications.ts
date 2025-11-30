'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useUser } from '@/lib/auth/client'
import { toast } from 'sonner'
import { getUserNotificationsAction, getUnreadCountAction, markNotificationAsReadAction } from '@/app/settings/actions'

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

  // Show different toast types based on notification type
  switch (notification.notification_type) {
    case 'task_completed':
      toast.success(payload.title, {
        description: payload.message,
        action: {
          label: 'View',
          onClick: () => {
            // TODO: Navigate to the task/project
            console.log('Navigate to task:', notification)
          }
        }
      })
      break

    case 'daily_log_submitted':
      toast.info(payload.title, {
        description: payload.message,
      })
      break

    case 'photo_uploaded':
      toast.success(payload.title, {
        description: payload.message,
      })
      break

    case 'schedule_changed':
      toast.warning(payload.title, {
        description: payload.message,
      })
      break

    default:
      toast(payload.title, {
        description: payload.message,
      })
  }
}
