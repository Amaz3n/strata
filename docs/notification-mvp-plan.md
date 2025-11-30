# Simple Notification MVP Implementation Plan

## Overview
Build a minimal but complete notification system that integrates with your existing events and outbox infrastructure. Focus on **in-app notifications** (leveraging existing activity feed) and **basic email notifications** using Resend. Keep it simple - no SMS, webhooks, or advanced features for MVP.

## Database Schema Alignment ✅

**Existing Tables (perfect alignment):**
- `notifications`: (id, org_id, user_id, notification_type, payload, read_at, created_at)
- `notification_deliveries`: (id, org_id, notification_id, channel, status, sent_at, response)

**Missing Table (needs creation):**
```sql
create table if not exists user_notification_prefs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  email_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index user_notification_prefs_user_org_idx on user_notification_prefs (user_id, org_id);
alter table user_notification_prefs enable row level security;
```

## Architecture Overview

```
Event Occurs → Event Recorded → Notification Created → Outbox Job → Edge Function → Deliver (Email/In-App)
```

## 1. Core Notification Service Layer

**File**: `lib/services/notifications.ts`

```typescript
interface NotificationInput {
  orgId: string
  userId: string
  type: 'task_assigned' | 'daily_log_submitted' | 'photo_uploaded' | 'message_received' | 'schedule_changed'
  title: string
  message: string
  entityType?: string
  entityId?: string
  eventId?: string
}

export class NotificationService {
  // Create notification + queue delivery
  async createAndQueue(input: NotificationInput): Promise<string>

  // Mark as read
  async markAsRead(notificationId: string): Promise<void>

  // Get user's notifications
  async getUserNotifications(userId: string, unreadOnly = false)

  // Basic preferences (just email on/off for now)
  async getUserPreferences(userId: string)
  async updateUserPreferences(userId: string, emailEnabled: boolean)
}
```

## 2. Event-to-Notification Pipeline

**Extend existing**: `lib/services/events.ts`

Add to `recordEvent()` function:

```typescript
export async function recordEvent(input: EventInput) {
  // ... existing code ...

  // After recording event, create notifications
  await createNotificationsFromEvent(eventData, orgId)
}

async function createNotificationsFromEvent(event: EventRecord, orgId: string) {
  const notificationService = new NotificationService()

  // Define who should be notified based on event type
  const recipients = await getNotificationRecipients(event, orgId)

  for (const userId of recipients) {
    const notificationInput = buildNotificationFromEvent(event, userId)
    await notificationService.createAndQueue(notificationInput)
  }
}

function buildNotificationFromEvent(event: EventRecord, userId: string): NotificationInput {
  const { event_type, payload, entity_type, entity_id } = event

  switch (event_type) {
    case 'task_completed':
      return {
        orgId: event.org_id,
        userId,
        type: 'task_completed',
        title: 'Task Completed',
        message: payload.message || 'A task has been completed',
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id
      }
    // Add other event types...
  }
}
```

## 3. In-App Notification UI

**Use Sonner for ephemeral alerts + Activity Feed for persistent notifications**

### Sonner Toast Notifications (RECOMMENDED)
**✅ Already installed and configured!** Replace old Radix UI toasts with Sonner because it's **perfect for construction workflows**:

- **Real-time alerts**: Task assignments, schedule changes, safety issues
- **Success confirmations**: "Daily log submitted", "Photos uploaded"
- **Error notifications**: Upload failures, permission issues
- **Progress updates**: Background processes

### Why Sonner for Construction?
- **Mobile-first**: Perfect for field workers using phones/tablets
- **Non-intrusive**: Doesn't block workflow like modal dialogs
- **Action-oriented**: Can include "View Details" buttons
- **Priority levels**: Success (green), warning (yellow), error (red)
- **Construction urgency**: Safety alerts can be styled as errors, progress updates as success
- **Field-friendly**: Works offline, syncs when connection returns

**Add Sonner Toaster to layout**: `app/layout.tsx`

```typescript
import { Toaster } from "@/components/ui/sonner"

// Add to layout:
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />  {/* ← Add this */}
        </ThemeProvider>
      </body>
    </html>
  )
}
```

**Usage in notification service**:
```typescript
import { toast } from 'sonner'

// In NotificationService.deliverInApp()
if (channel === 'in_app') {
  toast.success(notification.title, {
    description: notification.message,
    action: {
      label: "View",
      onClick: () => navigateToEntity(notification)
    }
  })
}
```

