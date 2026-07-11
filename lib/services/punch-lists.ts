import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordEvent } from "@/lib/services/events"
import {
  escapeHtml,
  getOrgSenderEmail,
  renderStandardEmailLayout,
  sendEmail,
} from "@/lib/services/mailer"
import { ensurePortalLink, fetchCompanyContacts } from "@/lib/services/portal-links"
import type { PunchItem } from "@/lib/types"
import type { SupabaseClient } from "@supabase/supabase-js"

const PORTAL_PUNCH_SELECT =
  "id, org_id, project_id, title, description, status, due_date, severity, location, resolved_at, assigned_company_id, dispatched_at, sub_completed_at, verification_notes, created_at"

export async function createPunchItemFromPortal({
  orgId,
  projectId,
  title,
  description,
  location,
  severity,
  portalTokenId,
}: {
  orgId: string
  projectId: string
  title: string
  description?: string
  location?: string
  severity?: string
  portalTokenId: string
}): Promise<PunchItem> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("punch_items")
    .insert({
      org_id: orgId,
      project_id: projectId,
      title,
      description: description ?? null,
      location: location ?? null,
      severity: severity ?? null,
      status: "open",
      created_via_portal: true,
      portal_token_id: portalTokenId,
    })
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, resolved_at")
    .single()

  if (error || !data) throw new Error(`Failed to create punch item: ${error?.message}`)
  return data
}

export async function listPunchItems(orgId: string, projectId: string): Promise<PunchItem[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("punch_items")
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, resolved_at, assigned_company_id, dispatched_at, sub_completed_at, assigned_company:companies(name)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load punch items: ${error.message}`)
  return (data ?? []).map((row) => {
    const { assigned_company, ...rest } = row as Record<string, any>
    const company = Array.isArray(assigned_company) ? assigned_company[0] : assigned_company
    return { ...rest, assigned_company_name: company?.name ?? null } as PunchItem
  })
}

/**
 * Punch items assigned to a subcontractor company, for the sub portal queue.
 * Closed items drop off after verification so the queue stays actionable.
 */
export async function listPunchItemsForCompanyPortal({
  orgId,
  projectId,
  companyId,
}: {
  orgId: string
  projectId: string
  companyId: string
}): Promise<PunchItem[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("punch_items")
    .select(PORTAL_PUNCH_SELECT)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("assigned_company_id", companyId)
    .neq("status", "closed")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load punch items: ${error.message}`)
  return data ?? []
}

/**
 * Sub marks a dispatched punch item's work complete from the portal: stamps
 * sub_completed_at and hands ball-in-court back to the GC for verification.
 */
