import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { resolveProjectLocation } from "@/lib/services/locations"
import {
  escapeHtml,
  getOrgSenderEmail,
  renderStandardEmailLayout,
  sendEmail,
} from "@/lib/services/mailer"
import { ensurePortalLink, fetchCompanyContacts } from "@/lib/services/portal-links"
import type { PunchItem } from "@/lib/types"
import {
  punchItemBulkAssignSchema,
  punchItemCreateSchema,
  punchItemUpdateSchema,
  type PunchItemCreateInput,
  type PunchItemUpdateInput,
} from "@/lib/validation/punch-items"
import type { SupabaseClient } from "@supabase/supabase-js"

const PORTAL_PUNCH_SELECT =
  "id, org_id, project_id, title, description, status, due_date, severity, location, location_id, resolved_at, assigned_company_id, dispatched_at, sub_completed_at, verification_notes, created_at"

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
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, location_id, resolved_at")
    .single()

  if (error || !data) throw new Error(`Failed to create punch item: ${error?.message}`)
  return data
}

export async function listPunchItems(orgId: string, projectId: string): Promise<PunchItem[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("punch_items")
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, location_id, resolved_at, assigned_company_id, dispatched_at, sub_completed_at, assigned_company:companies(name)")
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

export interface ProjectPunchItem {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string | null
  status: string
  due_date?: string | null
  severity?: string | null
  location?: string | null
  location_id?: string | null
  assigned_to?: string | null
  assigned_company_id?: string | null
  assigned_company_name?: string | null
  dispatched_at?: string | null
  sub_completed_at?: string | null
  back_charge_flag?: boolean | null
  resolved_at?: string | null
  schedule_item_id?: string | null
  created_from_inspection?: boolean | null
  verification_required?: boolean | null
  verified_at?: string | null
  verified_by?: string | null
  verification_notes?: string | null
  created_at: string
  updated_at: string
}

type ProjectPunchItemRow = Omit<ProjectPunchItem, "assigned_company_name"> & {
  assigned_company?: { name: string | null } | { name: string | null }[] | null
}

const PROJECT_PUNCH_ITEM_SELECT =
  "id, org_id, project_id, title, description, status, due_date, severity, location, location_id, assigned_to, assigned_company_id, dispatched_at, sub_completed_at, back_charge_flag, resolved_at, schedule_item_id, created_from_inspection, verification_required, verified_at, verified_by, verification_notes, created_at, updated_at, assigned_company:companies(id, name)"

function mapProjectPunchItem(row: ProjectPunchItemRow): ProjectPunchItem {
  const { assigned_company, ...rest } = row
  const company = Array.isArray(assigned_company) ? assigned_company[0] : assigned_company
  return { ...rest, assigned_company_name: company?.name ?? null }
}

/** The caller may change punch on THIS project — assignment and division scope included. */
async function authorizePunchWrite(context: { supabase: SupabaseClient; orgId: string; userId: string }, projectId: string) {
  await requireAuthorization({
    permission: "punch.write",
    userId: context.userId,
    orgId: context.orgId,
    projectId,
    supabase: context.supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })
}

/** An assignee is a member of this org and a company in its directory, never a guessed id. */
async function assertPunchAssignees(
  supabase: SupabaseClient,
  orgId: string,
  { assignedTo, companyId }: { assignedTo?: string | null; companyId?: string | null },
) {
  const [member, company] = await Promise.all([
    assignedTo
      ? supabase.from("memberships").select("user_id").eq("org_id", orgId).eq("user_id", assignedTo).eq("status", "active").maybeSingle()
      : null,
    companyId ? supabase.from("companies").select("id").eq("org_id", orgId).eq("id", companyId).maybeSingle() : null,
  ])
  if (member && (member.error || !member.data)) throw new Error("Assignee is not a member of this organization")
  if (company && (company.error || !company.data)) throw new Error("Assigned company not found")
}

/**
 * A verification-required item closes only on evidence: an "after" photo or
 * file attached to it (the sub's completion photo counts). The person closing
 * it is the verifier, so verified_at/by are stamped from that act — never from
 * a status change alone.
 */
async function hasVerificationEvidence(supabase: SupabaseClient, orgId: string, punchItemId: string) {
  const { count, error } = await supabase
    .from("file_links")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("entity_type", "punch_item")
    .eq("entity_id", punchItemId)
    .eq("link_role", "after")
  if (error) throw new Error(`Unable to verify punch evidence: ${error.message}`)
  return (count ?? 0) > 0
}

export async function listProjectPunchItems(projectId: string, orgId?: string): Promise<ProjectPunchItem[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("punch_items")
    .select(PROJECT_PUNCH_ITEM_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to load punch items: ${error.message}`)
  return (data ?? []).map(mapProjectPunchItem)
}

export async function createProjectPunchItem(projectId: string, input: PunchItemCreateInput, orgId?: string): Promise<ProjectPunchItem> {
  const parsed = punchItemCreateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await authorizePunchWrite(context, projectId)
  const [location] = await Promise.all([
    resolveProjectLocation(projectId, parsed.location_id, resolvedOrgId),
    assertPunchAssignees(supabase, resolvedOrgId, { assignedTo: parsed.assigned_to, companyId: parsed.assigned_company_id }),
  ])

  const { data, error } = await supabase
    .from("punch_items")
    .insert({
      org_id: resolvedOrgId,
      project_id: projectId,
      title: parsed.title,
      description: parsed.description ?? null,
      status: "open",
      due_date: parsed.due_date ?? null,
      severity: parsed.severity ?? null,
      location_id: location?.id ?? null,
      location: location?.full_path ?? parsed.location ?? null,
      assigned_to: parsed.assigned_to ?? null,
      assigned_company_id: parsed.assigned_company_id ?? null,
      dispatched_at: parsed.assigned_company_id ? new Date().toISOString() : null,
      verification_required: parsed.verification_required ?? false,
      created_by: userId,
    })
    .select(PROJECT_PUNCH_ITEM_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to create punch item: ${error?.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "punch_item_created",
    entityType: "punch_item",
    entityId: data.id,
    payload: { project_id: projectId, title: data.title },
  })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "punch_item", entityId: data.id, after: data })

  const item = mapProjectPunchItem(data)
  if (item.assigned_company_id) {
    await sendPunchDispatchEmail({ supabase, orgId: resolvedOrgId, projectId, companyId: item.assigned_company_id, items: [item], createdBy: userId })
  }
  return item
}

export async function updateProjectPunchItem(
  projectId: string,
  punchItemId: string,
  input: PunchItemUpdateInput,
  orgId?: string,
): Promise<ProjectPunchItem> {
  const parsed = punchItemUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await authorizePunchWrite(context, projectId)

  const { data: existing, error: fetchError } = await supabase
    .from("punch_items")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("id", punchItemId)
    .maybeSingle()
  if (fetchError || !existing) throw new Error("Punch item not found")
  await assertPunchAssignees(supabase, resolvedOrgId, { assignedTo: parsed.assigned_to, companyId: parsed.assigned_company_id })

  const now = new Date().toISOString()
  const updateData: Record<string, string | boolean | null> = {}
  if (parsed.title !== undefined) updateData.title = parsed.title
  if (parsed.description !== undefined) updateData.description = parsed.description
  if (parsed.due_date !== undefined) updateData.due_date = parsed.due_date
  if (parsed.severity !== undefined) updateData.severity = parsed.severity
  if (parsed.location_id !== undefined) {
    const location = await resolveProjectLocation(projectId, parsed.location_id, resolvedOrgId)
    updateData.location_id = location?.id ?? null
    updateData.location = location?.full_path ?? null
  } else if (parsed.location !== undefined) updateData.location = parsed.location
  if (parsed.assigned_to !== undefined) updateData.assigned_to = parsed.assigned_to
  if (parsed.back_charge_flag !== undefined) updateData.back_charge_flag = parsed.back_charge_flag
  if (parsed.verification_required !== undefined) updateData.verification_required = parsed.verification_required
  if (parsed.verification_notes !== undefined) updateData.verification_notes = parsed.verification_notes

  const newlyAssignedCompany =
    parsed.assigned_company_id !== undefined &&
    parsed.assigned_company_id !== null &&
    parsed.assigned_company_id !== existing.assigned_company_id
  if (parsed.assigned_company_id !== undefined) {
    updateData.assigned_company_id = parsed.assigned_company_id
    if (newlyAssignedCompany) {
      updateData.dispatched_at = now
      updateData.sub_completed_at = null
    } else if (parsed.assigned_company_id === null) {
      updateData.dispatched_at = null
      updateData.sub_completed_at = null
    }
  }

  // GC bounced a sub-completed item back to open/in_progress: the ball
  // returns to the sub, so clear their completion stamp and re-notify.
  const rejectedSubWork =
    (parsed.status === "open" || parsed.status === "in_progress") &&
    existing.status === "ready_for_review" &&
    Boolean(existing.sub_completed_at) &&
    Boolean(existing.assigned_company_id) &&
    !newlyAssignedCompany

  if (parsed.status !== undefined) {
    updateData.status = parsed.status
    if (rejectedSubWork) updateData.sub_completed_at = null
    if (parsed.status === "closed" && existing.status !== "closed") {
      updateData.resolved_at = now
      updateData.resolved_by = userId
      // Dropping the requirement in the same save that closes the item would
      // close it unverified; the requirement in force is the stored one too.
      const requireVerification = Boolean(existing.verification_required || parsed.verification_required)
      if (requireVerification && !existing.verified_at) {
        if (!(await hasVerificationEvidence(supabase, resolvedOrgId, punchItemId))) {
          throw new Error("Add verification evidence before closing this item.")
        }
        updateData.verified_at = now
        updateData.verified_by = userId
      }
    } else if (parsed.status !== "closed" && existing.status === "closed") {
      updateData.resolved_at = null
      updateData.resolved_by = null
      updateData.verified_at = null
      updateData.verified_by = null
    }
  }

  const { data, error } = await supabase
    .from("punch_items")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("id", punchItemId)
    .select(PROJECT_PUNCH_ITEM_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to update punch item: ${error?.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "punch_item_updated",
    entityType: "punch_item",
    entityId: data.id,
    payload: { project_id: projectId, status: data.status },
  })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "punch_item", entityId: data.id, before: existing, after: data })

  const item = mapProjectPunchItem(data)
  if (newlyAssignedCompany && item.assigned_company_id) {
    await sendPunchDispatchEmail({ supabase, orgId: resolvedOrgId, projectId, companyId: item.assigned_company_id, items: [item], createdBy: userId })
  } else if (rejectedSubWork && item.assigned_company_id) {
    await sendPunchDispatchEmail({
      supabase,
      orgId: resolvedOrgId,
      projectId,
      companyId: item.assigned_company_id,
      items: [item],
      rejectionNote: parsed.verification_notes ?? item.verification_notes ?? "",
      createdBy: userId,
    })
  }
  return item
}

export async function bulkAssignPunchCompany(
  projectId: string,
  punchItemIds: string[],
  companyId: string,
  orgId?: string,
): Promise<ProjectPunchItem[]> {
  const parsed = punchItemBulkAssignSchema.parse({ punch_item_ids: punchItemIds, company_id: companyId })
  if (parsed.punch_item_ids.length === 0) return []
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await authorizePunchWrite(context, projectId)
  await assertPunchAssignees(supabase, resolvedOrgId, { companyId: parsed.company_id })

  const { data, error } = await supabase
    .from("punch_items")
    .update({ assigned_company_id: parsed.company_id, dispatched_at: new Date().toISOString(), sub_completed_at: null })
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .in("id", parsed.punch_item_ids)
    .neq("status", "closed")
    .select(PROJECT_PUNCH_ITEM_SELECT)
  if (error) throw new Error(`Failed to assign punch items: ${error.message}`)

  const items = (data ?? []).map(mapProjectPunchItem)
  if (items.length > 0) {
    await recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "punch_item_updated",
      entityType: "punch_item",
      entityId: items[0].id,
      payload: { project_id: projectId, assigned_company_id: parsed.company_id, item_ids: items.map((item) => item.id) },
    })
    await recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "update",
      entityType: "punch_item",
      entityId: items[0].id,
      after: { bulk_assigned_company_id: parsed.company_id, item_ids: items.map((item) => item.id) },
    })
    await sendPunchDispatchEmail({ supabase, orgId: resolvedOrgId, projectId, companyId: parsed.company_id, items, createdBy: userId })
  }
  return items
}
