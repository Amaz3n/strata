import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgMembership } from "@/lib/auth/context"
import { requireOrgContext } from "@/lib/services/context"
import { NotificationService } from "@/lib/services/notifications"
import { authorize } from "@/lib/services/authorization"
import { paymentOperationsAlertDetails } from "@/lib/payments/operations-monitor"
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

// A provider account is not a vendor a builder recognises. These events name one,
// so the builder-facing facts — which of their companies it is, and who on their
// team invited it — are hydrated onto the payload before anything reads it.
const VENDOR_RECIPIENT_EVENTS = new Set<string>([
  "vendor_recipient_onboarding_started",
  "vendor_recipient_status_updated",
])

// A reversal is money moving backwards after Arc already reported it as settled.
// QBO-originated reversals reach Arc through the accounting webhook rather than
// the payment provider, but the money question is identical, so they share one
// audience policy.
const PAYMENT_REVERSAL_EVENTS = new Set<string>([
  "payment_reversed",
  "payment_reversed_from_qbo",
  "vendor_bill_payment_reversed",
])

/**
 * Payment-domain events that deliberately produce no notification.
 *
 * Every other payment/AP event is expected to have a `NotificationType`, a
 * recipient set, and a title — `tests/payment-notification-coverage.test.js`
 * fails the build otherwise. This list is the only escape hatch, and each entry
 * has to say why silence is the right answer. "Nobody asked for it yet" is not
 * a reason; add the notification instead.
 */