export async function completePunchItemFromPortal({
  orgId,
  projectId,
  companyId,
  punchItemId,
  photoFileId,
  portalTokenId,
}: {
  orgId: string
  projectId: string
  companyId: string
  punchItemId: string
  photoFileId?: string | null
  portalTokenId: string
}): Promise<PunchItem> {
  const supabase = createServiceSupabaseClient()

  const { data: existing } = await supabase
    .from("punch_items")
    .select("id, status, assigned_company_id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", punchItemId)
    .maybeSingle()

  if (!existing || existing.assigned_company_id !== companyId) {
    throw new Error("Punch item not found")
  }
  if (existing.status === "closed") {
    throw new Error("This punch item is already closed")
  }

  const { data, error } = await supabase
    .from("punch_items")
    .update({ status: "ready_for_review", sub_completed_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", punchItemId)
    .select(PORTAL_PUNCH_SELECT)
    .single()

  if (error || !data) throw new Error(`Failed to update punch item: ${error?.message}`)

  if (photoFileId) {
    const { error: linkError } = await supabase.from("file_links").insert({
      org_id: orgId,
      project_id: projectId,
      file_id: photoFileId,
      entity_type: "punch_item",
      entity_id: punchItemId,
      link_role: "after",
    })
    if (linkError) console.warn("Failed to link punch completion photo", linkError.message)
  }

  await recordEvent({
    orgId,
    eventType: "punch_item_sub_completed",
    entityType: "punch_item",
    entityId: punchItemId,
    payload: { project_id: projectId, company_id: companyId, portal_token_id: portalTokenId },
  })

  return data
}

interface PunchDispatchItem {
  id: string
  title: string
  description?: string | null
  location?: string | null
  severity?: string | null
  due_date?: string | null
}

/**
 * Emails the assigned company's contacts their punch work with a sub-portal
 * link scoped to the punch queue. Mirrors the warranty dispatch pattern.
 * Pass rejectionNote when a completed item was bounced back by the GC.
 */
export async function sendPunchDispatchEmail({
  supabase,
  orgId,
  projectId,
  companyId,
  items,
  rejectionNote,
  createdBy,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  companyId: string
  items: PunchDispatchItem[]
  rejectionNote?: string | null
  createdBy?: string | null
}): Promise<void> {
  if (items.length === 0) return
  const serviceSupabase = createServiceSupabaseClient()

  const [{ data: org }, { data: project }, contacts] = await Promise.all([
    serviceSupabase.from("orgs").select("name, slug, logo_url").eq("id", orgId).maybeSingle(),
    serviceSupabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    fetchCompanyContacts(serviceSupabase, orgId, companyId),
  ])

  const recipients = contacts.map((contact) => contact.email).filter((email): email is string => Boolean(email))
  if (recipients.length === 0) {
    console.warn("Punch dispatch: assigned company has no contacts with email", { companyId, projectId })
    return
  }

  const portalUrl = await ensurePortalLink({
    supabase,
    orgId,
    projectId,
    portalType: "sub",
    companyId,
    createdBy: createdBy ?? null,
    capabilities: { can_view_punch_items: true },
    fallbackPath: `/projects/${projectId}/punch`,
  })

  const formatDue = (value?: string | null) =>
    value
      ? new Date(`${value}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : null

  const itemsHtml = items
    .map((item) => {
      const meta = [item.location, item.severity, formatDue(item.due_date) ? `Due ${formatDue(item.due_date)}` : null]
        .filter(Boolean)
        .map((part) => escapeHtml(String(part)))
        .join(" · ")
      return `<li style="margin-bottom:8px;"><strong>${escapeHtml(item.title)}</strong>${
        item.description ? `<br/><span style="white-space:pre-wrap;">${escapeHtml(item.description)}</span>` : ""
      }${meta ? `<br/><span style="color:#6b7280;font-size:13px;">${meta}</span>` : ""}</li>`
    })
    .join("")

  const isRejection = Boolean(rejectionNote != null)
  const intro = isRejection
    ? `<p>Completed punch work${project?.name ? ` on <strong>${escapeHtml(project.name)}</strong>` : ""} was reviewed and needs rework before it can be accepted.</p>${
        rejectionNote ? `<p style="white-space:pre-wrap;"><strong>Reviewer note:</strong> ${escapeHtml(rejectionNote)}</p>` : ""
      }`
    : `<p>You have been assigned ${items.length === 1 ? "a punch item" : `${items.length} punch items`}${
        project?.name ? ` on <strong>${escapeHtml(project.name)}</strong>` : ""
      }.</p>`

  const html = renderStandardEmailLayout({
    title: isRejection ? "Punch work needs rework" : "Punch work assigned",
    messageHtml: `
      ${intro}
      <ul style="padding-left:18px;">${itemsHtml}</ul>
      <p>Open your portal to review details and mark work complete:</p>
      <p><a href="${portalUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;">Open punch list</a></p>
    `,
    orgName: org?.name ?? null,
    orgLogoUrl: org?.logo_url ?? null,
    showManageSettings: false,
  })

  const subjectPrefix = isRejection ? "Punch rework needed" : "Punch work assigned"
  await sendEmail({
    to: recipients,
    subject: `${subjectPrefix}${project?.name ? ` — ${project.name}` : ""}${
      items.length === 1 ? `: ${items[0].title}` : ` (${items.length} items)`
    }`,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })

  await recordEvent({
    orgId,
    eventType: isRejection ? "punch_item_rework_requested" : "punch_item_dispatched",
    entityType: "punch_item",
    entityId: items[0].id,
    payload: {
      project_id: projectId,
      company_id: companyId,
      item_ids: items.map((item) => item.id),
      recipients: recipients.length,
    },
  })
}
