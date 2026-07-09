import type { SupabaseClient } from "@supabase/supabase-js"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { renderEmailTemplate, sendEmail, getOrgSenderEmail } from "@/lib/services/mailer"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { attachFile } from "@/lib/services/file-links"
import { requirePermission } from "@/lib/services/permissions"
import { createChangeOrder } from "@/lib/services/change-orders"
import { changeOrderInputSchema } from "@/lib/validation/change-orders"
import {
  ensurePortalLink,
  fetchCompanyContacts,
  fetchContactEmail,
  fetchUserEmail,
} from "@/lib/services/portal-links"
import type { ChangeOrder, Rfi, RfiResponse } from "@/lib/types"
import type { RfiDecisionInput, RfiInput, RfiResponseInput } from "@/lib/validation/rfis"
import { RfiNotificationEmail } from "@/lib/emails/rfi-notification-email"

const RFI_SELECT =
  "id, org_id, project_id, rfi_number, subject, question, status, priority, submitted_by, submitted_by_company_id, assigned_to, assigned_company_id, notify_contact_id, submitted_at, sent_to_emails, due_date, answered_at, closed_at, cost_impact_cents, schedule_impact_days, drawing_reference, spec_reference, location, attachment_file_id, last_response_at, decision_status, decision_note, decided_by_user_id, decided_by_contact_id, decided_at, decided_via_portal, decision_portal_token_id, created_at, updated_at"

const RFI_NUMBER_CONFLICT_CONSTRAINT = "rfis_project_id_rfi_number_key"

const ORG_LIST_CAP = 500

export async function listRfis(orgId?: string, projectId?: string): Promise<Rfi[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.read", { supabase, orgId: resolvedOrgId, userId })
  let query = supabase.from("rfis").select(RFI_SELECT).eq("org_id", resolvedOrgId)

  if (projectId) {
    query = query.eq("project_id", projectId).order("rfi_number", { ascending: true })
  } else {
    // Org desk: newest first, capped — the desk ranks recent activity, the
    // project workbench is the complete log.
    query = query.order("created_at", { ascending: false }).limit(ORG_LIST_CAP)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to load RFIs: ${error.message}`)
  return data ?? []
}

export async function listRfisForPortal({
  orgId,
  projectId,
  companyId,
  scopedRfiId,
}: {
  orgId: string
  projectId: string
  companyId?: string | null
  scopedRfiId?: string | null
}): Promise<Rfi[]> {
  const supabase = createServiceSupabaseClient()
  let query = supabase
    .from("rfis")
    .select(RFI_SELECT)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "draft")
    .order("rfi_number", { ascending: true })

  if (companyId) {
    query = query.or(`assigned_company_id.is.null,assigned_company_id.eq.${companyId}`)
  }

  if (scopedRfiId) {
    query = query.eq("id", scopedRfiId)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to load RFIs: ${error.message}`)
  return data ?? []
}

export async function listRfiResponses({
  orgId,
  rfiId,
}: {
  orgId: string
  rfiId: string
}): Promise<RfiResponse[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("rfi_responses")
    .select(
      `
      id, org_id, rfi_id, response_type, body, responder_user_id, responder_contact_id, created_at, file_id, portal_token_id, created_via_portal, actor_ip,
      responder_user:app_users(full_name, email),
      responder_contact:contacts(full_name, email)
      `,
    )
    .eq("org_id", orgId)
    .eq("rfi_id", rfiId)
    .order("created_at", { ascending: true })

  if (error) throw new Error(`Failed to load RFI responses: ${error.message}`)
  return (data ?? []).map((row: any) => {
    const responderUser = Array.isArray(row.responder_user) ? row.responder_user[0] : row.responder_user
    const responderContact = Array.isArray(row.responder_contact) ? row.responder_contact[0] : row.responder_contact
    return {
      id: row.id,
      org_id: row.org_id,
      rfi_id: row.rfi_id,
      response_type: row.response_type,
      body: row.body,
      responder_user_id: row.responder_user_id ?? null,
      responder_contact_id: row.responder_contact_id ?? null,
      responder_name: responderUser?.full_name ?? responderContact?.full_name ?? null,
      responder_email: responderUser?.email ?? responderContact?.email ?? null,
      created_at: row.created_at,
      file_id: row.file_id ?? null,
      portal_token_id: row.portal_token_id ?? null,
      created_via_portal: row.created_via_portal ?? false,
      actor_ip: row.actor_ip ?? null,
    } satisfies RfiResponse
  })
}

