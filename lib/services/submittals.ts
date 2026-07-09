import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { renderEmailTemplate, sendEmail, getOrgSenderEmail } from "@/lib/services/mailer"
import { attachFile, attachFileWithServiceRole } from "@/lib/services/file-links"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { ensurePortalLink, fetchCompanyContacts, fetchContactEmail, fetchUserEmail } from "@/lib/services/portal-links"
import { SubmittalNotificationEmail } from "@/lib/emails/submittal-notification-email"
import type { Submittal, SubmittalItem } from "@/lib/types"
import type {
  SubmittalDecisionInput,
  SubmittalInput,
  SubmittalItemInput,
  SubmittalUpdateInput,
} from "@/lib/validation/submittals"

const SUBMITTAL_SELECT =
  "id, org_id, project_id, submittal_number, revision, supersedes_submittal_id, superseded_by_id, title, description, status, spec_section, submittal_type, due_date, required_on_site, lead_time_days, assigned_company_id, submitted_by_company_id, submitted_by_contact_id, submitted_at, reviewed_by, review_notes, reviewed_at, attachment_file_id, last_item_submitted_at, decision_status, decision_note, decision_by_user_id, decision_by_contact_id, decision_at, decision_via_portal, decision_portal_token_id, created_at, updated_at"

const SUBMITTAL_NUMBER_CONFLICT_CONSTRAINT = "submittals_project_id_number_revision_key"
const ORG_LIST_CAP = 500

