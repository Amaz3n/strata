import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { sendEmail } from "@/lib/services/mailer"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { attachFile } from "@/lib/services/file-links"
import type { Rfi, RfiResponse } from "@/lib/types"
import type { RfiDecisionInput, RfiInput, RfiResponseInput } from "@/lib/validation/rfis"

const RFI_SELECT =
  "id, org_id, project_id, rfi_number, subject, question, status, priority, submitted_by, submitted_by_company_id, assigned_to, assigned_company_id, submitted_at, due_date, answered_at, closed_at, cost_impact_cents, schedule_impact_days, drawing_reference, spec_reference, location, attachment_file_id, last_response_at, decision_status, decision_note, decided_by_user_id, decided_by_contact_id, decided_at, decided_via_portal, decision_portal_token_id, created_at, updated_at"

export async function listRfis(orgId?: string, projectId?: string): Promise<Rfi[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  let query = supabase
    .from("rfis")
    .select(RFI_SELECT)
    .eq("org_id", resolvedOrgId)
    .order("rfi_number", { ascending: true })

  if (projectId) {
    query = query.eq("project_id", projectId)
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
      "id, org_id, rfi_id, response_type, body, responder_user_id, responder_contact_id, created_at, file_id, portal_token_id, created_via_portal, actor_ip",
    )
    .eq("org_id", orgId)
    .eq("rfi_id", rfiId)
    .order("created_at", { ascending: true })

  if (error) throw new Error(`Failed to load RFI responses: ${error.message}`)
  return (data ?? []) as RfiResponse[]
}

async function resolveNextRfiNumber(supabase: any, projectId: string) {
  const { data: nextFromRpc, error: rpcError } = await supabase.rpc("next_rfi_number", {
    p_project_id: projectId,
  })

  if (!rpcError && typeof nextFromRpc === "number" && nextFromRpc > 0) {
    return nextFromRpc
  }

  const { data: last } = await supabase
    .from("rfis")
    .select("rfi_number")
    .eq("project_id", projectId)
    .order("rfi_number", { ascending: false })
    .limit(1)
    .maybeSingle()

  return (last?.rfi_number ?? 0) + 1
}

