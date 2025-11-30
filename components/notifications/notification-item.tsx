'use client'

import { formatDistanceToNow } from 'date-fns'
import { Check, CheckCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NotificationRecord } from '@/lib/services/notifications'
import { useNotifications } from '@/hooks/use-notifications'

interface NotificationItemProps {
  notification: NotificationRecord
  isRead: boolean
}

export function NotificationItem({ notification, isRead }: NotificationItemProps) {
  const { markAsRead } = useNotifications()
  const payload = notification.payload as any

  const handleClick = () => {
    if (!isRead) {
      markAsRead(notification.id)
    }
    // TODO: Navigate to the relevant page based on entity_type/entity_id
  }

  return (
    <div
      className={`p-3 rounded-lg border cursor-pointer transition-colors hover:bg-muted/50 ${
        !isRead ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800' : 'bg-background'
      }`}
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        {/* Unread indicator */}
        {!isRead && (
          <div className="w-2 h-2 bg-blue-500 rounded-full mt-2 flex-shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          {/* Title */}
          <h4 className={`text-sm font-medium truncate ${
            !isRead ? 'text-foreground' : 'text-muted-foreground'
          }`}>
            {payload.title}
          </h4>

          {/* Message */}
          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
            {payload.message}
          </p>

          {/* Timestamp */}
          <p className="text-xs text-muted-foreground mt-2">
            {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}
          </p>
        </div>

        {/* Mark as read button */}
        {!isRead && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation()
              markAsRead(notification.id)
            }}
          >
            <Check className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
