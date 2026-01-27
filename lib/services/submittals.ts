import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { sendEmail } from "@/lib/services/mailer"
import { attachFile, attachFileWithServiceRole } from "@/lib/services/file-links"
import type { Submittal } from "@/lib/types"
import type { SubmittalDecisionInput, SubmittalInput, SubmittalItemInput } from "@/lib/validation/submittals"

export async function listSubmittals(orgId?: string, projectId?: string): Promise<Submittal[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  let query = supabase
    .from("submittals")
    .select(
      "id, org_id, project_id, submittal_number, title, description, status, spec_section, submittal_type, due_date, reviewed_at, attachment_file_id, last_item_submitted_at, decision_status, decision_note, decision_by_user_id, decision_by_contact_id, decision_at, decision_via_portal, decision_portal_token_id",
    )
    .eq("org_id", resolvedOrgId)
    .order("submittal_number", { ascending: true })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to load submittals: ${error.message}`)
  return data ?? []
}

export async function createSubmittal({ input, orgId }: { input: SubmittalInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const payload = {
    org_id: resolvedOrgId,
    project_id: input.project_id,
    submittal_number: input.submittal_number,
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? "submitted",
    spec_section: input.spec_section ?? null,
    submittal_type: input.submittal_type ?? null,
    due_date: input.due_date ?? null,
    attachment_file_id: input.attachment_file_id ?? null,
  }

  const { data, error } = await supabase
    .from("submittals")
    .insert(payload)
    .select(
      "id, org_id, project_id, submittal_number, title, description, status, spec_section, submittal_type, due_date, reviewed_at, attachment_file_id, last_item_submitted_at, decision_status, decision_note, decision_by_user_id, decision_by_contact_id, decision_at, decision_via_portal, decision_portal_token_id",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create submittal: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "submittal_created",
    entityType: "submittal",
    entityId: data.id,
    payload: { submittal_number: data.submittal_number, project_id: data.project_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "submittal",
    entityId: data.id,
    after: payload,
  })

  if (payload.attachment_file_id) {
    try {
      await attachFile(
        {
          file_id: payload.attachment_file_id,
          project_id: payload.project_id,
          entity_type: "submittal",
          entity_id: data.id,
          link_role: "legacy_attachment",
        },
        resolvedOrgId,
      )
    } catch (error) {
      console.warn("Failed to attach legacy submittal attachment to file_links", error)
    }
  }

  await sendSubmittalEmail({
    orgId: resolvedOrgId,
    submittalId: data.id,
    kind: "created",
  })

  return data as Submittal
}

export async function addSubmittalItem({ orgId, input }: { orgId: string; input: SubmittalItemInput }) {
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()
  const { data: last } = await supabase
    .from("submittal_items")
    .select("item_number")
    .eq("org_id", orgId)
    .eq("submittal_id", input.submittal_id)
    .order("item_number", { ascending: false })
    .limit(1)
    .maybeSingle()

  const nextNumber = (last?.item_number ?? 0) + 1
  const { error } = await supabase.from("submittal_items").insert({
    org_id: orgId,
    submittal_id: input.submittal_id,
    item_number: nextNumber,
    description: input.description,
    manufacturer: input.manufacturer ?? null,
    model_number: input.model_number ?? null,
    file_id: input.file_id ?? null,
    portal_token_id: input.portal_token_id ?? null,
    created_via_portal: input.created_via_portal ?? false,
    responder_user_id: input.responder_user_id ?? null,
    responder_contact_id: input.responder_contact_id ?? null,
  })

  if (error) throw new Error(`Failed to add submittal item: ${error.message}`)

  await supabase
    .from("submittals")
    .update({ last_item_submitted_at: now })
    .eq("id", input.submittal_id)
    .eq("org_id", orgId)

  await recordEvent({
    orgId,
    eventType: "submittal_item_added",
    entityType: "submittal",
    entityId: input.submittal_id,
    payload: { item_number: nextNumber },
  })

  await recordAudit({
    orgId,
    actorId: input.responder_user_id ?? input.responder_contact_id ?? undefined,
    action: "insert",
    entityType: "submittal_item",
    entityId: input.submittal_id,
    after: { ...input, item_number: nextNumber },
  })

  if (input.file_id) {
    try {
      await attachFileWithServiceRole({
        orgId,
        fileId: input.file_id,
        projectId: undefined,
        entityType: "submittal",
        entityId: input.submittal_id,
        linkRole: "item",
        createdBy: input.responder_user_id ?? null,
      })
    } catch (error) {
      console.warn("Failed to attach submittal item file to file_links", error)
    }
  }

  return { success: true }
}

export async function addSubmittalComment({
  orgId,
  submittalId,
  note,
}: {
  orgId: string
  submittalId: string
  note: string
}) {
  return addSubmittalItem({
    orgId,
    input: {
      submittal_id: submittalId,
      description: note,
    },
  })
}

export async function decideSubmittal({ orgId, input }: { orgId: string; input: SubmittalDecisionInput }) {
  const supabase = createServiceSupabaseClient()
  const decisionAt = new Date().toISOString()

  const { error } = await supabase
    .from("submittals")
    .update({
      decision_status: input.decision_status,
      decision_note: input.decision_note ?? null,
      decision_by_user_id: input.decision_by_user_id ?? null,
      decision_by_contact_id: input.decision_by_contact_id ?? null,
      decision_portal_token_id: input.portal_token_id ?? null,
      decision_via_portal: !!input.portal_token_id,
      decision_at: decisionAt,
      reviewed_at: decisionAt,
      status: input.decision_status,
    })
    .eq("id", input.submittal_id)
    .eq("org_id", orgId)

  if (error) throw new Error(`Failed to record submittal decision: ${error.message}`)

  await recordEvent({
    orgId,
    eventType: "submittal_decided",
    entityType: "submittal",
    entityId: input.submittal_id,
    payload: { decision_status: input.decision_status },
  })

  await recordAudit({
    orgId,
    actorId: input.decision_by_user_id ?? input.decision_by_contact_id ?? undefined,
    action: "update",
    entityType: "submittal",
    entityId: input.submittal_id,
    after: input,
  })

  await sendSubmittalEmail({
    orgId,
    submittalId: input.submittal_id,
    kind: "decision",
    decisionStatus: input.decision_status,
    decisionNote: input.decision_note ?? undefined,
  })

  return { success: true }
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"

async function sendSubmittalEmail({
  orgId,
  submittalId,
  kind,
  decisionStatus,
  decisionNote,
}: {
  orgId: string
  submittalId: string
  kind: "created" | "decision"
  decisionStatus?: string
  decisionNote?: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: submittal, error } = await supabase
    .from("submittals")
    .select(
      `
      id, org_id, project_id, submittal_number, title, description, status,
      submitted_by_contact_id, reviewed_by, project:projects(name, client_id)
    `,
    )
    .eq("id", submittalId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (error || !submittal) {
    console.warn("Unable to load submittal for email notification", error)
    return
  }

  const recipients: (string | null)[] = []

  if (submittal.reviewed_by) {
    const reviewer = await fetchUserEmail(supabase, submittal.reviewed_by)
    if (reviewer) recipients.push(reviewer.email)
  }

  if (submittal.submitted_by_contact_id) {
    const submitter = await fetchContactEmail(supabase, submittal.submitted_by_contact_id)
    if (submitter) recipients.push(submitter.email)
  }

  if (submittal.project?.client_id) {
    const client = await fetchContactEmail(supabase, submittal.project.client_id)
    if (client) recipients.push(client.email)
  }

  if (recipients.length === 0) {
    console.warn("No recipients for submittal email; skipping", { submittalId })
    return
  }

  const projectName = submittal.project?.name ?? "Project"
  const subject = kind === "decision"
    ? `Submittal #${submittal.submittal_number} decision: ${decisionStatus}`
    : `New submittal #${submittal.submittal_number}: ${submittal.title}`

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
      <h2 style="margin-bottom: 4px;">${projectName}</h2>
      <p style="margin: 0 0 12px 0; color: #555;">Submittal #${submittal.submittal_number}</p>
      <p style="margin: 0 0 12px 0;"><strong>${submittal.title}</strong></p>
      ${
        kind === "decision"
          ? `<p style="margin: 0 0 8px 0;">Decision: <strong>${decisionStatus ?? "Updated"}</strong></p>${
              decisionNote ? `<p style="white-space:pre-wrap;">${decisionNote}</p>` : ""
            }`
          : `<p style="white-space:pre-wrap;">${submittal.description ?? "A new submittal has been created."}</p>`
      }
      <div style="margin-top: 16px;">
        <a href="${APP_URL}/submittals" style="background: #111827; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none;">Open in Arc</a>
      </div>
    </div>
  `

  await sendEmail({
    to: recipients,
    subject,
    html,
  })
}async function fetchUserEmail(supabase: any, userId: string): Promise<{ email: string | null; full_name?: string } | null> {
  const { data, error } = await supabase.from("app_users").select("email, full_name").eq("id", userId).maybeSingle()
  if (error) {
    console.warn("Failed to fetch user email", error)
    return null
  }
  return data
}async function fetchContactEmail(
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