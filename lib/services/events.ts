import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgMembership } from "@/lib/auth/context"
import { requireOrgContext } from "@/lib/services/context"
import { NotificationService } from "@/lib/services/notifications"
import { authorize } from "@/lib/services/authorization"
import type { NotificationType } from "@/lib/services/notifications"

type EventChannel = "activity" | "integration" | "notification"

export interface EventInput {
  orgId?: string
  actorId?: string | null
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

const FINANCIAL_NOTIFICATION_PERMISSIONS = ["invoice.read", "payment.read", "budget.read", "bill.read", "commitment.read"]

// Bid lifecycle events fire from the public bid portal (and the leveling
// workbench). They carry only a bid_package_id, so we resolve the package's job
// + creator to decide who hears about them. In-app only — never email.
const BID_NOTIFICATION_EVENTS = new Set<string>([
  "bid_submission_received",
  "bid_submission_withdrawn",
  "bid_award_rescinded",
  "bid_invite_declined",
])
const RESTRICTED_PROJECT_ROLE_KEYS = new Set(["client", "project_client", "portal_client", "sub", "portal_sub"])

export async function recordEvent(input: EventInput) {
  let resolvedOrgId = input.orgId
  let actorId = input.actorId ?? null

  try {
    const { user, orgId } = await requireOrgMembership(input.orgId)
    resolvedOrgId = orgId
    actorId = input.actorId ?? user.id
  } catch (error) {
    if (!input.orgId) {
      throw error
    }
  }

  if (!resolvedOrgId) {
    throw new Error("Failed to record event: organization context is required")
  }

  const supabase = createServiceSupabaseClient()
  const payload = {
    ...(input.payload ?? {}),
    ...(actorId ? { actor_id: actorId } : {}),
  }

  const { data, error } = await supabase
    .from("events")
    .insert({
      org_id: resolvedOrgId,
      event_type: input.eventType,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
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
      org_id: resolvedOrgId,
      event_type: input.eventType,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      payload,
      created_at: data.created_at,
    }, resolvedOrgId)
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

  // Bid events only carry a bid_package_id — hydrate the package title, its
  // project, and its creator onto the payload so both audience resolution and
  // notification copy have what they need.
  if (BID_NOTIFICATION_EVENTS.has(event.event_type)) {
    await enrichBidEvent(event, orgId)
  }

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

  const actorId = typeof (event.payload as any)?.actor_id === "string" ? ((event.payload as any).actor_id as string) : null
  const projectId = extractProjectIdFromEvent(event)

  const projectScopedEvents = new Set<string>([
    "task_created",
    "task_updated",
    "task_completed",
    "daily_log_created",
    "schedule_item_created",
    "schedule_item_updated",
    "schedule_risk",
    "rfi_created",
    "rfi_response_added",
    "rfi_decided",
    "submittal_created",
    "submittal_item_added",
    "submittal_decided",
    "change_order_created",
    "change_order_published",
    "change_order_approved",
    "invoice_created",
    "invoice_updated",
    "invoice_sent",
    "payment_recorded",
    "vendor_bill_submitted",
    "selection_created",
    "portal_message",
    "recipient_signed",
    "file_created",
    "file_archived",
    "file_deleted",
    "drawing_set_created",
    "drawing_set_deleted",
    "drawing_markup_created",
    "drawing_pin_created",
    "lien_waiver_created",
    "lien_waiver_signed",
    "warranty_request_created",
    "safety_incident_reported",
    "observation_created",
  ])

  const orgScopedEvents = new Set<string>([
    "team_member_invited",
    "company_created",
    "company_updated",
    "contact_created",
    "contact_updated",
    "project_created",
    "project_updated",
    "project_vendor_added",
    "commitment_created",
    "budget_created",
    "invoice_number_changed",
    "qbo_connected",
    "qbo_disconnected",
  ])

  if (BID_NOTIFICATION_EVENTS.has(event.event_type)) {
    const createdBy = typeof (event.payload as any)?.package_created_by === "string"
      ? ((event.payload as any).package_created_by as string)
      : null
    const userIds: string[] = createdBy ? [createdBy] : []
    if (projectId) {
      const { data: members, error } = await supabase
        .from("project_members")
        .select("user_id")
        .eq("project_id", projectId)
      if (!error && members?.length) {
        for (const member of members) if (member.user_id) userIds.push(member.user_id as string)
      }
    }
    return uniqUserIds(userIds).filter((id) => id && id !== actorId)
  }

  // Serious incidents (lost-time+) alert everyone who can administer the org,
  // regardless of project membership — this is the email-eligible alert type.
  if (event.event_type === "safety_incident_alert") {
    const { data: adminRoles } = await supabase
      .from("role_permissions")
      .select("role_id")
      .eq("permission_key", "org.admin")
    const adminRoleIds = (adminRoles ?? []).map((row: any) => row.role_id).filter(Boolean)
    if (adminRoleIds.length === 0) return []
    const { data: admins, error: adminsError } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("role_id", adminRoleIds)
    if (adminsError) {
      console.error("Failed to get org admins for incident alert:", adminsError)
      return []
    }
    return uniqUserIds((admins ?? []).map((m: any) => m.user_id))
  }

  if (projectId && projectScopedEvents.has(event.event_type)) {
    if (event.event_type === "payment_recorded") {
      return getProjectFinancialNotificationRecipients({
        supabase,
        orgId,
        projectId,
        actorId,
      })
    }

    const { data: members, error } = await supabase
      .from("project_members")
      .select("user_id")
      .eq("project_id", projectId)

    if (!error && members?.length) {
      return uniqUserIds(members.map((m: any) => m.user_id)).filter((id) => id && id !== actorId)
    }
  }

  if (!projectScopedEvents.has(event.event_type) && !orgScopedEvents.has(event.event_type)) {
    return []
  }

  const { data: members, error } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("status", "active")

  if (error) {
    console.error("Failed to get org members:", error)
    return []
  }

  return uniqUserIds((members ?? []).map((m: any) => m.user_id)).filter((id) => id && id !== actorId)
}

async function getProjectFinancialNotificationRecipients({
  supabase,
  orgId,
  projectId,
  actorId,
}: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  projectId: string
  actorId: string | null
}) {
  const { data: members, error } = await supabase
    .from("project_members")
    .select("user_id, status, role:roles(key)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "active")

  if (error) {
    console.error("Failed to get project members for payment notification:", error)
    return []
  }

  const candidateUserIds = uniqUserIds(
    (members ?? [])
      .filter((member: any) => {
        const role = Array.isArray(member.role) ? member.role[0] : member.role
        const roleKey = typeof role?.key === "string" ? role.key : null
        return !roleKey || !RESTRICTED_PROJECT_ROLE_KEYS.has(roleKey)
      })
      .map((member: any) => member.user_id),
  ).filter((id) => id && id !== actorId)

  if (candidateUserIds.length === 0) {
    return []
  }

  const { data: activeMemberships, error: membershipError } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .in("user_id", candidateUserIds)

  if (membershipError) {
    console.error("Failed to get active org memberships for payment notification:", membershipError)
    return []
  }

  const activeUserIds = new Set((activeMemberships ?? []).map((membership: any) => membership.user_id).filter(Boolean))
  const recipients: string[] = []

  for (const userId of candidateUserIds) {
    if (!activeUserIds.has(userId)) continue

    const decisions = await Promise.all(
      FINANCIAL_NOTIFICATION_PERMISSIONS.map((permission) =>
        authorize({
          permission,
          userId,
          orgId,
          projectId,
          supabase,
          resourceType: "project",
          resourceId: projectId,
          policyVersion: "payment-notification-v1",
        }),
      ),
    )

    if (decisions.some((decision) => decision.allowed)) {
      recipients.push(userId)
    }
  }

  return recipients
}

function buildNotificationFromEvent(event: EventRecord, userId: string) {
  const { event_type, payload, entity_type: rawEntityType, entity_id: rawEntityId } = event
  const entity_type = rawEntityType || undefined
  const entity_id = rawEntityId || undefined
  const safePayload = (payload ?? {}) as Record<string, any>
  const projectId = extractProjectIdFromEvent(event)

  const fallbackTitle = titleForEventType(event_type)
  const fallbackMessage =
    typeof safePayload.message === "string"
      ? safePayload.message
      : typeof safePayload.title === "string"
        ? safePayload.title
        : fallbackTitle

  switch (event_type) {
    case "task_completed":
      return {
        orgId: event.org_id,
        userId,
        type: "task_completed" as NotificationType,
        title: "Task completed",
        message: fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "daily_log_created":
      return {
        orgId: event.org_id,
        userId,
        type: "daily_log_created" as NotificationType,
        title: "Daily log added",
        message: fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "rfi_created":
      return {
        orgId: event.org_id,
        userId,
        type: "rfi_created" as NotificationType,
        title: "New RFI",
        message:
          typeof safePayload.subject === "string"
            ? safePayload.subject
            : typeof safePayload.rfi_number === "number"
              ? `RFI #${safePayload.rfi_number} created`
              : fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "rfi_response_added":
      return {
        orgId: event.org_id,
        userId,
        type: "rfi_response_added" as NotificationType,
        title: "RFI updated",
        message: fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "rfi_decided":
      return {
        orgId: event.org_id,
        userId,
        type: "rfi_decided" as NotificationType,
        title: "RFI decision",
        message:
          typeof safePayload.decision_status === "string"
            ? `Decision: ${safePayload.decision_status.replace(/_/g, " ")}`
            : fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "submittal_created":
      return {
        orgId: event.org_id,
        userId,
        type: "submittal_created" as NotificationType,
        title: "New submittal",
        message:
          typeof safePayload.title === "string"
            ? safePayload.title
            : typeof safePayload.submittal_number === "number"
              ? `Submittal #${safePayload.submittal_number} created`
              : fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "submittal_item_added":
      return {
        orgId: event.org_id,
        userId,
        type: "submittal_item_added" as NotificationType,
        title: "Submittal updated",
        message: fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "submittal_decided":
      return {
        orgId: event.org_id,
        userId,
        type: "submittal_decided" as NotificationType,
        title: "Submittal decision",
        message:
          typeof safePayload.decision_status === "string"
            ? `Decision: ${safePayload.decision_status.replace(/_/g, " ")}`
            : fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "change_order_published":
      return {
        orgId: event.org_id,
        userId,
        type: "change_order_published" as NotificationType,
        title: "Change order published",
        message: fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "change_order_approved":
      return {
        orgId: event.org_id,
        userId,
        type: "change_order_approved" as NotificationType,
        title: "Change order approved",
        message: fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "invoice_sent":
      return {
        orgId: event.org_id,
        userId,
        type: "invoice_sent" as NotificationType,
        title: "Invoice sent",
        message:
          typeof safePayload.invoice_number === "string"
            ? `Invoice #${safePayload.invoice_number} sent`
            : fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "payment_recorded":
      return {
        orgId: event.org_id,
        userId,
        type: "payment_recorded" as NotificationType,
        title: "Payment received",
        message:
          typeof safePayload.invoice_number === "string" && typeof safePayload.amount_cents === "number"
            ? `Invoice #${safePayload.invoice_number} was paid for ${formatCurrencyFromCents(safePayload.amount_cents)}.`
            : fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "recipient_signed":
      return {
        orgId: event.org_id,
        userId,
        type: "recipient_signed" as NotificationType,
        title: "Signature completed",
        message: fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "warranty_request_created":
      if (safePayload.created_via_portal !== true) {
        return null
      }

      return {
        orgId: event.org_id,
        userId,
        type: "warranty_request_created" as NotificationType,
        title: "Warranty request created",
        message: fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    case "bid_submission_received": {
      const company = typeof safePayload.company_name === "string" ? safePayload.company_name : "A subcontractor"
      const pkg = typeof safePayload.package_title === "string" ? safePayload.package_title : "a bid package"
      return {
        orgId: event.org_id,
        userId,
        type: "bid_submission_received" as NotificationType,
        title: "Bid received",
        message: `${company} submitted a bid on ${pkg}.`,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    case "bid_submission_withdrawn": {
      const company = typeof safePayload.company_name === "string" ? safePayload.company_name : "A subcontractor"
      const pkg = typeof safePayload.package_title === "string" ? safePayload.package_title : "a bid package"
      return {
        orgId: event.org_id,
        userId,
        type: "bid_submission_withdrawn" as NotificationType,
        title: "Bid withdrawn",
        message: `${company} withdrew their bid on ${pkg}.`,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    case "bid_invite_declined": {
      const pkg = typeof safePayload.package_title === "string" ? safePayload.package_title : "a bid package"
      return {
        orgId: event.org_id,
        userId,
        type: "bid_invite_declined" as NotificationType,
        title: "Bid invite declined",
        message: `An invited subcontractor declined to bid on ${pkg}.`,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    case "bid_award_rescinded": {
      const pkg = typeof safePayload.package_title === "string" ? safePayload.package_title : "a bid package"
      return {
        orgId: event.org_id,
        userId,
        type: "bid_award_rescinded" as NotificationType,
        title: "Award rescinded",
        message: `The award on ${pkg} was rescinded.`,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    case "portal_message":
      return {
        orgId: event.org_id,
        userId,
        type: "portal_message" as NotificationType,
        title: "New portal message",
        message:
          typeof safePayload.body === "string"
          ? safePayload.body
          : fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }

    default:
      // Generic fallback for supported event types
      return {
        orgId: event.org_id,
        userId,
        type: event_type as NotificationType,
        title: fallbackTitle,
        message: fallbackMessage,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
  }
}

/** Merge the bid package's title, project_id and creator onto a bid event's
 * payload so downstream audience + copy resolution can rely on them. */
async function enrichBidEvent(event: EventRecord, orgId: string) {
  const payload = (event.payload ?? {}) as Record<string, any>
  const packageId = typeof payload.bid_package_id === "string" ? payload.bid_package_id : null
  if (!packageId) return

  const supabase = createServiceSupabaseClient()
  const { data: pkg } = await supabase
    .from("bid_packages")
    .select("title, project_id, created_by")
    .eq("org_id", orgId)
    .eq("id", packageId)
    .maybeSingle()

  if (!pkg) return

  event.payload = {
    ...payload,
    package_title: pkg.title ?? payload.package_title ?? null,
    ...(pkg.project_id ? { project_id: pkg.project_id } : {}),
    ...(pkg.created_by ? { package_created_by: pkg.created_by } : {}),
  }
}

function extractProjectIdFromEvent(event: EventRecord): string | null {
  const payload = (event.payload ?? {}) as any
  if (typeof payload.project_id === "string") return payload.project_id
  if (typeof payload.projectId === "string") return payload.projectId
  if (typeof payload.project?.id === "string") return payload.project.id
  if (typeof payload.project?.project_id === "string") return payload.project.project_id
  return null
}

function uniqUserIds(userIds: Array<string | null | undefined>): string[] {
  return Array.from(new Set(userIds.filter(Boolean) as string[]))
}

function formatCurrencyFromCents(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100)
}

function titleForEventType(eventType: string): string {
  switch (eventType) {
    case "task_created":
      return "New task"
    case "task_updated":
      return "Task updated"
    case "task_completed":
      return "Task completed"
    case "daily_log_created":
      return "Daily log added"
    case "schedule_item_created":
      return "Schedule item created"
    case "schedule_item_updated":
      return "Schedule updated"
    case "schedule_risk":
      return "Schedule risk"
    case "rfi_created":
      return "New RFI"
    case "rfi_response_added":
      return "RFI updated"
    case "rfi_decided":
      return "RFI decision"
    case "submittal_created":
      return "New submittal"
    case "submittal_item_added":
      return "Submittal updated"
    case "submittal_decided":
      return "Submittal decision"
    case "change_order_created":
      return "Change order created"
    case "change_order_published":
      return "Change order published"
    case "change_order_approved":
      return "Change order approved"
    case "invoice_created":
      return "Invoice created"
    case "invoice_updated":
      return "Invoice updated"
    case "invoice_sent":
      return "Invoice sent"
    case "payment_recorded":
      return "Payment received"
    case "portal_message":
      return "New portal message"
    case "recipient_signed":
      return "Signature completed"
    case "warranty_request_created":
      return "Warranty request created"
    case "safety_incident_reported":
      return "Safety incident reported"
    case "safety_incident_alert":
      return "Serious safety incident"
    case "observation_created":
      return "New observation"
    case "inspection_completed":
      return "Inspection completed"
    default:
      return eventType.replace(/_/g, " ")
  }
}