### Activity Feed Notifications
**Extend existing activity feed**: `components/dashboard/activity-feed.tsx`

```typescript
// Add notification indicator to activity items
interface ActivityItemProps {
  item: ActivityItem
  showNotificationDot?: boolean  // For unread notifications
}

// Notification management component
export function NotificationBell() {
  const { notifications, unreadCount } = useNotifications()

  return (
    <Popover>
      <PopoverTrigger>
        <Bell className="relative">
          {unreadCount > 0 && (
            <Badge variant="destructive" className="absolute -top-1 -right-1">
              {unreadCount}
            </Badge>
          )}
        </Bell>
      </PopoverTrigger>
      <PopoverContent>
        <NotificationList />
      </PopoverContent>
    </Popover>
  )
}
```

## 4. Email Delivery with Resend

**Edge Function**: `supabase/functions/deliver-notifications/index.ts`

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

serve(async (req) => {
  try {
    const { notificationId } = await req.json()

    // Get notification details with user email
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: notification } = await supabase
      .from('notifications')
      .select(`
        *,
        app_users!inner(email),
        user_notification_prefs(email_enabled)
      `)
      .eq('id', notificationId)
      .single()

    // Check user preferences
    if (!notification.user_notification_prefs?.[0]?.email_enabled) {
      return new Response(JSON.stringify({ status: 'skipped' }))
    }

    // Send email via Resend
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'notifications@yourapp.com',
        to: [notification.app_users.email],
        subject: notification.title,
        html: generateEmailHTML(notification),
      }),
    })

    // Update delivery status
    await supabase
      .from('notification_deliveries')
      .insert({
        notification_id: notificationId,
        channel: 'email',
        status: emailResponse.ok ? 'sent' : 'failed',
        sent_at: new Date().toISOString(),
        response: await emailResponse.json()
      })

    return new Response(JSON.stringify({ status: 'processed' }))

  } catch (error) {
    console.error('Notification delivery failed:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})

function generateEmailHTML(notification) {
  return `
    <div>
      <h2>${notification.title}</h2>
      <p>${notification.message}</p>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}">View in App</a>
    </div>
  `
}
```

## 5. User Preferences (Minimal)

**UI**: Simple toggle in settings page

```typescript
// components/settings/notification-preferences.tsx
export function NotificationPreferences() {
  const [emailEnabled, setEmailEnabled] = useState(true)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center space-x-2">
          <Switch
            checked={emailEnabled}
            onCheckedChange={setEmailEnabled}
          />
          <Label>Email notifications</Label>
        </div>
      </CardContent>
    </Card>
  )
}
```

## 6. Outbox Integration

**Extend existing**: `lib/services/outbox.ts`

```typescript
// Add to enqueueOutboxJob
export async function enqueueNotificationDelivery(notificationId: string) {
  await enqueueOutboxJob({
    jobType: 'deliver_notification',
    payload: { notificationId },
    runAt: new Date().toISOString() // Immediate delivery
  })
}
```

## Current State & Migration

**Current**: App has Sonner installed but uses old Radix UI toast system. Toasts aren't rendered (missing Toaster in layout).

**Migration**: Replace `useToast` imports with Sonner `toast` function throughout the app.

## Implementation Order

1. **Day 1**: Add Sonner Toaster to layout + migrate existing toasts
2. **Day 2**: Create `user_notification_prefs` table + core notification service
3. **Day 3**: Event pipeline integration + Sonner toast delivery
4. **Day 4**: Activity feed notification indicators
5. **Day 5**: Email delivery setup with Resend
6. **Day 6**: User preferences UI + outbox integration
7. **Day 7**: Testing, edge cases, and polish

## Success Criteria

- ✅ Events trigger notifications automatically
- ✅ In-app notifications appear in activity feed
- ✅ Basic email notifications work
- ✅ Users can opt-out of emails
- ✅ No breaking changes to existing functionality
- ✅ Reliable delivery with outbox pattern

## Future Extensions (Post-MVP)

- SMS for urgent notifications
- Advanced preferences (per notification type)
- Digest emails (daily/weekly summaries)
- Push notifications
- Notification analytics
- Advanced rules engine

This plan gives you a complete, working notification system in 1 week while keeping complexity low and leveraging your existing infrastructure. The foundation will support all future enhancements.
