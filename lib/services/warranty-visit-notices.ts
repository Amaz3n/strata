import type { SupabaseClient } from "@supabase/supabase-js"

import { WarrantyVisitEmail } from "@/lib/emails/warranty-visit-email"
import { getOrgSenderEmail, renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { NotificationService } from "@/lib/services/notifications"
import { ensurePortalLink, fetchCompanyContacts, fetchContactEmail } from "@/lib/services/portal-links"
import { loadWarrantyHomeTimeZone } from "@/lib/services/warranty-time-zone"
import { formatWarrantyVisitWindow } from "@/lib/services/warranty/visit-time"
import type { NotificationType } from "@/lib/types/notifications"
import type { WarrantyRequest } from "@/lib/types"

export type WarrantyVisitNoticeKind = "scheduled" | "rescheduled" | "canceled"

export interface WarrantyVisitNoticeVisit {
  id: string
  project_id: string
  visit_number: number
  assignee_kind: "tech" | "trade"
  assigned_user_id: string | null
  assigned_company_id: string | null
  window_start: string
  window_end: string
}

/** Who was told, so the event that records the change can say so. */
export interface WarrantyVisitNoticeResult {
  time_zone: string
  buyer_emailed: boolean
  trade_recipients: number
  tech_notified: boolean
}

const STAFF_COPY: Record<WarrantyVisitNoticeKind, { type: NotificationType; title: string; verb: string }> = {
  scheduled: { type: "warranty_visit_assigned", title: "Warranty visit assigned", verb: "has been added to your service schedule for" },
  rescheduled: { type: "warranty_visit_rescheduled", title: "Warranty visit moved", verb: "has moved to" },
  canceled: { type: "warranty_visit_canceled", title: "Warranty visit canceled", verb: "was scheduled for" },
}

async function loadEmailContext(supabase: SupabaseClient, orgId: string, projectId: string) {
  const [{ data: org }, { data: project }] = await Promise.all([
    supabase.from("orgs").select("name,slug,logo_url").eq("id", orgId).maybeSingle(),
    supabase.from("projects").select("name,location").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
  ])
  return { org, project, address: (project?.location as { address?: string } | null)?.address ?? null }
}

/**
 * Everyone whose day a visit changes hears about it, in the house's own local
 * time: the homeowner (who can confirm or ask for another time from the buyer
 * portal), the trade's contacts, and the technician. A homeowner who is not
 * told a technician is no longer coming is a day-one customer-care failure.
 * One recipient failing does not stop the others.
 */
export async function sendWarrantyVisitNotices(input: {
  supabase: SupabaseClient
  orgId: string
  request: WarrantyRequest
  visit: WarrantyVisitNoticeVisit
  kind: WarrantyVisitNoticeKind
  previousWindow?: { window_start: string; window_end: string } | null
  note?: string | null
  actorId: string | null
}): Promise<WarrantyVisitNoticeResult> {
  const { supabase, orgId, request, visit, kind } = input
  const timeZone = await loadWarrantyHomeTimeZone(supabase, orgId, visit.project_id)
  const windowText = formatWarrantyVisitWindow(visit.window_start, visit.window_end, timeZone)
  const previousWindowText = input.previousWindow ? formatWarrantyVisitWindow(input.previousWindow.window_start, input.previousWindow.window_end, timeZone) : null
  const { org, project, address } = await loadEmailContext(supabase, orgId, visit.project_id)
  const from = getOrgSenderEmail(org?.slug, org?.name)
  const base = { orgName: org?.name ?? null, orgLogoUrl: org?.logo_url ?? null, kind, projectName: project?.name ?? null, address, requestTitle: request.title, windowText, previousWindowText, note: input.note ?? null }
  const subject = kind === "canceled" ? `Warranty appointment canceled — ${request.title}` : kind === "rescheduled" ? `Warranty appointment moved — ${request.title}` : `Warranty appointment — ${request.title}`

  const emailBuyer = async () => {
    if (!request.requested_by) return false
    const contact = await fetchContactEmail(supabase, request.requested_by)
    if (!contact?.email) return false
    const portal = await ensurePortalLink({ supabase, orgId, projectId: visit.project_id, portalType: "client", contactId: request.requested_by, createdBy: input.actorId, capabilities: { can_view_warranty: true }, fallbackPath: "/" })
    const html = await renderEmailTemplate(WarrantyVisitEmail({
      ...base, audience: "buyer", recipientName: contact.full_name ?? null,
      actionHref: kind === "canceled" ? `${portal}/warranty` : `${portal}/warranty/visits/${visit.id}`,
      actionLabel: kind === "canceled" ? "View your warranty" : "Confirm or change the time",
    }))
    return sendEmail({ to: [contact.email], subject, html, from })
  }

  const emailTrade = async () => {
    if (visit.assignee_kind !== "trade" || !visit.assigned_company_id) return 0
    const [contacts, portal] = await Promise.all([
      fetchCompanyContacts(supabase, orgId, visit.assigned_company_id),
      ensurePortalLink({ supabase, orgId, projectId: visit.project_id, portalType: "sub", companyId: visit.assigned_company_id, createdBy: input.actorId, capabilities: { can_view_punch_items: true }, fallbackPath: "/s" }),
    ])
    const recipients = contacts.map((contact) => contact.email).filter((email): email is string => Boolean(email))
    if (recipients.length === 0) return 0
    const html = await renderEmailTemplate(WarrantyVisitEmail({
      ...base, audience: "trade", recipientName: null,
      actionHref: kind === "canceled" ? null : `${portal}/warranty`, actionLabel: kind === "canceled" ? null : "Confirm appointment",
    }))
    return (await sendEmail({ to: recipients, subject, html, from })) ? recipients.length : 0
  }

  const notifyTech = async () => {
    if (!visit.assigned_user_id) return false
    const copy = STAFF_COPY[kind]
    await new NotificationService().createAndQueue({
      orgId, userId: visit.assigned_user_id, type: copy.type, title: copy.title,
      message: `${request.title} ${copy.verb} ${windowText}.`,
      projectId: visit.project_id, entityType: "warranty_service_visit", entityId: visit.id,
      metadata: { href: "/warranty?tab=dispatch" },
    })
    return true
  }

  const [buyer, trade, tech] = await Promise.allSettled([emailBuyer(), emailTrade(), notifyTech()])
  return {
    time_zone: timeZone,
    buyer_emailed: buyer.status === "fulfilled" && buyer.value,
    trade_recipients: trade.status === "fulfilled" ? trade.value : 0,
    tech_notified: tech.status === "fulfilled" && tech.value,
  }
}

/**
 * The homeowner answered an appointment. The technician who owns it and the
 * people who manage warranty hear about it; a request for another time is the
 * one that needs somebody to act, so it is the one that emails.
 */
export async function notifyWarrantyBuyerResponse(input: {
  orgId: string
  request: Pick<WarrantyRequest, "id" | "title" | "project_id">
  visit: Pick<WarrantyVisitNoticeVisit, "id" | "assigned_user_id">
  response: "confirmed" | "reschedule_requested"
  note?: string | null
  recipientUserIds: string[]
}) {
  const recipients = [...new Set([...(input.visit.assigned_user_id ? [input.visit.assigned_user_id] : []), ...input.recipientUserIds])]
  const notifications = new NotificationService()
  const confirmed = input.response === "confirmed"
  const results = await Promise.allSettled(recipients.map((userId) => notifications.createAndQueue({
    orgId: input.orgId, userId,
    type: confirmed ? "warranty_visit_buyer_confirmed" : "warranty_buyer_reschedule_requested",
    title: confirmed ? "Homeowner confirmed appointment" : "Homeowner asked for another time",
    message: confirmed ? `${input.request.title}: the homeowner confirmed the appointment.` : `${input.request.title}: ${input.note ?? "the homeowner asked for another time."}`,
    projectId: input.request.project_id, entityType: "warranty_service_visit", entityId: input.visit.id,
    metadata: { href: "/warranty?tab=dispatch" },
  })))
  return results.filter((result) => result.status === "fulfilled").length
}