export const OPERATIONAL_ONLY_PAYMENT_EVENTS = new Set<string>([
  // Ledger mirroring from the accounting system. The import summary and the
  // reconciliation drift alert already cover anything that did not tie out.
  "bill_imported_from_qbo",
  "bill_payment_imported_from_qbo",
  "payment_imported_from_qbo",
  "vendor_credit_imported_from_qbo",
  // Lifecycle bookends of a run whose notifiable moments are submitted /
  // approved / paid / failed. Notifying the middle would train people to skip
  // the ends.
  "payment_run_created",
  "payment_run_canceled",
  "payment_run_execution_started",
  // The vendor-facing email IS the notification; a second one to the sender
  // would just restate what they clicked.
  "vendor_payment_invitation_sent",
  "vendor_remittance_sent",
  "vendor_bill_waiver_chased",
  // The bill's own hold state and approval history already show these; they
  // exist so the audit trail is complete, not so somebody is paged.
  "vendor_bill_auto_approved",
  "vendor_bill_decision_notified",
  "vendor_bill_deleted",
  "vendor_bill_updated",
  "vendor_bill_waiver_signed",
  "vendor_credit_created",
  // Marking a bill paid by hand is done by the person who is looking at it, and
  // the rail's own settlement notifies as `vendor_payment_paid`.
  "vendor_bill_paid",
  // A cost-coding correction. It shows on the project's cost view and in the
  // audit trail; it moves no money.
  "vendor_bill_reassigned",
  "vendor_credit_reassigned",
  // Recorded by a reviewer who is looking at the blocked-run queue when they
  // record it, and the release outcome notifies on its own.
  "payment_risk_override_granted",
  "payment_risk_block_confirmed",
])

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

  if (VENDOR_RECIPIENT_EVENTS.has(event.event_type)) {
    await enrichVendorRecipientEvent(event, orgId)
  }

  if (PAYMENT_REVERSAL_EVENTS.has(event.event_type)) {
    await enrichReversalEvent(event, orgId)
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

  // Requests route to whoever decides them; decisions route back to whoever
  // raises them. The decision half was declared as a notification type, given a
  // title, and emitted — but never given a recipient set, so five event types
  // resolved to an empty list and notified nobody at all.
  const permissionEvent = event.event_type === "vpo.requested"
    ? "vpo.approve"
    : event.event_type === "po_completion.reported"
      ? "po_completion.verify"
      : event.event_type === "vpo.approved" || event.event_type === "vpo.rejected"
        ? "vpo.request"
        : ["po_completion.verified", "po_completion.approved", "po_completion.rejected"].includes(event.event_type)
          ? "po_completion.report"
          : null
  if (permissionEvent) {
    const { data: roleRows } = await supabase.from("role_permissions").select("role_id").eq("permission_key", permissionEvent)
    const roleIds = (roleRows ?? []).map((row: any) => row.role_id).filter(Boolean)
    if (roleIds.length === 0) return []
    const { data: memberships } = await supabase.from("memberships").select("user_id").eq("org_id", orgId).eq("status", "active").in("role_id", roleIds)
    return uniqUserIds((memberships ?? []).map((row: any) => row.user_id)).filter((id) => id !== actorId)
  }

  const paymentSecurityEvents = new Set([
    "funding_source_review_requested",
    "funding_source_change_approved",
    "funding_source_change_rejected",
    "funding_source_activated",
    "funding_source_activation_failed",
    // A vendor mapping their global payout entity onto one of this builder's
    // company records is the moment a future payment's destination is decided.
    // The people who own the rail see it, even though they do not approve it.
    "vendor_payment_relationship_claimed",
    "vendor_payment_relationship_active",
    "vendor_payment_relationship_onboarding",
    "vendor_payment_relationship_suspended",
    "vendor_payment_relationship_revoked",
    "payment_rail_policy_updated",
    "payment_run_approvers_updated",
    "payment_hold_overridden",
  ])
  if (paymentSecurityEvents.has(event.event_type)) {
    const { data: roleRows } = await supabase.from("role_permissions")
      .select("role_id")
      .in("permission_key", ["payment.manage_rail", "payment.approve_run"])
    const roleIds = [...new Set((roleRows ?? []).map((row) => row.role_id).filter(Boolean))]
    if (roleIds.length === 0) return []
    const { data: memberships } = await supabase.from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("role_id", roleIds)
    return uniqUserIds((memberships ?? []).map((row) => row.user_id)).filter((id) => id !== actorId)
  }

  // An ambiguous submission is the one state where Arc cannot say whether the
  // builder's bank was debited, so it is deliberately the one payment event that
  // does NOT exclude the actor. On the scheduled path the actor is the preparer,
  // who is not at a screen; on the manual path they saw a transient error and
  // still need a durable record naming the disbursement to confirm.
  if (event.event_type === "payment_submission_needs_recovery") {
    const { data: roleRows } = await supabase.from("role_permissions")
      .select("role_id")
      .in("permission_key", ["payment.release", "payment.reconcile"])
    const roleIds = [...new Set((roleRows ?? []).map((row) => row.role_id).filter(Boolean))]
    if (roleIds.length === 0) return []
    const { data: memberships } = await supabase.from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("role_id", roleIds)
    return uniqUserIds([...(memberships ?? []).map((row) => row.user_id), ...(actorId ? [actorId] : [])])
  }

  // A vendor becoming payable is the moment the rail starts existing for that
  // vendor, and losing that status is the moment a scheduled run will fail. Both
  // go to the people who own the rail AND to whoever invited the vendor — the
  // inviter is routinely a PM or purchasing agent holding neither payment
  // permission, and they are the one person waiting on the answer.
  if (VENDOR_RECIPIENT_EVENTS.has(event.event_type)) {
    const inviterIds = Array.isArray(event.payload?.inviter_ids)
      ? uniqUserIds(event.payload.inviter_ids.filter((value): value is string => typeof value === "string"))
      : []
    const railOwners = await usersWithAnyPermission(supabase, orgId, ["payment.release", "payment.manage_rail"])
    return uniqUserIds([...railOwners, ...inviterIds]).filter((id) => id !== actorId)
  }

  // A reversal has two real audiences and used to reach only one of them: a
  // payload carrying a projectId went to project finance and nobody on the rail,
  // and a payload without one went to the rail and nobody on the project. The
  // union is deliberate. Over-notifying a reversal costs an email; missing one
  // leaves a bank balance nobody can explain.
  if (PAYMENT_REVERSAL_EVENTS.has(event.event_type)) {
    const [operators, projectFinance] = await Promise.all([
      usersWithAnyPermission(supabase, orgId, ["payment.release", "payment.reconcile"]),
      projectId
        ? getProjectFinancialNotificationRecipients({
            supabase,
            orgId,
            projectId,
            actorId,
            policyVersion: "payment-reversal-v1",
          })
        : Promise.resolve<string[]>([]),
    ])
    return uniqUserIds([...operators, ...projectFinance]).filter((id) => id !== actorId)
  }

  const paymentOperationalEvents = new Set([
    "payment_run_execution_failed",
    "payment_recovery_unattributed",
    "payment_operations_alert",
    "payment_run_fee_charge_failed",
    "vendor_transfer_needs_attention",
    "vendor_payment_returned",
    "payment_reconciliation_completed",
    "vendor_payout_destination_changed",
  ])
  if (paymentOperationalEvents.has(event.event_type)) {
    const permissionKeys = event.event_type === "payment_reconciliation_completed"
      ? ["payment.reconcile"]
      : event.event_type === "payment_run_fee_charge_failed"
        // The vendors were paid; only Arc's own fee is outstanding. That is a
        // rail-ownership problem, not a release problem.
        ? ["payment.manage_rail", "payment.reconcile"]
      : event.event_type === "payment_operations_alert"
        // A stalled release or a reconciliation that stopped running is a rail
        // problem, so the people who own the rail hear about it alongside the
        // ones who reconcile it.
        ? ["payment.reconcile", "payment.manage_rail"]
        : ["payment.release", "payment.reconcile"]
    const { data: roleRows } = await supabase.from("role_permissions").select("role_id").in("permission_key", permissionKeys)
    const roleIds = [...new Set((roleRows ?? []).map((row) => row.role_id).filter(Boolean))]
    if (roleIds.length === 0) return []
    const { data: memberships } = await supabase.from("memberships").select("user_id").eq("org_id", orgId).eq("status", "active").in("role_id", roleIds)
    return uniqUserIds((memberships ?? []).map((row) => row.user_id)).filter((id) => id !== actorId)
  }

  if (event.event_type === "accounting_reconciliation_drift") {
    const { data: roleRows } = await supabase
      .from("role_permissions")
      .select("role_id")
      .eq("permission_key", "books.reconcile")
    const roleIds = [...new Set((roleRows ?? []).map((row) => row.role_id).filter(Boolean))]
    if (roleIds.length === 0) return []
    const { data: memberships } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("role_id", roleIds)
    return uniqUserIds((memberships ?? []).map((row) => row.user_id)).filter((id) => id !== actorId)
  }

  const paymentRunEvents = new Set([
    "payment_run_submitted",
    "payment_run_approval_recorded",
    "payment_run_approved",
    "payment_run_rejected",
  ])
  if (paymentRunEvents.has(event.event_type) && event.entity_id) {
    if (event.event_type !== "payment_run_submitted") {
      const { data: run } = await supabase.from("payment_runs").select("requested_by").eq("org_id", orgId).eq("id", event.entity_id).maybeSingle()
      return run?.requested_by && run.requested_by !== actorId ? [run.requested_by] : []
    }
    // An org that designated approvers has said who owns this decision; mailing
    // everyone who merely holds the permission would train them to ignore it.
    const routedApprovers = Array.isArray(event.payload?.approver_ids)
      ? uniqUserIds(event.payload.approver_ids.filter((value): value is string => typeof value === "string"))
      : []
    if (routedApprovers.length > 0) return routedApprovers.filter((id) => id !== actorId)
    const { data: designated } = await supabase.from("payment_run_approvers").select("user_id").eq("org_id", orgId)
    if ((designated ?? []).length > 0) {
      return uniqUserIds((designated ?? []).map((row) => row.user_id)).filter((id) => id !== actorId)
    }
    const { data: roleRows } = await supabase.from("role_permissions").select("role_id").eq("permission_key", "payment.approve_run")
    const roleIds = [...new Set((roleRows ?? []).map((row) => row.role_id).filter(Boolean))]
    if (roleIds.length === 0) return []
    const { data: memberships } = await supabase.from("memberships").select("user_id").eq("org_id", orgId).eq("status", "active").in("role_id", roleIds)
    return uniqUserIds((memberships ?? []).map((row) => row.user_id)).filter((id) => id !== actorId)
  }

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
    "vendor_credit_applied",
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
    "accounting_connected",
    "accounting_disconnected",
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

  // The payable lifecycle goes to the people who can act on it, not to every
  // project member. An approval queue that emails the whole project is one
  // everybody filters, which is the same as not sending it.
  const payableApprovalEvents: Record<string, string[]> = {
    vendor_bill_submitted: ["bill.approve"],
    vendor_bill_approved: ["bill.write", "bill.approve"],
    vendor_bill_rejected: ["bill.write", "bill.approve"],
  }
  const payablePermissions = payableApprovalEvents[event.event_type]
  if (payablePermissions) {
    if (!projectId) return []
    const eligibleRecipients = await getProjectFinancialNotificationRecipients({
      supabase,
      orgId,
      projectId,
      actorId,
      permissions: payablePermissions,
      policyVersion: "payable-lifecycle-v1",
    })
    if (event.event_type !== "vendor_bill_submitted") {
      const payloadSubmitterId = typeof event.payload?.submitted_by_user_id === "string"
        ? event.payload.submitted_by_user_id
        : null
      const { data: submissionEvent } = payloadSubmitterId
        ? { data: null }
        : await supabase
            .from("events")
            .select("payload")
            .eq("org_id", orgId)
            .eq("entity_type", "vendor_bill")
            .eq("entity_id", event.entity_id)
            .eq("event_type", "vendor_bill_submitted")
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle()
      const originalPayload = submissionEvent?.payload && typeof submissionEvent.payload === "object"
        ? submissionEvent.payload as Record<string, unknown>
        : null
      const submitterId = payloadSubmitterId ?? (
        typeof originalPayload?.actor_id === "string" ? originalPayload.actor_id : null
      )

      // Decisions go back to the person who submitted the payable. Keep the
      // permission-derived intersection so an archived or de-scoped submitter
      // cannot receive a link to a bill they can no longer access.
      return submitterId
        ? eligibleRecipients.filter((userId) => userId === submitterId)
        : eligibleRecipients
    }

    // A payable created in the new bill workspace names its intended approvers.
    // Intersect with the permission-derived audience above so client metadata
    // can narrow notification delivery but can never widen access to the bill.
    const routedApproverIds = Array.isArray(event.payload?.approver_ids)
      ? uniqUserIds(
          event.payload.approver_ids.filter(
            (value): value is string => typeof value === "string",
          ),
        )
      : []
    if (routedApproverIds.length === 0) return eligibleRecipients
    const routedSet = new Set(routedApproverIds)
    return eligibleRecipients.filter((userId) => routedSet.has(userId))
  }

  // Every failure mode of a payment run was emailed and success was not, so the
  // only way an AP clerk learned a run finished was to go looking.
  if (event.event_type === "vendor_payment_paid") {
    const { data: roleRows } = await supabase.from("role_permissions")
      .select("role_id")
      .in("permission_key", ["payment.release", "payment.reconcile"])
    const roleIds = [...new Set((roleRows ?? []).map((row) => row.role_id).filter(Boolean))]
    if (roleIds.length === 0) return []
    const { data: memberships } = await supabase.from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("role_id", roleIds)
    return uniqUserIds((memberships ?? []).map((row) => row.user_id)).filter((id) => id !== actorId)
  }

  if (projectId && projectScopedEvents.has(event.event_type)) {
    if (event.event_type === "payment_recorded" || event.event_type === "vendor_credit_applied") {
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
  permissions = FINANCIAL_NOTIFICATION_PERMISSIONS,
  policyVersion = "payment-notification-v1",
}: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  projectId: string
  actorId: string | null
  /** Any one of these grants the notification. Defaults to read-level finance. */
  permissions?: string[]
  policyVersion?: string
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
      permissions.map((permission) =>
        authorize({
          permission,
          userId,
          orgId,
          projectId,
          supabase,
          resourceType: "project",
          resourceId: projectId,
          policyVersion,
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

    case "accounting_reconciliation_drift":
      // Without this case the in-app notification rendered its raw lowercase
      // event type as a title and linked nowhere, so the one alert that says
      // the books stopped agreeing looked like noise.
      return {
        orgId: event.org_id,
        userId,
        type: "accounting_reconciliation_drift" as NotificationType,
        title:
          typeof safePayload.new_discrepancy_count === "number"
            ? `${safePayload.new_discrepancy_count} new reconciliation ${safePayload.new_discrepancy_count === 1 ? "issue" : "issues"}`
            : "Accounting reconciliation drift",
        message: fallbackMessage,
        // `/reports/accounting-reconciliation` is not a route — the reconciliation
        // report's slug is `reconciliation` and it is project-scoped. The org-wide
        // finding queue lives on the period-close tab, which is also where an item
        // can be explained or resolved.
        metadata: {
          href: "/books/close",
          new_discrepancy_count: safePayload.new_discrepancy_count,
        },
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

    case "vendor_credit_applied": {
      const amount = typeof safePayload.amount_cents === "number"
        ? formatCentsForNotification(safePayload.amount_cents)
        : null
      return {
        orgId: event.org_id,
        userId,
        type: "vendor_credit_applied" as NotificationType,
        title: `Vendor credit applied${amount ? `: ${amount}` : ""}`,
        message: "An approved vendor credit reduced an open payable. Review the payable and accounting sync.",
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    case "payment_reversed": {
      const amount = typeof safePayload.amount_cents === "number"
        ? formatCentsForNotification(safePayload.amount_cents)
        : null
      return {
        orgId: event.org_id,
        userId,
        type: "payment_reversed" as NotificationType,
        title: `Customer payment reversed${amount ? `: ${amount}` : ""}`,
        message: `A previously recorded customer payment was reversed${typeof safePayload.reversal_type === "string" ? ` (${safePayload.reversal_type})` : ""}. Review the invoice balance and bank reconciliation.`,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * The provider sent the money back. The vendor was not paid, whatever the
     * payable said a minute ago, so the copy leads with that rather than with
     * the word "returned".
     */
    case "vendor_payment_returned": {
      const reason = typeof safePayload.reason === "string" ? safePayload.reason : null
      return {
        orgId: event.org_id,
        userId,
        type: "vendor_payment_returned" as NotificationType,
        title: "Vendor payment returned",
        message: `This payment was sent back by the receiving bank${reason ? ` (${reason})` : ""}, so the vendor has not been paid and the payable is open again. Fix the payout destination before it goes on another run — a second attempt to the same account returns the same way.`,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
        metadata: typeof safePayload.bill_id === "string" ? { bill_id: safePayload.bill_id } : undefined,
      }
    }

    /**
     * The run was approved and the provider refused it. Nobody was paid, which
     * is the reassuring half; the run still needs a human before it can move.
     */
    case "payment_run_execution_failed": {
      const providerStatus = typeof safePayload.provider_status === "string" ? safePayload.provider_status : null
      return {
        orgId: event.org_id,
        userId,
        type: "payment_run_execution_failed" as NotificationType,
        title: "Payment run failed during release",
        message: `An approved payment run could not be submitted to the payment provider${providerStatus ? ` (${providerStatus})` : ""}. No vendor in this run has been paid. Check the funding source and the run's limits before retrying.`,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * A run whose preparer no longer has an account. Automatic recovery cannot
     * run it as anybody, so it sits there — and this is one of the two states
     * where Arc cannot say whether the builder's bank was already debited.
     */
    case "payment_recovery_unattributed": {
      const reason = typeof safePayload.reason === "string" ? safePayload.reason : null
      return {
        orgId: event.org_id,
        userId,
        type: "payment_recovery_unattributed" as NotificationType,
        title: "Payment run stranded — needs a person",
        message: `A payment run could not be recovered automatically${reason ? ` (${reason})` : ""}. Arc cannot tell whether the funding bank was already debited, so check the provider record before anyone rebuilds this run.`,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * The daily tie-out. Sent on success too, on purpose: a reconciliation you
     * only hear about when it fails is one you cannot tell apart from a
     * reconciliation that stopped running.
     */
    case "payment_reconciliation_completed": {
      const exceptions = typeof safePayload.exception_count === "number" ? safePayload.exception_count : 0
      const difference = typeof safePayload.difference_cents === "number" && safePayload.difference_cents !== 0
        ? formatCentsForNotification(safePayload.difference_cents)
        : null
      return {
        orgId: event.org_id,
        userId,
        type: "payment_reconciliation_completed" as NotificationType,
        title: exceptions > 0
          ? `Payment reconciliation: ${exceptions} exception${exceptions === 1 ? "" : "s"}`
          : "Payment reconciliation clean",
        message: exceptions > 0
          ? `Today's vendor-payment reconciliation finished with ${exceptions} exception${exceptions === 1 ? "" : "s"}${difference ? ` and ${difference} unaccounted for` : ""}. Work the stuck and unconfirmed items first — those can still get worse.`
          : "Today's vendor-payment reconciliation tied out. Every debit and payout is accounted for.",
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * The funding bank is the account Arc debits, so every change to it is a
     * four-eyes event. The copy never names anything beyond the masked digits
     * the settings screen already shows.
     */
    case "funding_source_review_requested":
    case "funding_source_change_approved":
    case "funding_source_change_rejected":
    case "funding_source_activated":
    case "funding_source_activation_failed": {
      const failure = typeof safePayload.error === "string" ? safePayload.error : null
      const message =
        event_type === "funding_source_review_requested"
          ? "A funding bank change is waiting on an independent approval. Nothing can be debited from it until someone other than the requester approves it."
          : event_type === "funding_source_change_approved"
            ? "A funding bank change was approved. It becomes usable after its cooling period, not immediately."
            : event_type === "funding_source_change_rejected"
              ? "A funding bank change was rejected. The account stays unusable and no payment run can draw on it."
              : event_type === "funding_source_activated"
                ? "An approved funding bank finished its cooling period and can now fund payment runs."
                : `An approved funding bank could not be activated after its cooling period${failure ? ` (${failure})` : ""}. Payment runs cannot draw on it until this is resolved.`
      return {
        orgId: event.org_id,
        userId,
        type: event_type as NotificationType,
        title: titleForEventType(event_type),
        message,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
        metadata: typeof safePayload.funding_source_id === "string"
          ? { funding_source_id: safePayload.funding_source_id }
          : undefined,
      }
    }

    /**
     * A vendor payment somebody recorded by hand was undone. The bill is open
     * again for that amount, which is the fact that matters — a payable that
     * silently reopens is a payable that gets paid twice.
     */
    case "vendor_bill_payment_reversed": {
      const amount = typeof safePayload.amount_cents === "number"
        ? formatCentsForNotification(safePayload.amount_cents)
        : null
      return {
        orgId: event.org_id,
        userId,
        type: "vendor_bill_payment_reversed" as NotificationType,
        title: `Vendor payment reversed${amount ? `: ${amount}` : ""}`,
        message: `A recorded vendor payment was reversed${typeof safePayload.reason === "string" ? ` (${safePayload.reason})` : ""}. The payable is open again for that amount — check it before it goes on another run.`,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * QuickBooks, not Arc, decided this payment no longer exists. The copy has
     * to say that plainly: Arc reopened the balance to stay consistent with the
     * ledger, and it cannot tell whether money actually went back to the
     * customer. Re-billing before someone confirms is how a customer gets
     * invoiced twice.
     */
    case "payment_reversed_from_qbo": {
      const amount = typeof safePayload.amount_cents === "number"
        ? formatCentsForNotification(safePayload.amount_cents)
        : null
      return {
        orgId: event.org_id,
        userId,
        type: "payment_reversed_from_qbo" as NotificationType,
        title: `Customer payment reversed in QuickBooks${amount ? `: ${amount}` : ""}`,
        message:
          "A customer payment was deleted in QuickBooks, so Arc reopened the invoice balance to match. Arc did not initiate this and cannot tell whether the money was returned — confirm the deletion was intentional before re-billing.",
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * The moment the rail starts existing for one vendor. Everything upstream of
     * this — the invite, the claim, the Stripe flow — is preparation; this is the
     * notification that changes what somebody can do today.
     */
    case "vendor_recipient_status_updated": {
      const vendor = typeof safePayload.company_name === "string" && safePayload.company_name
        ? safePayload.company_name
        : "A vendor"
      const payable = safePayload.payouts_enabled === true && safePayload.status === "ready"
      const companyId = typeof safePayload.company_id === "string" ? safePayload.company_id : null
      return {
        orgId: event.org_id,
        userId,
        type: "vendor_recipient_status_updated" as NotificationType,
        title: payable
          ? `${vendor} can now be paid through Arc Pay`
          : `${vendor} is no longer payable through Arc Pay`,
        message: payable
          ? `${vendor} finished business and bank verification. Their approved bills can go on the next Arc Pay run. Your team only ever sees the masked destination; the full bank details stay with the payment provider.`
          : `${vendor} no longer has a verified payout account, so Arc Pay runs holding their bills will not release. They have to finish verification again before you can pay them electronically.`,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
        metadata: { href: companyId ? `/directory/${companyId}` : "/payables", company_id: companyId },
      }
    }

    case "vendor_recipient_onboarding_started": {
      const vendor = typeof safePayload.company_name === "string" && safePayload.company_name
        ? safePayload.company_name
        : "A vendor"
      const companyId = typeof safePayload.company_id === "string" ? safePayload.company_id : null
      return {
        orgId: event.org_id,
        userId,
        type: "vendor_recipient_onboarding_started" as NotificationType,
        title: `${vendor} started Arc Pay setup`,
        message: `${vendor} opened business and bank verification with the payment provider. Nothing to do until they finish — you will hear again when their bills can be paid through Arc Pay.`,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
        metadata: { href: companyId ? `/directory/${companyId}` : "/payables", company_id: companyId },
      }
    }

    case "payment_rail_policy_updated":
    case "payment_run_approvers_updated":
    case "payment_hold_overridden":
    case "vendor_payment_relationship_active":
    case "vendor_payment_relationship_onboarding":
    case "vendor_payment_relationship_suspended":
    case "vendor_payment_relationship_revoked":
      return {
        orgId: event.org_id,
        userId,
        type: event_type as NotificationType,
        title: titleForEventType(event_type),
        message: fallbackMessage,
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

    /**
     * The builder's money cleared to Arc and the vendor did not get paid. That
     * is the worst intermediate state in the system, so the copy says exactly
     * that rather than describing it as a failed payment.
     */
    case "vendor_transfer_needs_attention": {
      const amount = typeof safePayload.amount_cents === "number"
        ? formatCentsForNotification(safePayload.amount_cents)
        : null
      const reason = typeof safePayload.error === "string" ? safePayload.error : null
      return {
        orgId: event.org_id,
        userId,
        type: "vendor_transfer_needs_attention" as NotificationType,
        title: `Vendor payout blocked${amount ? `: ${amount}` : ""}`,
        message: `This payment was debited from your bank and has not reached the vendor${reason ? ` (${reason})` : ""}. Arc is holding the funds and will retry, but someone should check the vendor's payout account.`,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * A vendor's payout bank changed. This is the "change the payee, pay
     * immediately" vector, so the copy names the masked account and the hold
     * rather than describing it as a routine settings update. Nothing beyond the
     * last four ever appears here.
     */
    case "vendor_payout_destination_changed": {
      const last4 = typeof safePayload.bank_last4 === "string" ? safePayload.bank_last4 : null
      const lockedUntil = typeof safePayload.locked_until === "string" ? safePayload.locked_until : null
      return {
        orgId: event.org_id,
        userId,
        type: "vendor_payout_destination_changed" as NotificationType,
        title: `Vendor payout bank changed${last4 ? ` to •••• ${last4}` : ""}`,
        message: `A vendor you pay through Arc has a new payout bank account. Payments to them are held${lockedUntil ? ` until ${new Date(lockedUntil).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : ""}. Confirm the change with someone you already know at the vendor, using a number you already have.`,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * The vendors were paid and Arc's own fee debit did not go through. The copy
     * has to lead with that, because the instinct on seeing a payment failure is
     * to worry the subcontractor did not get paid.
     */
    case "payment_run_fee_charge_failed": {
      const amount = typeof safePayload.amount_cents === "number"
        ? formatCentsForNotification(safePayload.amount_cents)
        : null
      const reason = typeof safePayload.error === "string" ? safePayload.error : null
      return {
        orgId: event.org_id,
        userId,
        type: "payment_run_fee_charge_failed" as NotificationType,
        title: `Arc fee debit failed${amount ? `: ${amount}` : ""}`,
        message: `Your vendors were paid normally. Only Arc's own fee could not be collected${reason ? ` (${reason})` : ""}, and the balance is still owed.`,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * Automated monitoring found the rail in a state a healthy system would not
     * leave it in. The copy leads with what is stuck, because the recipient's
     * first question is whether money is currently not moving.
     */
    case "payment_operations_alert": {
      const details = paymentOperationsAlertDetails(safePayload)
      return {
        orgId: event.org_id,
        userId,
        type: "payment_operations_alert" as NotificationType,
        title: "Vendor payments need attention",
        message: details.length > 0 ? details.join(" ") : "Automated monitoring found a problem with vendor payment processing.",
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
    }

    /**
     * Unknown money state. The provider call did not return a trustworthy answer,
     * so Arc cannot say whether the debit happened. The copy must not imply
     * either outcome — it names the disbursement and asks a human to confirm it
     * against the provider before anyone builds a replacement run.
     */
    case "payment_submission_needs_recovery": {
      const reason = typeof safePayload.error === "string" ? safePayload.error : null
      return {
        orgId: event.org_id,
        userId,
        type: "payment_submission_needs_recovery" as NotificationType,
        title: "Vendor payment needs confirmation",
        message: `Arc could not confirm whether this vendor payment reached the provider${reason ? ` (${reason})` : ""}. Automatic recovery retries it with the same idempotency key, so it cannot double-pay. Do not build a replacement run until the provider record is checked.`,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
        metadata: typeof safePayload.payment_run_id === "string" ? { payment_run_id: safePayload.payment_run_id } : undefined,
      }
    }

    // Payment approvals: the recipient has to know what they are releasing (or
    // what was released on their behalf) from the email alone.
    case "payment_run_submitted":
    case "payment_run_approved":
    case "payment_run_approval_recorded":
    case "payment_run_rejected": {
      const vendor = typeof safePayload.vendor_name === "string" ? safePayload.vendor_name : "a vendor"
      const billNumber = typeof safePayload.bill_number === "string" ? safePayload.bill_number : null
      const project = typeof safePayload.project_name === "string" ? safePayload.project_name : null
      const amount = typeof safePayload.total_debit_cents === "number"
        ? formatCentsForNotification(safePayload.total_debit_cents)
        : null
      const billCount = typeof safePayload.bill_count === "number" ? safePayload.bill_count : 1
      const subject = billCount > 1
        ? `${billCount} vendor bills`
        : `${vendor}${billNumber ? ` · invoice ${billNumber}` : ""}${project ? ` · ${project}` : ""}`
      const title =
        event_type === "payment_run_submitted"
          ? `Payment needs your approval${amount ? `: ${amount}` : ""}`
          : event_type === "payment_run_approved"
            ? `Payment approved${amount ? `: ${amount}` : ""}`
            : event_type === "payment_run_rejected"
              ? "Payment rejected"
              : "Payment approval recorded"
      const message =
        event_type === "payment_run_submitted"
          ? `${subject}. Open it to review the bill and release the payment.`
          : event_type === "payment_run_approved"
            ? `${subject} is approved and on its way to the vendor.`
            : event_type === "payment_run_rejected"
              ? `${subject} was rejected${typeof safePayload.reason === "string" ? `: ${safePayload.reason}` : "."}`
              : `An approver recorded a decision on ${subject}.`
      return {
        orgId: event.org_id,
        userId,
        type: event_type as NotificationType,
        title,
        message,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
        metadata: typeof safePayload.bill_id === "string" ? { bill_id: safePayload.bill_id } : undefined,
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

    case "vendor_bill_submitted":
    case "vendor_bill_approved":
    case "vendor_bill_rejected": {
      const billLabel = typeof safePayload.bill_number === "string" && safePayload.bill_number
        ? `Invoice ${safePayload.bill_number}`
        : "A vendor invoice"
      const amount = typeof safePayload.amount_cents === "number"
        ? ` for ${formatCentsForNotification(safePayload.amount_cents)}`
        : ""
      const message = event_type === "vendor_bill_submitted"
        ? `${billLabel}${amount} is waiting for approval.`
        : event_type === "vendor_bill_approved"
          ? `${billLabel}${amount} was approved for payment.`
          // The reason is the whole point of the notification: without it the
          // recipient has to open the payable to learn anything.
          : `${billLabel}${amount} was rejected.${typeof safePayload.rejection_reason === "string" ? ` ${safePayload.rejection_reason}` : ""}`
      return {
        orgId: event.org_id,
        userId,
        type: event_type as NotificationType,
        title: fallbackTitle,
        message,
        projectId: projectId ?? undefined,
        entityType: entity_type,
        entityId: entity_id,
        eventId: event.id,
      }
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

/** Active members of the org holding at least one of `permissionKeys`. */
async function usersWithAnyPermission(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  permissionKeys: string[],
): Promise<string[]> {
  const { data: roleRows } = await supabase
    .from("role_permissions")
    .select("role_id")
    .in("permission_key", permissionKeys)
  const roleIds = [...new Set((roleRows ?? []).map((row) => row.role_id).filter(Boolean))]
  if (roleIds.length === 0) return []
  const { data: memberships } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .in("role_id", roleIds)
  return uniqUserIds((memberships ?? []).map((row) => row.user_id))
}

/**
 * A reversal that arrived from the accounting system carries the invoice but not
 * the project, so the project's finance readers would never hear that their
 * receivable reopened — and the notification would have no button, because the
 * href router needs a project to route a payment. The payment row knows; ask it.
 */
async function enrichReversalEvent(event: EventRecord, orgId: string) {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  if (typeof payload.project_id === "string") return
  if (event.entity_type !== "payment" || !event.entity_id) return

  const supabase = createServiceSupabaseClient()
  const { data } = await supabase
    .from("payments")
    .select("project_id")
    .eq("org_id", orgId)
    .eq("id", event.entity_id)
    .maybeSingle()
  if (typeof data?.project_id !== "string") return

  event.payload = { ...payload, project_id: data.project_id }
}

/**
 * Hydrate a vendor recipient event with the builder-facing facts.
 *
 * The event names a provider account shared across every builder that vendor
 * works with; what this org needs is their own company record, the teammate who
 * invited it, and a link that lands somewhere they recognise.
 */
async function enrichVendorRecipientEvent(event: EventRecord, orgId: string) {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  if (!event.entity_id) return

  const supabase = createServiceSupabaseClient()
  const { data: relationships } = await supabase
    .from("vendor_payment_relationships")
    .select("company_id, invited_by, status")
    .eq("org_id", orgId)
    .eq("recipient_account_id", event.entity_id)
    .limit(50)

  const rows = relationships ?? []
  if (rows.length === 0) return

  const companyId = typeof rows[0].company_id === "string" ? rows[0].company_id : null
  const { data: company } = companyId
    ? await supabase.from("companies").select("name").eq("org_id", orgId).eq("id", companyId).maybeSingle()
    : { data: null }

  event.payload = {
    ...payload,
    company_id: companyId,
    company_name: typeof company?.name === "string" ? company.name : null,
    relationship_status: typeof rows[0].status === "string" ? rows[0].status : null,
    inviter_ids: uniqUserIds(rows.map((row) => (typeof row.invited_by === "string" ? row.invited_by : null))),
  }
}

function formatCentsForNotification(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
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
    case "vendor_bill_submitted":
      return "Payable needs approval"
    case "vendor_bill_approved":
      return "Payable approved"
    case "vendor_bill_rejected":
      return "Payable rejected"
    case "vendor_payment_paid":
      return "Vendor payment completed"
    case "payable_email_ingest":
      return "Payable arrived by email"
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
    case "vpo.requested":
      return "VPO awaiting approval"
    case "vpo.approved":
      return "VPO approved"
    case "vpo.rejected":
      return "VPO rejected"
    case "po_completion.reported":
      return "PO completion reported"
    case "po_completion.verified":
      return "PO completion verified"
    case "po_completion.approved":
      return "PO completion approved"
    case "po_completion.rejected":
      return "PO completion rejected"
    case "vendor_payment_relationship_claimed":
      return "Vendor connected a payout account"
    case "payment_rail_policy_updated":
      return "Vendor payment policy changed"
    case "payment_run_approvers_updated":
      return "Payment approver roster changed"
    case "payment_hold_overridden":
      return "Payment hold overridden"
    case "payment_reversed":
      return "Customer payment reversed"
    case "payment_reversed_from_qbo":
      return "Customer payment reversed in QuickBooks"
    case "vendor_bill_payment_reversed":
      return "Vendor payment reversed"
    case "vendor_credit_applied":
      return "Vendor credit applied"
    case "vendor_payment_relationship_active":
      return "Vendor Arc Pay access restored"
    case "vendor_payment_relationship_onboarding":
      return "Vendor Arc Pay access moved back to setup"
    case "vendor_payment_relationship_suspended":
      return "Vendor Arc Pay access suspended"
    case "vendor_payment_relationship_revoked":
      return "Vendor Arc Pay access revoked"
    case "vendor_recipient_onboarding_started":
      return "Vendor started Arc Pay setup"
    case "vendor_recipient_status_updated":
      return "Vendor Arc Pay status changed"
    case "vendor_payment_returned":
      return "Vendor payment returned"
    case "payment_run_execution_failed":
      return "Payment run failed during release"
    case "payment_reconciliation_completed":
      return "Payment reconciliation complete"
    case "funding_source_review_requested":
      return "Funding bank needs approval"
    case "funding_source_change_approved":
      return "Funding bank change approved"
    case "funding_source_change_rejected":
      return "Funding bank change rejected"
    case "funding_source_activated":
      return "Funding bank activated"
    case "funding_source_activation_failed":
      return "Funding bank activation failed"
    default:
      return eventType.replace(/_/g, " ")
  }
}