async function insertRfiWithNumberRetry({
  supabase,
  projectId,
  payload,
  explicitRfiNumber,
}: {
  supabase: SupabaseClient
  projectId: string
  payload: Record<string, unknown>
  explicitRfiNumber?: number
}) {
  return insertWithProjectNumberRetry<Rfi>({
    supabase,
    table: "rfis",
    numberColumn: "rfi_number",
    rpcName: "next_rfi_number",
    conflictConstraint: RFI_NUMBER_CONFLICT_CONSTRAINT,
    projectId,
    payload,
    select: RFI_SELECT,
    explicitNumber: explicitRfiNumber,
    entityLabel: "RFI",
  })
}

export async function createRfi({
  input,
  orgId,
  sendNow = true,
}: {
  input: RfiInput
  orgId?: string
  sendNow?: boolean
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.write", { supabase, orgId: resolvedOrgId, userId })
  const shouldSendNow = sendNow !== false
  const normalizedStatus = shouldSendNow
    ? ((input.status ?? "open") === "draft" ? "open" : (input.status ?? "open"))
    : "draft"
  const submittedAt = shouldSendNow ? new Date().toISOString() : null
  const payload = {
    org_id: resolvedOrgId,
    project_id: input.project_id,
    subject: input.subject,
    question: input.question,
    status: normalizedStatus,
    priority: input.priority ?? "normal",
    submitted_by: userId,
    submitted_by_company_id: input.submitted_by_company_id ?? null,
    assigned_to: input.assigned_to ?? null,
    assigned_company_id: input.assigned_company_id ?? null,
    notify_contact_id: input.notify_contact_id ?? null,
    submitted_at: submittedAt,
    due_date: input.due_date ?? null,
    cost_impact_cents: input.cost_impact_cents ?? null,
    schedule_impact_days: input.schedule_impact_days ?? null,
    location: input.location ?? null,
    drawing_reference: input.drawing_reference ?? null,
    spec_reference: input.spec_reference ?? null,
    attachment_file_id: input.attachment_file_id ?? null,
  }

  const { data, insertPayload } = await insertRfiWithNumberRetry({
    supabase,
    projectId: input.project_id,
    payload,
    explicitRfiNumber: input.rfi_number,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "rfi_created",
    entityType: "rfi",
    entityId: data.id,
    payload: { rfi_number: data.rfi_number, project_id: data.project_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "rfi",
    entityId: data.id,
    after: insertPayload,
  })

  if (input.attachment_file_id) {
    try {
      await attachFile(
        {
          file_id: input.attachment_file_id,
          project_id: input.project_id,
          entity_type: "rfi",
          entity_id: data.id,
          link_role: "legacy_attachment",
        },
        resolvedOrgId,
      )
    } catch (error) {
      console.warn("Failed to attach legacy RFI attachment to file_links", error)
    }
  }

  if (shouldSendNow) {
    const sentToEmails = await sendRfiEmail({
      orgId: resolvedOrgId,
      rfiId: data.id,
      kind: "created",
      notifyContactId: input.notify_contact_id ?? null,
    })
    await supabase
      .from("rfis")
      .update({ sent_to_emails: sentToEmails.length > 0 ? sentToEmails : null })
      .eq("id", data.id)
      .eq("org_id", resolvedOrgId)
  }

  return data as Rfi
}

export async function sendRfi({
  rfiId,
  orgId,
}: {
  rfiId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.write", { supabase, orgId: resolvedOrgId, userId })
  const now = new Date().toISOString()
  const { data: existing, error } = await supabase
    .from("rfis")
    .select("id, status, submitted_at, notify_contact_id")
    .eq("id", rfiId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (error || !existing) {
    throw new Error(`Failed to load RFI for send: ${error?.message ?? "Not found"}`)
  }

  const sentToEmails = await sendRfiEmail({
    orgId: resolvedOrgId,
    rfiId,
    kind: "created",
    notifyContactId: existing.notify_contact_id ?? null,
  })

  const updatePayload: Record<string, any> = {
    status: existing.status === "draft" ? "open" : existing.status,
    sent_to_emails: sentToEmails.length > 0 ? sentToEmails : null,
  }
  if (!existing.submitted_at) {
    updatePayload.submitted_at = now
  }

  const { data: updated, error: updateError } = await supabase
    .from("rfis")
    .update(updatePayload)
    .eq("id", rfiId)
    .eq("org_id", resolvedOrgId)
    .select(RFI_SELECT)
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to mark RFI as sent: ${updateError?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "rfi_sent",
    entityType: "rfi",
    entityId: rfiId,
    payload: { sent_to_count: sentToEmails.length },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "rfi",
    entityId: rfiId,
    after: updatePayload,
  })

  return updated as Rfi
}

export async function createPortalRfi({
  orgId,
  projectId,
  bidPackageId,
  companyId,
  contactId,
  subject,
  question,
  priority,
  dueDate,
}: {
  orgId: string
  projectId: string
  bidPackageId?: string | null
  companyId?: string | null
  contactId?: string | null
  subject: string
  question: string
  priority?: "low" | "normal" | "high" | "urgent"
  dueDate?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  const payload = {
    org_id: orgId,
    project_id: projectId,
    bid_package_id: bidPackageId ?? null,
    subject,
    question,
    status: "open",
    priority: priority ?? "normal",
    due_date: dueDate ?? null,
    submitted_by_company_id: companyId ?? null,
    assigned_company_id: companyId ?? null,
    submitted_by: null,
    assigned_to: null,
    submitted_at: new Date().toISOString(),
  }

  const { data } = await insertRfiWithNumberRetry({
    supabase,
    projectId,
    payload,
  })

  await recordEvent({
    orgId,
    actorId: contactId ?? null,
    eventType: "rfi_created",
    entityType: "rfi",
    entityId: data.id,
    payload: { rfi_number: data.rfi_number, project_id: data.project_id, via_portal: true, contact_id: contactId ?? null },
  })

  return data as Rfi
}

export async function addRfiResponse({ orgId, input }: { orgId?: string; input: RfiResponseInput }) {
  const { supabase: scopedSupabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.respond", { supabase: scopedSupabase, orgId: resolvedOrgId, userId })
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()
  const { data: rfi, error: rfiError } = await supabase
    .from("rfis")
    .select("id, notify_contact_id")
    .eq("id", input.rfi_id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (rfiError || !rfi) {
    throw new Error(`Failed to load RFI: ${rfiError?.message ?? "Not found"}`)
  }

  const { data, error } = await supabase
    .from("rfi_responses")
    .insert({
      org_id: resolvedOrgId,
      rfi_id: input.rfi_id,
      response_type: input.response_type ?? "comment",
      body: input.body,
      responder_user_id: userId,
      responder_contact_id: null,
      file_id: input.file_id ?? null,
      portal_token_id: null,
      created_via_portal: false,
      actor_ip: input.actor_ip ?? null,
    })
    .select("id")
    .single()

  if (error) throw new Error(`Failed to post RFI response: ${error.message}`)

  const updatePayload: Record<string, any> = { last_response_at: now }
  if (input.response_type === "answer") {
    updatePayload.answered_at = now
    updatePayload.status = "answered"
  }

  await supabase.from("rfis").update(updatePayload).eq("id", input.rfi_id).eq("org_id", resolvedOrgId)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "rfi_response_added",
    entityType: "rfi",
    entityId: input.rfi_id,
    payload: { response_type: input.response_type, response_id: data?.id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "rfi_response",
    entityId: data?.id ?? input.rfi_id,
    after: {
      ...input,
      responder_user_id: userId,
      responder_contact_id: null,
      portal_token_id: null,
      created_via_portal: false,
    },
  })

  if (input.file_id) {
    try {
      await attachFileWithServiceRole({
        orgId: resolvedOrgId,
        fileId: input.file_id,
        projectId: undefined,
        entityType: "rfi",
        entityId: input.rfi_id,
        linkRole: "response",
        createdBy: userId,
      })
    } catch (error) {
      console.warn("Failed to attach RFI response file to file_links", error)
    }
  }

  await sendRfiEmail({
    orgId: resolvedOrgId,
    rfiId: input.rfi_id,
    kind: "response",
    message: input.body,
    notifyContactId: rfi.notify_contact_id ?? null,
  })

  return { success: true }
}

export async function addPortalRfiResponse({
  orgId,
  responderContactId,
  portalTokenId,
  input,
}: {
  orgId: string
  responderContactId?: string | null
  portalTokenId?: string | null
  input: RfiResponseInput
}) {
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()
  const { data: rfi, error: rfiError } = await supabase
    .from("rfis")
    .select("id, status, notify_contact_id")
    .eq("id", input.rfi_id)
    .eq("org_id", orgId)
    .maybeSingle()

  if (rfiError || !rfi) {
    throw new Error(`Failed to load RFI: ${rfiError?.message ?? "Not found"}`)
  }
  if (rfi.status === "draft") {
    throw new Error("RFI has not been sent yet")
  }

  const { data, error } = await supabase
    .from("rfi_responses")
    .insert({
      org_id: orgId,
      rfi_id: input.rfi_id,
      response_type: input.response_type ?? "comment",
      body: input.body,
      responder_user_id: null,
      responder_contact_id: responderContactId ?? null,
      file_id: input.file_id ?? null,
      portal_token_id: portalTokenId ?? null,
      created_via_portal: true,
      actor_ip: input.actor_ip ?? null,
    })
    .select("id")
    .single()

  if (error) throw new Error(`Failed to post RFI response: ${error.message}`)

  const updatePayload: Record<string, any> = { last_response_at: now }
  if (input.response_type === "answer") {
    updatePayload.answered_at = now
    updatePayload.status = "answered"
  }

  await supabase.from("rfis").update(updatePayload).eq("id", input.rfi_id).eq("org_id", orgId)

  await recordEvent({
    orgId,
    actorId: responderContactId ?? null,
    eventType: "rfi_response_added",
    entityType: "rfi",
    entityId: input.rfi_id,
    payload: { response_type: input.response_type, response_id: data?.id, via_portal: true, portal_token_id: portalTokenId ?? null },
  })

  await recordAudit({
    orgId,
    action: "insert",
    entityType: "rfi_response",
    entityId: data?.id ?? input.rfi_id,
    after: {
      ...input,
      responder_user_id: null,
      responder_contact_id: responderContactId ?? null,
      portal_token_id: portalTokenId ?? null,
      created_via_portal: true,
    },
    source: "portal",
  })

  if (input.file_id) {
    try {
      await attachFileWithServiceRole({
        orgId,
        fileId: input.file_id,
        projectId: undefined,
        entityType: "rfi",
        entityId: input.rfi_id,
        linkRole: "response",
        createdBy: null,
      })
    } catch (error) {
      console.warn("Failed to attach RFI response file to file_links", error)
    }
  }

  await sendRfiEmail({
    orgId,
    rfiId: input.rfi_id,
    kind: "response",
    message: input.body,
    notifyContactId: rfi.notify_contact_id ?? null,
  })

  return { success: true }
}

export async function decideRfi({ orgId, input }: { orgId?: string; input: RfiDecisionInput }) {
  const { supabase: scopedSupabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.close", { supabase: scopedSupabase, orgId: resolvedOrgId, userId })
  const supabase = createServiceSupabaseClient()
  const decidedAt = new Date().toISOString()
  const { data: existing, error: existingError } = await supabase
    .from("rfis")
    .select("id, notify_contact_id")
    .eq("id", input.rfi_id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error(`Failed to load RFI decision context: ${existingError?.message ?? "Not found"}`)
  }

  const { error } = await supabase
    .from("rfis")
    .update({
      decision_status: input.decision_status,
      decision_note: input.decision_note ?? null,
      decided_by_user_id: userId,
      decided_by_contact_id: null,
      decision_portal_token_id: null,
      decided_via_portal: false,
      decided_at: decidedAt,
      answered_at: decidedAt,
      status: input.decision_status === "approved" ? "answered" : "open",
    })
    .eq("id", input.rfi_id)
    .eq("org_id", resolvedOrgId)

  if (error) throw new Error(`Failed to record RFI decision: ${error.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "rfi_decided",
    entityType: "rfi",
    entityId: input.rfi_id,
    payload: { decision_status: input.decision_status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "rfi",
    entityId: input.rfi_id,
    after: {
      ...input,
      decided_by_user_id: userId,
      decided_by_contact_id: null,
      portal_token_id: null,
    },
  })

  await sendRfiEmail({
    orgId: resolvedOrgId,
    rfiId: input.rfi_id,
    kind: "decision",
    decisionStatus: input.decision_status,
    decisionNote: input.decision_note ?? undefined,
    notifyContactId: existing.notify_contact_id ?? null,
  })

  return { success: true }
}

export async function closeRfi({ rfiId, orgId }: { rfiId: string; orgId?: string }): Promise<Rfi> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.close", { supabase, orgId: resolvedOrgId, userId })
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from("rfis")
    .update({ status: "closed", closed_at: now })
    .eq("id", rfiId)
    .eq("org_id", resolvedOrgId)
    .neq("status", "closed")
    .select(RFI_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to close RFI: ${error?.message ?? "Not found or already closed"}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "rfi_closed",
    entityType: "rfi",
    entityId: rfiId,
    payload: { rfi_number: data.rfi_number, project_id: data.project_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "rfi",
    entityId: rfiId,
    after: { status: "closed", closed_at: now },
  })

  return data as Rfi
}

export async function reopenRfi({ rfiId, orgId }: { rfiId: string; orgId?: string }): Promise<Rfi> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.close", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("rfis")
    .select("id, status, answered_at")
    .eq("id", rfiId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error(`Failed to load RFI: ${existingError?.message ?? "Not found"}`)
  }
  if (existing.status !== "closed") {
    throw new Error("Only closed RFIs can be reopened")
  }

  const nextStatus = existing.answered_at ? "answered" : "open"
  const { data, error } = await supabase
    .from("rfis")
    .update({ status: nextStatus, closed_at: null })
    .eq("id", rfiId)
    .eq("org_id", resolvedOrgId)
    .select(RFI_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to reopen RFI: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "rfi_reopened",
    entityType: "rfi",
    entityId: rfiId,
    payload: { rfi_number: data.rfi_number, project_id: data.project_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "rfi",
    entityId: rfiId,
    after: { status: nextStatus, closed_at: null },
  })

  return data as Rfi
}

export interface RfiLinkedChangeOrder {
  id: string
  co_number: number | string | null
  title: string
  status: string
  total_cents: number | null
}

export async function getRfiLinkedChangeOrder({
  rfiId,
  orgId,
}: {
  rfiId: string
  orgId?: string
}): Promise<RfiLinkedChangeOrder | null> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.read", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("change_orders")
    .select("id, co_number, title, status, total_cents")
    .eq("org_id", resolvedOrgId)
    .eq("metadata->>source_rfi_id", rfiId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load linked change order: ${error.message}`)
  }
  return (data as RfiLinkedChangeOrder | null) ?? null
}

/**
 * Turns an RFI's cost/schedule impact into a draft change order and links the
 * two via change_orders.metadata.source_rfi_id. change_order.write is enforced
 * by createChangeOrder.
 */
export async function convertRfiToChangeOrder({
  rfiId,
  orgId,
}: {
  rfiId: string
  orgId?: string
}): Promise<ChangeOrder> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.read", { supabase, orgId: resolvedOrgId, userId })

  const { data: rfi, error: rfiError } = await supabase
    .from("rfis")
    .select("id, project_id, rfi_number, subject, question, decision_note, cost_impact_cents, schedule_impact_days")
    .eq("id", rfiId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (rfiError || !rfi) {
    throw new Error(`Failed to load RFI: ${rfiError?.message ?? "Not found"}`)
  }

  const { data: alreadyLinked } = await supabase
    .from("change_orders")
    .select("id, co_number")
    .eq("org_id", resolvedOrgId)
    .eq("metadata->>source_rfi_id", rfiId)
    .limit(1)
    .maybeSingle()

  if (alreadyLinked) {
    throw new Error(
      `RFI #${rfi.rfi_number} is already linked to change order${alreadyLinked.co_number ? ` #${alreadyLinked.co_number}` : ""}`,
    )
  }

  const input = changeOrderInputSchema.parse({
    project_id: rfi.project_id,
    title: `RFI #${rfi.rfi_number}: ${rfi.subject}`,
    summary: `Cost/schedule impact from RFI #${rfi.rfi_number} — ${rfi.subject}`,
    description: rfi.decision_note ?? rfi.question ?? undefined,
    days_impact: rfi.schedule_impact_days ?? null,
    status: "draft",
    client_visible: false,
    requires_signature: true,
    lines: [
      {
        description: `RFI #${rfi.rfi_number}: ${rfi.subject}`,
        quantity: 1,
        unit: "ls",
        unit_cost: (rfi.cost_impact_cents ?? 0) / 100,
      },
    ],
  })

  const changeOrder = await createChangeOrder({ input, orgId: resolvedOrgId })

  const { data: coRow } = await supabase
    .from("change_orders")
    .select("metadata")
    .eq("id", changeOrder.id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  const mergedMetadata = {
    ...((coRow?.metadata as Record<string, unknown> | null) ?? {}),
    source_rfi_id: rfi.id,
    source_rfi_number: rfi.rfi_number,
  }

  await supabase
    .from("change_orders")
    .update({ metadata: mergedMetadata })
    .eq("id", changeOrder.id)
    .eq("org_id", resolvedOrgId)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "rfi_converted_to_change_order",
    entityType: "rfi",
    entityId: rfi.id,
    payload: { rfi_number: rfi.rfi_number, change_order_id: changeOrder.id, project_id: rfi.project_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "rfi",
    entityId: rfi.id,
    after: { converted_to_change_order_id: changeOrder.id },
  })

  return changeOrder
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"

async function sendRfiEmail({
  orgId,
  rfiId,
  kind,
  message,
  decisionStatus,
  decisionNote,
  notifyContactId,
}: {
  orgId: string
  rfiId: string
  kind: "created" | "response" | "decision"
  message?: string
  decisionStatus?: string
  decisionNote?: string
  notifyContactId?: string | null
}): Promise<string[]> {
  const supabase = createServiceSupabaseClient()
  const { data: rfi, error } = await supabase
    .from("rfis")
    .select(
      `
      id, org_id, project_id, rfi_number, subject, question, status, priority, due_date, notify_contact_id,
      assigned_to, assigned_company_id, submitted_by, project:projects(name, client_id)
    `,
    )
    .eq("id", rfiId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (error || !rfi) {
    console.warn("Unable to load RFI for email notification", error)
    return []
  }

  const { data: org } = await supabase
    .from("orgs")
    .select("name, logo_url, slug")
    .eq("id", orgId)
    .maybeSingle()

  const recipients: Array<{
    email: string
    name?: string | null
    portalLink?: string | null
    audience: "internal" | "client" | "sub"
  }> = []

  const project = Array.isArray(rfi.project) ? rfi.project[0] : rfi.project
  const effectiveNotifyContactId = notifyContactId ?? rfi.notify_contact_id ?? null
  const rfiPortalCaps = { can_view_rfis: true, can_respond_rfis: true } as const
  const fallbackPath = `/rfis?project=${rfi.project_id}`

  await Promise.all([
    (async () => {
      if (!rfi.assigned_to) return
      const userEmail = await fetchUserEmail(supabase, rfi.assigned_to)
      if (userEmail?.email) {
        recipients.push({ email: userEmail.email, name: userEmail.full_name, audience: "internal", portalLink: null })
      }
    })(),
    (async () => {
      if (!project?.client_id) return
      const contactEmail = await fetchContactEmail(supabase, project.client_id)
      if (!contactEmail?.email) return
      const link = await ensurePortalLink({
        supabase,
        orgId,
        projectId: rfi.project_id,
        portalType: "client",
        contactId: project.client_id,
        companyId: null,
        createdBy: rfi.submitted_by ?? null,
        scopedRfiId: rfi.id,
        capabilities: rfiPortalCaps,
        fallbackPath,
      })
      recipients.push({ email: contactEmail.email, name: contactEmail.full_name, audience: "client", portalLink: link })
    })(),
    (async () => {
      if (!effectiveNotifyContactId) return
      const notifyContact = await fetchContact(supabase, effectiveNotifyContactId)
      if (!notifyContact?.email) return
      const portalType = resolveNotifyContactPortalType(notifyContact)
      const link = await ensurePortalLink({
        supabase,
        orgId,
        projectId: rfi.project_id,
        portalType,
        contactId: notifyContact.id,
        companyId: notifyContact.primary_company_id ?? null,
        createdBy: rfi.submitted_by ?? null,
        scopedRfiId: rfi.id,
        capabilities: rfiPortalCaps,
        fallbackPath,
      })
      recipients.push({
        email: notifyContact.email,
        name: notifyContact.full_name,
        audience: portalType === "sub" ? "sub" : "client",
        portalLink: link,
      })
    })(),
    (async () => {
      if (!rfi.assigned_company_id) return
      const companyContacts = await fetchCompanyContacts(supabase, orgId, rfi.assigned_company_id)
      if (companyContacts.length === 0) return
      const link = await ensurePortalLink({
        supabase,
        orgId,
        projectId: rfi.project_id,
        portalType: "sub",
        contactId: null,
        companyId: rfi.assigned_company_id,
        createdBy: rfi.submitted_by ?? null,
        scopedRfiId: rfi.id,
        capabilities: rfiPortalCaps,
        fallbackPath,
      })
      for (const contact of companyContacts) {
        if (contact.email) {
          recipients.push({ email: contact.email, name: contact.full_name, audience: "sub", portalLink: link })
        }
      }
    })(),
    (async () => {
      if (!rfi.submitted_by) return
      const submitterEmail = await fetchUserEmail(supabase, rfi.submitted_by)
      if (submitterEmail?.email) {
        recipients.push({ email: submitterEmail.email, name: submitterEmail.full_name, audience: "internal", portalLink: null })
      }
    })(),
  ])

  if (recipients.length === 0) {
    console.warn("No recipients for RFI email; skipping", { rfiId })
    return []
  }

  const projectName = project?.name ?? "Project"
  const subject = (() => {
    switch (kind) {
      case "created":
        return `New RFI #${rfi.rfi_number}: ${rfi.subject}`
      case "response":
        return `Response on RFI #${rfi.rfi_number}`
      case "decision":
        return `Decision on RFI #${rfi.rfi_number}: ${decisionStatus}`
      default:
        return `Update on RFI #${rfi.rfi_number}`
    }
  })()

  const deduped = new Map<string, { audience: "internal" | "client" | "sub"; name?: string | null; portalLink?: string | null }>()
  const recipientPriority = (recipient: { audience: "internal" | "client" | "sub"; portalLink?: string | null }) => {
    if (recipient.audience === "sub") return recipient.portalLink ? 4 : 3
    if (recipient.audience === "client") return recipient.portalLink ? 2 : 1
    return 0
  }

  for (const recipient of recipients) {
    const next = { audience: recipient.audience, name: recipient.name ?? null, portalLink: recipient.portalLink }
    const existing = deduped.get(recipient.email)
    if (
      !existing ||
      recipientPriority(next) > recipientPriority(existing) ||
      (recipientPriority(next) === recipientPriority(existing) && !existing.name && !!next.name)
    ) {
      deduped.set(recipient.email, next)
    }
  }

  const dueDate =
    rfi.due_date != null
      ? new Date(rfi.due_date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : null

  const sendResults = await Promise.all(
    Array.from(deduped.entries()).map(async ([to, meta]) => {
      const actionHref =
        meta.audience === "internal" || !meta.portalLink ? `${APP_URL}/rfis?highlight=${rfi.id}` : meta.portalLink
      const actionLabel = meta.audience === "internal" ? "Open in Arc" : "Respond in Portal"

      const html = await renderEmailTemplate(
        RfiNotificationEmail({
          orgName: org?.name ?? null,
          orgLogoUrl: org?.logo_url ?? null,
          recipientName: meta.name ?? null,
          audience: meta.audience,
          projectName,
          rfiNumber: rfi.rfi_number,
          subject: rfi.subject,
          question: rfi.question,
          kind,
          message,
          decisionStatus: decisionStatus ?? null,
          decisionNote: decisionNote ?? null,
          priority: rfi.priority ?? null,
          dueDate,
          actionHref,
          actionLabel,
        }),
      )

      const sent = await sendEmail({
        to: [to],
        subject,
        html,
        from: getOrgSenderEmail(org?.slug, org?.name),
      })
      return sent ? to : null
    }),
  )

  return sendResults.filter((to): to is string => to !== null)
}

async function fetchContact(
  supabase: SupabaseClient,
  contactId: string,
): Promise<{
  id: string
  email: string | null
  full_name?: string | null
  primary_company_id: string | null
  contact_type?: string | null
  company?: { company_type?: string | null } | null
} | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, email, full_name, primary_company_id, contact_type, company:companies(company_type)")
    .eq("id", contactId)
    .maybeSingle()
  if (error) {
    console.warn("Failed to fetch contact", error)
    return null
  }
  if (!data) return null
  const company = Array.isArray(data.company) ? data.company[0] ?? null : data.company
  return { ...data, company }
}

function resolveNotifyContactPortalType(contact: {
  primary_company_id: string | null
  contact_type?: string | null
  company?: { company_type?: string | null } | null
}): "client" | "sub" {
  const contactType = (contact.contact_type ?? "").toLowerCase()
  const companyType = (contact.company?.company_type ?? "").toLowerCase()
  const isSubCompany = companyType === "subcontractor" || companyType === "vendor"
  const isSubContactType = contactType === "subcontractor" || contactType === "vendor"
  if (contact.primary_company_id && (isSubCompany || isSubContactType)) {
    return "sub"
  }
  return "client"
}
