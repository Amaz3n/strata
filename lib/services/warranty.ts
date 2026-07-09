import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import {
  escapeHtml,
  getOrgSenderEmail,
  renderStandardEmailLayout,
  sendEmail,
} from "@/lib/services/mailer"
import { fetchCompanyContacts, fetchContactEmail } from "@/lib/services/portal-links"
import {
  warrantyRequestInputSchema,
  warrantyRequestUpdateSchema,
  type WarrantyRequestInput,
  type WarrantyRequestUpdate,
} from "@/lib/validation/warranty"
import type { WarrantyRequest } from "@/lib/types"

const WARRANTY_SELECT =
  "id, org_id, project_id, title, description, status, priority, requested_by, assigned_company_id, scheduled_date, resolution_note, dispatched_at, created_at, updated_at, closed_at, requested_by_contact:contacts(full_name)"

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"

function mapWarranty(row: Record<string, unknown>): WarrantyRequest {
  const contact = Array.isArray(row.requested_by_contact) ? row.requested_by_contact[0] : row.requested_by_contact
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    project_id: row.project_id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    status: (row.status as string | null) ?? "open",
    priority: (row.priority as string | null) ?? "normal",
    requested_by: (row.requested_by as string | null) ?? null,
    requested_by_name: (contact as { full_name?: string | null } | null)?.full_name ?? null,
    assigned_company_id: (row.assigned_company_id as string | null) ?? null,
    scheduled_date: (row.scheduled_date as string | null) ?? null,
    resolution_note: (row.resolution_note as string | null) ?? null,
    dispatched_at: (row.dispatched_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string | null) ?? null,
    closed_at: (row.closed_at as string | null) ?? null,
  }
}

export async function listWarrantyRequests(projectId: string, orgId?: string): Promise<WarrantyRequest[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("warranty_requests")
    .select(WARRANTY_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load warranty requests: ${error.message}`)
  return (data ?? []).map(mapWarranty)
}

export async function createWarrantyRequest({
  input,
  orgId,
}: {
  input: WarrantyRequestInput
  orgId?: string
}): Promise<WarrantyRequest> {
  const parsed = warrantyRequestInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("warranty_requests")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      title: parsed.title,
      description: parsed.description ?? null,
      status: parsed.status ?? "open",
      priority: parsed.priority ?? "normal",
    })
    .select(WARRANTY_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create warranty request: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "warranty_request_created",
    entityType: "warranty_request",
    entityId: data.id as string,
    payload: { project_id: parsed.project_id, title: parsed.title },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "warranty_request",
    entityId: data.id as string,
    after: data,
  })

  return mapWarranty(data)
}

export async function updateWarrantyRequest({
  requestId,
  input,
  orgId,
}: {
  requestId: string
  input: WarrantyRequestUpdate
  orgId?: string
}): Promise<WarrantyRequest> {
  const parsed = warrantyRequestUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existingRow, error: existingError } = await supabase
    .from("warranty_requests")
    .select(WARRANTY_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", requestId)
    .maybeSingle()

  if (existingError || !existingRow) {
    throw new Error("Warranty request not found")
  }
  const existing = mapWarranty(existingRow)

  const now = new Date().toISOString()
  const updateData: Record<string, unknown> = { updated_at: now }
  if (parsed.title !== undefined) updateData.title = parsed.title
  if (parsed.description !== undefined) updateData.description = parsed.description
  if (parsed.priority !== undefined) updateData.priority = parsed.priority
  if (parsed.scheduled_date !== undefined) updateData.scheduled_date = parsed.scheduled_date
  if (parsed.resolution_note !== undefined) updateData.resolution_note = parsed.resolution_note
  if (parsed.assigned_company_id !== undefined) {
    updateData.assigned_company_id = parsed.assigned_company_id
    if (parsed.assigned_company_id && parsed.assigned_company_id !== existing.assigned_company_id) {
      updateData.dispatched_at = now
      if ((parsed.status ?? existing.status) === "open") {
        updateData.status = "in_progress"
      }
    }
  }
  if (parsed.status !== undefined) {
    updateData.status = parsed.status
    if (parsed.status === "closed" || parsed.status === "resolved") {
      updateData.closed_at = now
    } else if (existing.closed_at) {
      updateData.closed_at = null
    }
  }

  const { data, error } = await supabase
    .from("warranty_requests")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", requestId)
    .select(WARRANTY_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update warranty request: ${error?.message}`)
  }
  const updated = mapWarranty(data)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "warranty_request_updated",
    entityType: "warranty_request",
    entityId: requestId,
    payload: { project_id: updated.project_id, status: updated.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "warranty_request",
    entityId: requestId,
    before: existingRow,
    after: data,
  })

  const newlyAssigned =
    updated.assigned_company_id && updated.assigned_company_id !== existing.assigned_company_id
  const newlyResolved =
    (updated.status === "resolved" || updated.status === "closed") &&
    existing.status !== "resolved" &&
    existing.status !== "closed"

  await Promise.all([
    newlyAssigned ? sendWarrantyDispatchEmail({ orgId: resolvedOrgId, request: updated }) : Promise.resolve(),
    newlyResolved && updated.requested_by
      ? sendWarrantyResolvedEmail({ orgId: resolvedOrgId, request: updated })
      : Promise.resolve(),
  ])

  return updated
}

