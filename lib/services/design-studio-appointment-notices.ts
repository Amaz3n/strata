import { z } from "zod"

import { DesignStudioAppointmentEmail } from "@/lib/emails/design-studio-appointment-email"
import { recordEvent } from "@/lib/services/events"
import { getOrgSenderEmail, renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { NotificationService } from "@/lib/services/notifications"
import { ensurePortalLink, fetchContactEmail } from "@/lib/services/portal-links"
import { formatWarrantyVisitWindow } from "@/lib/services/warranty/visit-time"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { NotificationType } from "@/lib/types/notifications"

/**
 * The buyer and the consultant hear about every booking, move and
 * cancellation of a design studio session. The database queues one
 * `send_design_studio_appointment_notice` job per change, keyed by the
 * session's revision, in the same transaction as the change -- so a move
 * cannot land without its notice, and a retried job sends it once. Times read
 * at the studio's wall clock; the buyer also sees each covered group's
 * deadline, which a session never moves.
 */

export const DESIGN_STUDIO_NOTICE_JOB_TYPE = "send_design_studio_appointment_notice"

const noticeJobSchema = z.object({
  appointment_id: z.string().uuid(),
  revision: z.number().int().positive(),
  kind: z.enum(["booked", "rescheduled", "canceled"]),
  previous: z.object({
    scheduled_at: z.string(),
    ends_at: z.string(),
    location_id: z.string().uuid().nullable(),
    coordinator_user_id: z.string().uuid().nullable(),
  }).nullable().optional(),
})

const CONSULTANT_COPY: Record<"booked" | "rescheduled" | "canceled", { type: NotificationType; title: string }> = {
  booked: { type: "design_studio_appointment_assigned", title: "Design studio session booked" },
  rescheduled: { type: "design_studio_appointment_rescheduled", title: "Design studio session moved" },
  canceled: { type: "design_studio_appointment_canceled", title: "Design studio session canceled" },
}

type Embedded<T> = T | T[] | null | undefined

function relation<T>(value: Embedded<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function formatCutoff(date: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`))
}

interface DesignStudioNoticeResult {
  skipped: "superseded" | null
  /** "sent", or why the buyer was not told: no contact on the home, or no email on the contact. */
  buyer: "sent" | "no_buyer" | "no_email" | null
  consultants_notified: number
}

export async function sendDesignStudioAppointmentNotice(orgId: string, rawPayload: unknown): Promise<DesignStudioNoticeResult> {
  const job = noticeJobSchema.parse(rawPayload)
  const supabase = createServiceSupabaseClient()
  const { data: appointment, error } = await supabase
    .from("design_studio_appointments")
    .select("id, project_id, contact_id, coordinator_user_id, scheduled_at, ends_at, status, revision, group_ids, cancel_reason, location:design_studio_locations(name, address, time_zone)")
    .eq("org_id", orgId)
    .eq("id", job.appointment_id)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the session: ${error.message}`)
  if (!appointment) throw new Error("Session not found")
  // A later move superseded this one; its own notice tells the buyer the time that stands.
  if (job.kind !== "canceled" && (appointment.revision !== job.revision || appointment.status !== "scheduled")) {
    return { skipped: "superseded", buyer: null, consultants_notified: 0 }
  }

  const location = relation<{ name: string; address: string | null; time_zone: string }>(appointment.location)
  if (!location) throw new Error("The session has no studio")
  const groupIds = (appointment.group_ids as string[] | null) ?? []
  const consultantIds = Array.from(new Set([appointment.coordinator_user_id, job.previous?.coordinator_user_id].filter((value): value is string => Boolean(value))))
  const [orgResult, projectResult, groupsResult, consultantsResult] = await Promise.all([
    supabase.from("orgs").select("name, slug, logo_url").eq("id", orgId).maybeSingle(),
    supabase.from("projects").select("name").eq("org_id", orgId).eq("id", appointment.project_id).maybeSingle(),
    groupIds.length
      ? supabase.from("project_selection_groups").select("cutoff_date, group:selection_groups(name)").eq("org_id", orgId).eq("project_id", appointment.project_id).in("group_id", groupIds)
      : Promise.resolve({ data: [], error: null }),
    consultantIds.length ? supabase.from("app_users").select("id, full_name").in("id", consultantIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (groupsResult.error) throw new Error(`Failed to load the covered groups: ${groupsResult.error.message}`)
  const org = orgResult.data
  const homeName = (projectResult.data?.name as string | undefined) ?? null
  const consultantName = (consultantsResult.data ?? []).find((row) => row.id === appointment.coordinator_user_id)?.full_name ?? null
  const windowText = formatWarrantyVisitWindow(appointment.scheduled_at, appointment.ends_at, location.time_zone)
  const previousWindowText = job.kind === "rescheduled" && job.previous ? formatWarrantyVisitWindow(job.previous.scheduled_at, job.previous.ends_at, location.time_zone) : null
  const deadlines = (groupsResult.data ?? []).map((row) => ({
    name: relation<{ name: string }>(row.group)?.name ?? "Selections",
    cutoffText: row.cutoff_date ? formatCutoff(row.cutoff_date as string) : null,
  }))

  const emailBuyer = async (): Promise<DesignStudioNoticeResult["buyer"]> => {
    if (!appointment.contact_id) return "no_buyer"
    const contact = await fetchContactEmail(supabase, appointment.contact_id)
    if (!contact?.email) return "no_email"
    const portal = await ensurePortalLink({
      supabase, orgId, projectId: appointment.project_id, portalType: "client", contactId: appointment.contact_id,
      createdBy: null, capabilities: { can_submit_selections: true }, fallbackPath: "/",
    })
    const html = await renderEmailTemplate(DesignStudioAppointmentEmail({
      orgName: org?.name ?? null, orgLogoUrl: org?.logo_url ?? null, recipientName: contact.full_name ?? null, kind: job.kind,
      homeName, studioName: location.name, studioAddress: location.address, consultantName, windowText, previousWindowText, deadlines,
      reason: job.kind === "canceled" ? (appointment.cancel_reason as string | null) : null,
      actionHref: `${portal}/selections`, actionLabel: "Review your selections",
    }))
    const subject = job.kind === "canceled" ? "Design studio appointment canceled" : job.kind === "rescheduled" ? "Design studio appointment moved" : "Your design studio appointment"
    const delivered = await sendEmail({
      to: [contact.email], subject, html, from: getOrgSenderEmail(org?.slug, org?.name),
      idempotencyKey: `design-studio-notice:${appointment.id}:${job.revision}:${job.kind}`,
    })
    // The outbox retries a job that throws; the idempotency key keeps a retry from telling the buyer twice.
    if (!delivered) throw new Error("The buyer's appointment notice could not be sent")
    return "sent"
  }

  const notifyConsultants = async (buyer: DesignStudioNoticeResult["buyer"]) => {
    const notifications = new NotificationService()
    const recipients: Array<{ userId: string; kind: keyof typeof CONSULTANT_COPY }> = []
    if (appointment.coordinator_user_id) recipients.push({ userId: appointment.coordinator_user_id, kind: job.kind })
    // A session handed to another consultant is, for the one who had it, canceled.
    const previousConsultant = job.previous?.coordinator_user_id
    if (previousConsultant && previousConsultant !== appointment.coordinator_user_id) recipients.push({ userId: previousConsultant, kind: "canceled" })
    const buyerGap = buyer === "no_buyer" ? " · the home has no buyer on file; tell them yourself" : buyer === "no_email" ? " · the buyer has no email on file; tell them yourself" : ""
    const sent = await Promise.allSettled(recipients.map(({ userId, kind }) => notifications.createAndQueue({
      orgId, userId, type: CONSULTANT_COPY[kind].type, title: CONSULTANT_COPY[kind].title,
      message: `${homeName ?? "A home"} · ${location.name} · ${kind === "canceled" && previousWindowText ? previousWindowText : windowText}${buyerGap}`,
      projectId: appointment.project_id, entityType: "design_studio_appointment", entityId: appointment.id,
      metadata: { href: `/design-studio/sheet/${appointment.project_id}` },
    })))
    return sent.filter((result) => result.status === "fulfilled").length
  }

  // The buyer first: a failed send throws before anyone else is told, so the retry repeats nothing.
  const buyer = await emailBuyer()
  const result: DesignStudioNoticeResult = { skipped: null, buyer, consultants_notified: await notifyConsultants(buyer) }
  await recordEvent({
    orgId, eventType: "design_studio_appointment_notice_sent", entityType: "design_studio_appointment", entityId: appointment.id,
    payload: { project_id: appointment.project_id, kind: job.kind, revision: job.revision, time_zone: location.time_zone, ...result },
  })
  return result
}