export async function listSubmittals(orgId?: string, projectId?: string): Promise<Submittal[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("submittal.read", { supabase, orgId: resolvedOrgId, userId })

  let query = supabase.from("submittals").select(SUBMITTAL_SELECT).eq("org_id", resolvedOrgId)

  if (projectId) {
    query = query
      .eq("project_id", projectId)
      .order("submittal_number", { ascending: true })
      .order("revision", { ascending: true })
  } else {
    // Org desk: current revisions only, newest first, capped.
    query = query.is("superseded_by_id", null).order("created_at", { ascending: false }).limit(ORG_LIST_CAP)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to load submittals: ${error.message}`)
  return data ?? []
}

export async function listSubmittalItems({
  orgId,
  submittalId,
}: {
  orgId: string
  submittalId: string
}): Promise<SubmittalItem[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("submittal_items")
    .select(
      `
      id, org_id, submittal_id, item_number, description, manufacturer, model_number, file_id, created_via_portal, created_at,
      responder_user:app_users(full_name),
      responder_contact:contacts(full_name),
      file:files(file_name)
      `,
    )
    .eq("org_id", orgId)
    .eq("submittal_id", submittalId)
    .order("item_number", { ascending: true })

  if (error) throw new Error(`Failed to load submittal items: ${error.message}`)

  return (data ?? []).map((row) => {
    const responderUser = Array.isArray(row.responder_user) ? row.responder_user[0] : row.responder_user
    const responderContact = Array.isArray(row.responder_contact) ? row.responder_contact[0] : row.responder_contact
    const file = Array.isArray(row.file) ? row.file[0] : row.file
    return {
      id: row.id,
      org_id: row.org_id,
      submittal_id: row.submittal_id,
      item_number: row.item_number,
      description: row.description,
      manufacturer: row.manufacturer ?? null,
      model_number: row.model_number ?? null,
      file_id: row.file_id ?? null,
      file_name: file?.file_name ?? null,
      file_download_url: null,
      created_via_portal: row.created_via_portal ?? false,
      responder_name: responderUser?.full_name ?? responderContact?.full_name ?? null,
      created_at: row.created_at,
    } satisfies SubmittalItem
  })
}

export async function createSubmittal({ input, orgId }: { input: SubmittalInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("submittal.write", { supabase, orgId: resolvedOrgId, userId })

  const payload = {
    org_id: resolvedOrgId,
    project_id: input.project_id,
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? "submitted",
    spec_section: input.spec_section ?? null,
    submittal_type: input.submittal_type ?? null,
    due_date: input.due_date || null,
    required_on_site: input.required_on_site || null,
    lead_time_days: input.lead_time_days ?? null,
    assigned_company_id: input.assigned_company_id ?? null,
    attachment_file_id: input.attachment_file_id ?? null,
    submitted_at: input.status === "draft" ? null : new Date().toISOString(),
    revision: 0,
  }

  const { data, insertPayload } = await insertWithProjectNumberRetry<Submittal>({
    supabase,
    table: "submittals",
    numberColumn: "submittal_number",
    rpcName: "next_submittal_number",
    conflictConstraint: SUBMITTAL_NUMBER_CONFLICT_CONSTRAINT,
    projectId: input.project_id,
    payload,
    select: SUBMITTAL_SELECT,
    explicitNumber: input.submittal_number,
    entityLabel: "submittal",
  })

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
    after: insertPayload,
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

  if (data.status !== "draft") {
    await sendSubmittalEmail({ orgId: resolvedOrgId, submittalId: data.id, kind: "created" })
  }

  return data
}

export async function updateSubmittal({ input, orgId }: { input: SubmittalUpdateInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("submittal.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("submittals")
    .select(SUBMITTAL_SELECT)
    .eq("id", input.submittal_id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error(`Failed to load submittal: ${existingError?.message ?? "Not found"}`)
  }

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.title !== undefined) updatePayload.title = input.title
  if (input.description !== undefined) updatePayload.description = input.description
  if (input.spec_section !== undefined) updatePayload.spec_section = input.spec_section
  if (input.submittal_type !== undefined) updatePayload.submittal_type = input.submittal_type
  if (input.due_date !== undefined) updatePayload.due_date = input.due_date || null
  if (input.required_on_site !== undefined) updatePayload.required_on_site = input.required_on_site || null
  if (input.lead_time_days !== undefined) updatePayload.lead_time_days = input.lead_time_days
  if (input.assigned_company_id !== undefined) updatePayload.assigned_company_id = input.assigned_company_id
  if (input.status !== undefined) {
    updatePayload.status = input.status
    if (existing.status === "draft" && input.status !== "draft" && !existing.submitted_at) {
      updatePayload.submitted_at = new Date().toISOString()
    }
  }

  const { data, error } = await supabase
    .from("submittals")
    .update(updatePayload)
    .eq("id", input.submittal_id)
    .eq("org_id", resolvedOrgId)
    .select(SUBMITTAL_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update submittal: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "submittal_updated",
    entityType: "submittal",
    entityId: data.id,
    payload: { submittal_number: data.submittal_number, project_id: data.project_id, status: data.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "submittal",
    entityId: data.id,
    before: existing,
    after: updatePayload,
  })

  return data as Submittal
}

/** Service-role insert shared by the internal action and the sub portal. */
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

  // A submission moves a pending/draft submittal into review.
  const { data: parent } = await supabase
    .from("submittals")
    .select("id, status")
    .eq("id", input.submittal_id)
    .eq("org_id", orgId)
    .maybeSingle()

  const statusUpdate =
    parent && (parent.status === "draft" || parent.status === "pending") ? { status: "submitted" } : {}

  await supabase
    .from("submittals")
    .update({ last_item_submitted_at: now, ...statusUpdate })
    .eq("id", input.submittal_id)
    .eq("org_id", orgId)

  await recordEvent({
    orgId,
    eventType: "submittal_item_added",
    entityType: "submittal",
    entityId: input.submittal_id,
    payload: { item_number: nextNumber, via_portal: input.created_via_portal ?? false },
  })

  await recordAudit({
    orgId,
    actorId: input.responder_user_id ?? input.responder_contact_id ?? undefined,
    action: "insert",
    entityType: "submittal_item",
    entityId: input.submittal_id,
    after: { ...input, item_number: nextNumber },
    source: input.created_via_portal ? "portal" : undefined,
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

  if (input.created_via_portal) {
    await sendSubmittalEmail({ orgId, submittalId: input.submittal_id, kind: "item_submitted" })
  }

  return { success: true }
}

export async function decideSubmittal({ input, orgId }: { input: SubmittalDecisionInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("submittal.review", { supabase, orgId: resolvedOrgId, userId })

  const decisionAt = new Date().toISOString()

  const { data, error } = await supabase
    .from("submittals")
    .update({
      decision_status: input.decision_status,
      decision_note: input.decision_note ?? null,
      decision_by_user_id: userId,
      decision_by_contact_id: null,
      decision_portal_token_id: null,
      decision_via_portal: false,
      decision_at: decisionAt,
      reviewed_at: decisionAt,
      reviewed_by: userId,
      review_notes: input.decision_note ?? null,
      status: input.decision_status,
    })
    .eq("id", input.submittal_id)
    .eq("org_id", resolvedOrgId)
    .select(SUBMITTAL_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to record submittal decision: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "submittal_decided",
    entityType: "submittal",
    entityId: input.submittal_id,
    payload: { decision_status: input.decision_status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "submittal",
    entityId: input.submittal_id,
    after: { ...input, decision_by_user_id: userId },
  })

  await sendSubmittalEmail({
    orgId: resolvedOrgId,
    submittalId: input.submittal_id,
    kind: input.decision_status === "revise_resubmit" ? "resubmit_requested" : "decision",
    decisionStatus: input.decision_status,
    decisionNote: input.decision_note ?? undefined,
  })

  return data as Submittal
}

/**
 * Creates the next revision of a submittal after a revise_resubmit/rejected
 * decision: same number, revision + 1, carried-over metadata, cleared review.
 */
export async function resubmitSubmittal({ submittalId, orgId }: { submittalId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("submittal.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("submittals")
    .select(SUBMITTAL_SELECT)
    .eq("id", submittalId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error(`Failed to load submittal: ${existingError?.message ?? "Not found"}`)
  }
  if (existing.superseded_by_id) {
    throw new Error("This revision has already been superseded")
  }
  if (existing.decision_status !== "revise_resubmit" && existing.decision_status !== "rejected") {
    throw new Error("Only submittals marked Revise & Resubmit or Rejected can be resubmitted")
  }

  const insertPayload = {
    org_id: resolvedOrgId,
    project_id: existing.project_id,
    submittal_number: existing.submittal_number,
    revision: existing.revision + 1,
    supersedes_submittal_id: existing.id,
    title: existing.title,
    description: existing.description,
    status: "submitted",
    spec_section: existing.spec_section,
    submittal_type: existing.submittal_type,
    due_date: existing.due_date,
    required_on_site: existing.required_on_site,
    lead_time_days: existing.lead_time_days,
    assigned_company_id: existing.assigned_company_id,
    submitted_by_company_id: existing.submitted_by_company_id,
    submitted_by_contact_id: existing.submitted_by_contact_id,
    submitted_at: new Date().toISOString(),
  }

  const { data: created, error: createError } = await supabase
    .from("submittals")
    .insert(insertPayload)
    .select(SUBMITTAL_SELECT)
    .single()

  if (createError || !created) {
    throw new Error(`Failed to create revision: ${createError?.message}`)
  }

  const { error: supersedeError } = await supabase
    .from("submittals")
    .update({ superseded_by_id: created.id })
    .eq("id", existing.id)
    .eq("org_id", resolvedOrgId)

  if (supersedeError) {
    throw new Error(`Failed to mark prior revision superseded: ${supersedeError.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "submittal_resubmitted",
    entityType: "submittal",
    entityId: created.id,
    payload: {
      submittal_number: created.submittal_number,
      revision: created.revision,
      supersedes_submittal_id: existing.id,
      project_id: created.project_id,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "submittal",
    entityId: created.id,
    after: insertPayload,
  })

  await sendSubmittalEmail({ orgId: resolvedOrgId, submittalId: created.id, kind: "created" })

  return created as Submittal
}

export async function listSubmittalRevisions({
  orgId,
  projectId,
  submittalNumber,
}: {
  orgId: string
  projectId: string
  submittalNumber: number
}): Promise<Submittal[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("submittals")
    .select(SUBMITTAL_SELECT)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("submittal_number", submittalNumber)
    .order("revision", { ascending: false })

  if (error) throw new Error(`Failed to load submittal revisions: ${error.message}`)
  return data ?? []
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
  kind: "created" | "item_submitted" | "decision" | "resubmit_requested"
  decisionStatus?: string
  decisionNote?: string
}) {
  const supabase = createServiceSupabaseClient()
  const [{ data: submittal, error }, { data: org }] = await Promise.all([
    supabase
      .from("submittals")
      .select(
        "id, org_id, project_id, submittal_number, revision, title, description, status, spec_section, due_date, required_on_site, assigned_company_id, submitted_by_contact_id, reviewed_by, project:projects(name, client_id)",
      )
      .eq("id", submittalId)
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase.from("orgs").select("name, slug, logo_url").eq("id", orgId).maybeSingle(),
  ])

  if (error || !submittal) {
    console.warn("Unable to load submittal for email notification", error)
    return
  }

  const project = Array.isArray(submittal.project) ? submittal.project[0] : submittal.project

  const recipients: Array<{
    email: string
    name?: string | null
    audience: "internal" | "client" | "sub"
    portalLink?: string | null
  }> = []

  await Promise.all([
    (async () => {
      if (!submittal.reviewed_by) return
      const reviewer = await fetchUserEmail(supabase, submittal.reviewed_by)
      if (reviewer?.email) {
        recipients.push({ email: reviewer.email, name: reviewer.full_name, audience: "internal", portalLink: null })
      }
    })(),
    (async () => {
      if (!submittal.submitted_by_contact_id) return
      const submitter = await fetchContactEmail(supabase, submittal.submitted_by_contact_id)
      if (submitter?.email) {
        recipients.push({ email: submitter.email, name: submitter.full_name, audience: "sub", portalLink: null })
      }
    })(),
    (async () => {
      if (!submittal.assigned_company_id) return
      const companyContacts = await fetchCompanyContacts(supabase, orgId, submittal.assigned_company_id)
      if (companyContacts.length === 0) return
      const link = await ensurePortalLink({
        supabase,
        orgId,
        projectId: submittal.project_id,
        portalType: "sub",
        contactId: null,
        companyId: submittal.assigned_company_id,
        createdBy: null,
        capabilities: { can_view_submittals: true, can_submit_submittals: true },
        fallbackPath: `/submittals?project=${submittal.project_id}`,
      })
      for (const contact of companyContacts) {
        if (contact.email) {
          recipients.push({ email: contact.email, name: contact.full_name, audience: "sub", portalLink: link })
        }
      }
    })(),
  ])

  if (recipients.length === 0) {
    return
  }

  const deduped = new Map<string, (typeof recipients)[number]>()
  for (const recipient of recipients) {
    const existing = deduped.get(recipient.email)
    if (!existing || (!existing.portalLink && recipient.portalLink)) {
      deduped.set(recipient.email, recipient)
    }
  }

  const numberLabel =
    submittal.revision > 0 ? `#${submittal.submittal_number} Rev ${submittal.revision}` : `#${submittal.submittal_number}`
  const subject =
    kind === "created"
      ? `Submittal ${numberLabel}: ${submittal.title}`
      : kind === "item_submitted"
        ? `Documents submitted on submittal ${numberLabel}`
        : kind === "resubmit_requested"
          ? `Resubmission requested: submittal ${numberLabel}`
          : `Submittal ${numberLabel} decision: ${decisionStatus?.replace(/_/g, " ") ?? "updated"}`

  const formatDateLabel = (value: string | null | undefined) =>
    value
      ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : null

  await Promise.all(
    Array.from(deduped.values()).map(async (recipient) => {
      const actionHref =
        recipient.audience === "internal" || !recipient.portalLink
          ? `${APP_URL}/projects/${submittal.project_id}/submittals`
          : recipient.portalLink
      const actionLabel = recipient.audience === "internal" ? "Open in Arc" : "Open in Portal"

      const html = await renderEmailTemplate(
        SubmittalNotificationEmail({
          orgName: org?.name ?? null,
          orgLogoUrl: org?.logo_url ?? null,
          recipientName: recipient.name ?? null,
          audience: recipient.audience,
          projectName: project?.name ?? null,
          submittalNumber: submittal.submittal_number,
          revision: submittal.revision ?? 0,
          title: submittal.title,
          description: submittal.description,
          kind,
          decisionStatus: decisionStatus ?? null,
          decisionNote: decisionNote ?? null,
          specSection: submittal.spec_section,
          dueDate: formatDateLabel(submittal.due_date),
          requiredOnSite: formatDateLabel(submittal.required_on_site),
          actionHref,
          actionLabel,
        }),
      )

      await sendEmail({
        to: [recipient.email],
        subject,
        html,
        from: getOrgSenderEmail(org?.slug, org?.name),
      })
    }),
  )
}
