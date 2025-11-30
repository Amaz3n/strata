import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgMembership } from "@/lib/auth/context"
import { requireOrgContext } from "@/lib/services/context"
import { NotificationService } from "@/lib/services/notifications"

type EventChannel = "activity" | "integration" | "notification"

export interface EventInput {
  orgId?: string
  eventType: string
  entityType?: string
  entityId?: string
  payload?: Record<string, unknown>
  channel?: EventChannel
}

export interface ActivityEvent {
  id: string
  event_type: string
  entity_type: string | null
  entity_id: string | null
  payload: Record<string, unknown>
  created_at: string
}

export interface ActivityItem {
  id: string
  type: string
  title: string
  meta?: string
  createdAt: string
}

interface EventRecord {
  id: string
  org_id: string
  event_type: string
  entity_type: string | null
  entity_id: string | null
  payload: Record<string, unknown>
  created_at: string
}

export async function recordEvent(input: EventInput) {
  const { supabase, user, orgId } = await requireOrgMembership(input.orgId)
  const payload = {
    ...input.payload,
    actor_id: user.id,
  }

  const { data, error } = await supabase
    .from("events")
    .insert({
      org_id: orgId,
      event_type: input.eventType,
      entity_type: input.entityType,
      entity_id: input.entityId,
      payload,
      channel: input.channel ?? "activity",
    })
    .select("id, created_at")
    .single()

  if (error) {
    throw new Error(`Failed to record event: ${error.message}`)
  }

  // Create notifications for relevant users
  try {
    await createNotificationsFromEvent({
      id: data.id,
      org_id: orgId,
      event_type: input.eventType,
      entity_type: input.entityType,
      entity_id: input.entityId,
      payload,
      created_at: data.created_at,
    }, orgId)
  } catch (notificationError) {
    // Don't fail the event recording if notification creation fails
    console.error('Failed to create notifications from event:', notificationError)
  }

  return data
}

export async function getOrgActivity(limit = 15, orgId?: string): Promise<ActivityItem[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("events")
    .select("id, event_type, entity_type, entity_id, payload, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("channel", "activity")
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Failed to load activity", error)
    return []
  }

  return toActivityItems(data as ActivityEvent[])
}

export async function seedDemoActivity(orgId: string) {
  const supabase = createServiceSupabaseClient()

  const sampleEvents: EventInput[] = [
    {
      orgId,
      eventType: "task_completed",
      entityType: "task",
      payload: { message: "Foundation footings poured", project: "Westside Addition" },
    },
    {
      orgId,
      eventType: "photo_uploaded",
      entityType: "photo",
      payload: { message: "6 photos added", project: "Harrison Kitchen Remodel" },
    },
    {
      orgId,
      eventType: "daily_log",
      entityType: "daily_log",
      payload: { message: "Daily log submitted", project: "Westside Addition" },
    },
  ]

  const { error } = await supabase
    .from("events")
    .insert(
      sampleEvents.map((event) => ({
        org_id: event.orgId,
        event_type: event.eventType,
        entity_type: event.entityType,
        entity_id: event.entityId,
        payload: event.payload ?? {},
        channel: event.channel ?? "activity",
      })),
    )
    .select("id")

  if (error) {
    throw new Error(`Failed to seed activity: ${error.message}`)
  }
}

function toActivityItems(events: ActivityEvent[]): ActivityItem[] {
  return events.map((event) => ({
    id: event.id,
    type: event.event_type,
    title: resolveTitle(event),
    meta: resolveMeta(event),
    createdAt: event.created_at,
  }))
}

function resolveTitle(event: ActivityEvent) {
  const payload = event.payload || {}
  if (typeof payload.message === "string") return payload.message
  if (typeof payload.title === "string") return payload.title

  switch (event.event_type) {
    case "task_completed":
      return "Task completed"
    case "photo_uploaded":
      return "Photos uploaded"
    case "daily_log":
      return "Daily log submitted"
    case "change_order":
      return "Change order update"
    case "schedule_update":
      return "Schedule updated"
    default:
      return event.event_type.replace("_", " ")
  }
}

function resolveMeta(event: ActivityEvent) {
  const payload = event.payload || {}
  const project = typeof payload.project === "string" ? payload.project : null
  const actor = typeof payload.actor_name === "string" ? payload.actor_name : null

  if (project && actor) return `${project} • ${actor}`
  if (project) return project
  if (actor) return actor

  return event.entity_type ?? undefined
}

// Notification creation logic
async function createNotificationsFromEvent(event: EventRecord, orgId: string) {
  const notificationService = new NotificationService()

  // Define who should be notified based on event type
  const recipients = await getNotificationRecipients(event, orgId)

  for (const userId of recipients) {
    const notificationInput = buildNotificationFromEvent(event, userId)
    if (notificationInput) {
      await notificationService.createAndQueue(notificationInput)
    }
  }
}

async function getNotificationRecipients(event: EventRecord, orgId: string): Promise<string[]> {
  const supabase = createServiceSupabaseClient()

  // For now, notify all org members for relevant events
  // TODO: Make this more sophisticated based on roles, project membership, etc.
  switch (event.event_type) {
    case 'task_completed':
    case 'daily_log_submitted':
    case 'photo_uploaded':
    case 'schedule_changed':
      // Get all org members
      const { data: members, error } = await supabase
        .from('memberships')
        .select('user_id')
        .eq('org_id', orgId)
        .eq('status', 'active')

      if (error) {
        console.error('Failed to get org members:', error)
        return []
      }

      return members?.map(m => m.user_id) || []

    case 'message_received':
      // For messages, we might want different logic
      // For now, just return empty array (no notifications for messages)
      return []

    default:
      return []
  }
}

function buildNotificationFromEvent(event: EventRecord, userId: string) {
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

    case 'daily_log_submitted':
      return {
        orgId: event.org_id,
        userId,
        type: 'daily_log_submitted',
        title: 'Daily Log Submitted',
        message: payload.message || 'A daily log has been submitted',
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id
      }

    case 'photo_uploaded':
      return {
        orgId: event.org_id,
        userId,
        type: 'photo_uploaded',
        title: 'Photos Uploaded',
        message: payload.message || 'New photos have been uploaded',
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id
      }

    case 'schedule_changed':
      return {
        orgId: event.org_id,
        userId,
        type: 'schedule_changed',
        title: 'Schedule Updated',
        message: payload.message || 'The project schedule has been updated',
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id
      }

    default:
      return null
  }
}
