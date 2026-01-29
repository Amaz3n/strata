'use client'

import { Bell, CheckCheck, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useNotifications } from '@/hooks/use-notifications'
import { NotificationItem } from './notification-item'

export function NotificationList() {
  const { notifications, unreadCount, markAllAsRead, isLoading } = useNotifications()

  const unreadNotifications = notifications.filter(n => !n.is_read)
  const readNotifications = notifications.filter(n => n.is_read)

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4">
        <h4 className="font-semibold">Notifications</h4>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={markAllAsRead}
              className="h-8 px-2 text-xs"
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              Mark all read
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Separator />

      {/* Content */}
      <ScrollArea className="h-80">
        {isLoading ? (
          <div className="p-4 text-center text-muted-foreground">
            Loading notifications...
          </div>
        ) : notifications.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            <Bell className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No notifications yet</p>
            <p className="text-xs">You'll see updates here when things happen</p>
          </div>
        ) : (
          <div className="p-2">
            {/* Unread notifications */}
            {unreadNotifications.length > 0 && (
              <>
                {unreadNotifications.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                    isRead={false}
                  />
                ))}
                {readNotifications.length > 0 && <Separator className="my-2" />}
              </>
            )}

            {/* Read notifications */}
            {readNotifications.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                isRead={true}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