export async function createWarrantyRequestFromPortal({
  orgId,
  projectId,
  contactId,
  input,
}: {
  orgId: string
  projectId: string
  contactId?: string | null
  input: WarrantyRequestInput
}): Promise<WarrantyRequest> {
  const parsed = warrantyRequestInputSchema.parse(input)
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("warranty_requests")
    .insert({
      org_id: orgId,
      project_id: projectId,
      title: parsed.title,
      description: parsed.description ?? null,
      status: "open",
      priority: parsed.priority ?? "normal",
      requested_by: contactId ?? null,
    })
    .select(WARRANTY_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create warranty request: ${error?.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "warranty_request_created",
    entityType: "warranty_request",
    entityId: data.id as string,
    payload: { project_id: projectId, title: parsed.title, created_via_portal: true },
  })

  return mapWarranty(data)
}

export async function listWarrantyRequestsForPortal(orgId: string, projectId: string): Promise<WarrantyRequest[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("warranty_requests")
    .select(WARRANTY_SELECT)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load warranty requests: ${error.message}`)
  }

  return (data ?? []).map(mapWarranty)
}

async function loadWarrantyEmailContext(orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const [{ data: org }, { data: project }] = await Promise.all([
    supabase.from("orgs").select("name, slug, logo_url").eq("id", orgId).maybeSingle(),
    supabase.from("projects").select("name, location").eq("id", projectId).maybeSingle(),
  ])
  return { supabase, org, project }
}

async function sendWarrantyDispatchEmail({ orgId, request }: { orgId: string; request: WarrantyRequest }) {
  if (!request.assigned_company_id) return
  const { supabase, org, project } = await loadWarrantyEmailContext(orgId, request.project_id)

  const contacts = await fetchCompanyContacts(supabase, orgId, request.assigned_company_id)
  const recipients = contacts.map((contact) => contact.email).filter((email): email is string => Boolean(email))
  if (recipients.length === 0) {
    console.warn("Warranty dispatch: assigned company has no contacts with email", {
      requestId: request.id,
    })
    return
  }

  const scheduled = request.scheduled_date
    ? new Date(`${request.scheduled_date}T00:00:00`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null

  const location = (project?.location as { address?: string } | null)?.address

  const html = renderStandardEmailLayout({
    title: `Warranty service request: ${request.title}`,
    messageHtml: `
      <p>You have been assigned a warranty service request${project?.name ? ` on <strong>${escapeHtml(project.name)}</strong>` : ""}.</p>
      ${request.description ? `<p style="white-space:pre-wrap;">${escapeHtml(request.description)}</p>` : ""}
      <p>
        Priority: <strong>${escapeHtml(request.priority ?? "normal")}</strong>
        ${scheduled ? `<br/>Scheduled: <strong>${escapeHtml(scheduled)}</strong>` : ""}
        ${location ? `<br/>Address: ${escapeHtml(location)}` : ""}
      </p>
      <p>Please coordinate with the builder to complete this service visit.</p>
    `,
    orgName: org?.name ?? null,
    orgLogoUrl: org?.logo_url ?? null,
    showManageSettings: false,
  })

  await sendEmail({
    to: recipients,
    subject: `Warranty service request${project?.name ? ` — ${project.name}` : ""}: ${request.title}`,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })

  await recordEvent({
    orgId,
    eventType: "warranty_request_dispatched",
    entityType: "warranty_request",
    entityId: request.id,
    payload: { assigned_company_id: request.assigned_company_id, recipients: recipients.length },
  })
}

async function sendWarrantyResolvedEmail({ orgId, request }: { orgId: string; request: WarrantyRequest }) {
  if (!request.requested_by) return
  const { supabase, org, project } = await loadWarrantyEmailContext(orgId, request.project_id)

  const contact = await fetchContactEmail(supabase, request.requested_by)
  if (!contact?.email) return

  const html = renderStandardEmailLayout({
    title: `Warranty request resolved: ${request.title}`,
    messageHtml: `
      <p>${contact.full_name ? `Hi ${escapeHtml(contact.full_name)},` : "Hi,"}</p>
      <p>Your warranty request${project?.name ? ` on <strong>${escapeHtml(project.name)}</strong>` : ""} has been marked <strong>${escapeHtml(request.status)}</strong>.</p>
      ${request.resolution_note ? `<p style="white-space:pre-wrap;">${escapeHtml(request.resolution_note)}</p>` : ""}
      <p>If the issue is not fully resolved, reply to this email or submit a new request from your portal.</p>
    `,
    orgName: org?.name ?? null,
    orgLogoUrl: org?.logo_url ?? null,
    appUrl: APP_URL,
    showManageSettings: false,
  })

  await sendEmail({
    to: [contact.email],
    subject: `Warranty request resolved: ${request.title}`,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })
}