export async function createRfi({ input, orgId }: { input: RfiInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const nextRfiNumber = input.rfi_number ?? (await resolveNextRfiNumber(supabase, input.project_id))
  const payload = {
    org_id: resolvedOrgId,
    project_id: input.project_id,
    rfi_number: nextRfiNumber,
    subject: input.subject,
    question: input.question,
    status: input.status ?? "open",
    priority: input.priority ?? "normal",
    submitted_by: userId,
    submitted_by_company_id: input.submitted_by_company_id ?? null,
    assigned_to: input.assigned_to ?? null,
    assigned_company_id: input.assigned_company_id ?? null,
    due_date: input.due_date ?? null,
    cost_impact_cents: input.cost_impact_cents ?? null,
    schedule_impact_days: input.schedule_impact_days ?? null,
    location: input.location ?? null,
    drawing_reference: input.drawing_reference ?? null,
    spec_reference: input.spec_reference ?? null,
    attachment_file_id: input.attachment_file_id ?? null,
  }

  const { data, error } = await supabase
    .from("rfis")
    .insert(payload)
    .select(RFI_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create RFI: ${error?.message}`)
  }

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
    after: payload,
  })

  if (payload.attachment_file_id) {
    try {
      await attachFile(
        {
          file_id: payload.attachment_file_id,
          project_id: payload.project_id,
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

  await sendRfiEmail({
    orgId: resolvedOrgId,
    rfiId: data.id,
    kind: "created",
  })

  return data as Rfi
}

export async function createPortalRfi({
  orgId,
  projectId,
  companyId,
  contactId,
  subject,
  question,
  priority,
  dueDate,
}: {
  orgId: string
  projectId: string
  companyId?: string | null
  contactId?: string | null
  subject: string
  question: string
  priority?: "low" | "normal" | "high" | "urgent"
  dueDate?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const rfiNumber = await resolveNextRfiNumber(supabase, projectId)

  const payload = {
    org_id: orgId,
    project_id: projectId,
    rfi_number: rfiNumber,
    subject,
    question,
    status: "open",
    priority: priority ?? "normal",
    due_date: dueDate ?? null,
    submitted_by_company_id: companyId ?? null,
    assigned_company_id: companyId ?? null,
    submitted_by: null,
    assigned_to: null,
  }

  const { data, error } = await supabase.from("rfis").insert(payload).select(RFI_SELECT).single()
  if (error || !data) throw new Error(`Failed to create RFI: ${error?.message}`)

  await recordEvent({
    orgId,
    eventType: "rfi_created",
    entityType: "rfi",
    entityId: data.id,
    payload: { rfi_number: data.rfi_number, project_id: data.project_id, via_portal: true, contact_id: contactId ?? null },
  })

  return data as Rfi
}

export async function addRfiResponse({ orgId, input }: { orgId?: string; input: RfiResponseInput }) {
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from("rfi_responses")
    .insert({
      org_id: resolvedOrgId,
      rfi_id: input.rfi_id,
      response_type: input.response_type ?? "comment",
      body: input.body,
      responder_user_id: input.responder_user_id ?? null,
      responder_contact_id: input.responder_contact_id ?? null,
      file_id: input.file_id ?? null,
      portal_token_id: input.portal_token_id ?? null,
      created_via_portal: input.created_via_portal ?? false,
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
    actorId: input.responder_user_id ?? input.responder_contact_id ?? undefined,
    action: "insert",
    entityType: "rfi_response",
    entityId: data?.id ?? input.rfi_id,
    after: input,
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
        createdBy: input.responder_user_id ?? null,
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
  })

  return { success: true }
}

export async function decideRfi({ orgId, input }: { orgId?: string; input: RfiDecisionInput }) {
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()
  const decidedAt = new Date().toISOString()
  const { error } = await supabase
    .from("rfis")
    .update({
      decision_status: input.decision_status,
      decision_note: input.decision_note ?? null,
      decided_by_user_id: input.decided_by_user_id ?? null,
      decided_by_contact_id: input.decided_by_contact_id ?? null,
      decision_portal_token_id: input.portal_token_id ?? null,
      decided_via_portal: !!input.portal_token_id,
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
    actorId: input.decided_by_user_id ?? input.decided_by_contact_id ?? undefined,
    action: "update",
    entityType: "rfi",
    entityId: input.rfi_id,
    after: input,
  })

  await sendRfiEmail({
    orgId: resolvedOrgId,
    rfiId: input.rfi_id,
    kind: "decision",
    decisionStatus: input.decision_status,
    decisionNote: input.decision_note ?? undefined,
  })

  return { success: true }
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"

async function sendRfiEmail({
  orgId,
  rfiId,
  kind,
  message,
  decisionStatus,
  decisionNote,
}: {
  orgId: string
  rfiId: string
  kind: "created" | "response" | "decision"
  message?: string
  decisionStatus?: string
  decisionNote?: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: rfi, error } = await supabase
    .from("rfis")
    .select(
      `
      id, org_id, project_id, rfi_number, subject, question, status, priority,
      assigned_to, submitted_by, project:projects(name, client_id)
    `,
    )
    .eq("id", rfiId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (error || !rfi) {
    console.warn("Unable to load RFI for email notification", error)
    return
  }

  const recipients: (string | null)[] = []

  const project = Array.isArray(rfi.project) ? rfi.project[0] : rfi.project

  if (rfi.assigned_to) {
    const userEmail = await fetchUserEmail(supabase, rfi.assigned_to)
    if (userEmail) recipients.push(userEmail.email)
  }

  if (project?.client_id) {
    const contactEmail = await fetchContactEmail(supabase, project.client_id)
    if (contactEmail) recipients.push(contactEmail.email)
  }

  if (rfi.submitted_by) {
    const submitterEmail = await fetchUserEmail(supabase, rfi.submitted_by)
    if (submitterEmail) recipients.push(submitterEmail.email)
  }

  if (recipients.length === 0) {
    console.warn("No recipients for RFI email; skipping", { rfiId })
    return
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

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
      <h2 style="margin-bottom: 4px;">${projectName}</h2>
      <p style="margin: 0 0 12px 0; color: #555;">RFI #${rfi.rfi_number}</p>
      <p style="margin: 0 0 12px 0;"><strong>${rfi.subject}</strong></p>
      ${
        kind === "response"
          ? `<p style="white-space:pre-wrap;">${message ?? "A new response was posted."}</p>`
          : kind === "decision"
            ? `<p style="margin: 0 0 8px 0;">Decision: <strong>${decisionStatus ?? "Updated"}</strong></p>${
                decisionNote ? `<p style="white-space:pre-wrap;">${decisionNote}</p>` : ""
              }`
            : `<p style="white-space:pre-wrap;">${rfi.question}</p>`
      }
      <div style="margin-top: 16px;">
        <a href="${APP_URL}/rfis" style="background: #111827; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none;">Open in Arc</a>
      </div>
    </div>
  `

  await sendEmail({
    to: recipients,
    subject,
    html,
  })
}

async function fetchUserEmail(supabase: any, userId: string): Promise<{ email: string | null; full_name?: string } | null> {
  const { data, error } = await supabase.from("app_users").select("email, full_name").eq("id", userId).maybeSingle()
  if (error) {
    console.warn("Failed to fetch user email", error)
    return null
  }
  return data
}

async function fetchContactEmail(
  supabase: any,
  contactId: string,
): Promise<{ email: string | null; full_name?: string } | null> {
  const { data, error } = await supabase.from("contacts").select("email, full_name").eq("id", contactId).maybeSingle()
  if (error) {
    console.warn("Failed to fetch contact email", error)
    return null
  }
  return data
}
