import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { renderEmailTemplate, sendEmail, getOrgSenderEmail } from "@/lib/services/mailer"
import { attachFile, attachFileWithServiceRole } from "@/lib/services/file-links"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import {
  ensurePortalLink,
  ensureReviewerLink,
  fetchCompanyContacts,
  fetchContactEmail,
  fetchUserEmail,
} from "@/lib/services/portal-links"
import { SubmittalNotificationEmail } from "@/lib/emails/submittal-notification-email"
import { getProjectPosture, normalizeProductTier } from "@/lib/product-tier"
import { createVersionFromBytes } from "@/lib/services/file-versions"
import { fetchDistributionRecipients } from "@/lib/services/distribution-lists"
import { downloadFilesObject } from "@/lib/storage/files-storage"
import { applySubmittalReviewStamp } from "@/lib/pdfs/submittal-stamp"
import type { Submittal, SubmittalItem, SubmittalReviewDecision, SubmittalReviewStep } from "@/lib/types"
import type {
  DecideSubmittalReviewStepInput,
  SetSubmittalReviewStepsInput,
  SubmittalDecisionInput,
  SubmittalInput,
  SubmittalItemInput,
  SubmittalReviewStepInput,
  SubmittalUpdateInput,
  UpdateSubmittalReviewStepInput,
} from "@/lib/validation/submittals"
import { formatDocNumber, type DocumentNumberingSettings } from "@/lib/document-number"
import {
  finalApprovedDecision,
  nextPendingReviewGroup,
  reviewGroupCourtLabel,
  reviewGroupIsComplete,
  type ReviewWorkflowStepState,
} from "@/lib/submittal-review-workflow"

const SUBMITTAL_SELECT =
  "id, org_id, project_id, submittal_number, revision, supersedes_submittal_id, superseded_by_id, title, description, status, spec_section, submittal_type, due_date, required_on_site, lead_time_days, assigned_company_id, submitted_by_company_id, submitted_by_contact_id, submitted_at, reviewed_by, review_notes, reviewed_at, attachment_file_id, last_item_submitted_at, decision_status, decision_note, decision_by_user_id, decision_by_contact_id, decision_at, decision_via_portal, decision_portal_token_id, current_review_step_id, ball_in_court, stamped_file_id, created_at, updated_at"

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

  const [{ data, error }, { data: org }] = await Promise.all([
    query,
    supabase.from("orgs").select("document_numbering").eq("id", resolvedOrgId).single(),
  ])
  if (error) throw new Error(`Failed to load submittals: ${error.message}`)
  const numbering = (org?.document_numbering ?? {}) as DocumentNumberingSettings
  return (data ?? []).map((submittal) => ({ ...submittal, display_number: formatDocNumber("submittal", submittal.submittal_number, numbering) }))
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

  await instantiateSubmittalReviewWorkflow({ orgId: resolvedOrgId, submittal: data })

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

  // Documents in hand — the first pending review step (if any) takes the ball.
  await startReviewWorkflowIfIdle({ orgId, submittalId: input.submittal_id })

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

  return finalizeSubmittalDecision({
    orgId: resolvedOrgId,
    submittalId: input.submittal_id,
    decisionStatus: input.decision_status,
    decisionNote: input.decision_note ?? null,
    actorUserId: userId,
  })
}

/**
 * Shared finalizer for both the direct single-decision path (decideSubmittal)
 * and the multi-step review workflow (last step approved / any step
 * short-circuited). Keeps events, audit, org desk, and emails on one path.
 * Callers are responsible for authorization.
 */
async function finalizeSubmittalDecision({
  orgId,
  submittalId,
  decisionStatus,
  decisionNote,
  actorUserId,
  actorContactId,
  portalTokenId,
}: {
  orgId: string
  submittalId: string
  decisionStatus: NonNullable<SubmittalDecisionInput["decision_status"]>
  decisionNote?: string | null
  actorUserId?: string | null
  actorContactId?: string | null
  portalTokenId?: string | null
}): Promise<Submittal> {
  const supabase = createServiceSupabaseClient()
  const decisionAt = new Date().toISOString()
  const viaPortal = !!portalTokenId

  const { data, error } = await supabase
    .from("submittals")
    .update({
      decision_status: decisionStatus,
      decision_note: decisionNote ?? null,
      decision_by_user_id: actorUserId ?? null,
      decision_by_contact_id: actorContactId ?? null,
      decision_portal_token_id: portalTokenId ?? null,
      decision_via_portal: viaPortal,
      decision_at: decisionAt,
      reviewed_at: decisionAt,
      reviewed_by: actorUserId ?? null,
      review_notes: decisionNote ?? null,
      status: decisionStatus,
      current_review_step_id: null,
      ball_in_court: null,
    })
    .eq("id", submittalId)
    .eq("org_id", orgId)
    .select(SUBMITTAL_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to record submittal decision: ${error?.message}`)
  }

  // Revise & resubmit puts the ball back in the subcontractor's court.
  if (decisionStatus === "revise_resubmit") {
    const bic = await subCourtLabel(supabase, orgId, data.assigned_company_id)
    await supabase.from("submittals").update({ ball_in_court: bic }).eq("id", submittalId).eq("org_id", orgId)
    data.ball_in_court = bic
  }

  await recordEvent({
    orgId,
    eventType: "submittal_decided",
    entityType: "submittal",
    entityId: submittalId,
    payload: { decision_status: decisionStatus, via_portal: viaPortal },
  })

  await recordAudit({
    orgId,
    actorId: actorUserId ?? actorContactId ?? undefined,
    action: "update",
    entityType: "submittal",
    entityId: submittalId,
    after: {
      decision_status: decisionStatus,
      decision_note: decisionNote ?? null,
      decision_by_user_id: actorUserId ?? null,
      decision_by_contact_id: actorContactId ?? null,
    },
    source: viaPortal ? "portal" : undefined,
  })

  await sendSubmittalEmail({
    orgId,
    submittalId,
    kind: decisionStatus === "revise_resubmit" ? "resubmit_requested" : "decision",
    decisionStatus,
    decisionNote: decisionNote ?? undefined,
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

  // The new revision re-runs the same review workflow the prior revision had.
  const priorSteps = await listSubmittalReviewSteps({ orgId: resolvedOrgId, submittalId: existing.id })
  await instantiateSubmittalReviewWorkflow({
    orgId: resolvedOrgId,
    submittal: created,
    steps:
      priorSteps.length > 0
        ? priorSteps.map((step) => ({
            reviewer_kind: step.reviewer_kind,
            role_label: step.role_label ?? "",
            reviewer_user_id: step.reviewer_user_id,
            reviewer_contact_id: step.reviewer_contact_id,
            reviewer_company_id: step.reviewer_company_id,
            due_date: step.due_date,
          }))
        : undefined,
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
    supabase.from("orgs").select("name, slug, logo_url, document_numbering").eq("id", orgId).maybeSingle(),
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
    (async () => {
      // Managed distribution list: everyone copied on this project's submittals.
      const members = await fetchDistributionRecipients(orgId, submittal.project_id, "submittals")
      for (const member of members) {
        recipients.push({
          email: member.email,
          name: member.name,
          audience: member.userId ? "internal" : "client",
          portalLink: null,
        })
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

  const displayNumber = formatDocNumber("submittal", submittal.submittal_number, (org?.document_numbering ?? {}) as DocumentNumberingSettings)
  const numberLabel = submittal.revision > 0 ? `#${displayNumber} Rev ${submittal.revision}` : `#${displayNumber}`
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
          submittalNumber: displayNumber,
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

// ---------------------------------------------------------------------------
// Multi-step review routing (workstream 04). Submittals with zero steps keep
// the single-decision path above untouched; commercial-posture projects get
// the org workflow template instantiated on send.
// ---------------------------------------------------------------------------

const REVIEW_STEP_SELECT = `
  id, org_id, submittal_id, step_order, review_group, reviewer_kind, reviewer_user_id, reviewer_contact_id, reviewer_company_id,
  role_label, status, decision, notes, decided_at, due_date, markup_file_id, created_at,
  portal_token_id, portal_token:portal_access_tokens(token),
  reviewer_user:app_users(full_name),
  reviewer_contact:contacts(full_name),
  reviewer_company:companies(name)
`

export interface SubmittalWorkflowTemplateStep {
  reviewer_kind: "internal" | "external"
  role_label: string
  review_group?: number
}

export const DEFAULT_COMMERCIAL_REVIEW_WORKFLOW: SubmittalWorkflowTemplateStep[] = [
  { reviewer_kind: "internal", role_label: "GC Review" },
  { reviewer_kind: "external", role_label: "Architect" },
]

function mapReviewStep(row: any): SubmittalReviewStep {
  const reviewerUser = Array.isArray(row.reviewer_user) ? row.reviewer_user[0] : row.reviewer_user
  const reviewerContact = Array.isArray(row.reviewer_contact) ? row.reviewer_contact[0] : row.reviewer_contact
  const reviewerCompany = Array.isArray(row.reviewer_company) ? row.reviewer_company[0] : row.reviewer_company
  const portalToken = Array.isArray(row.portal_token) ? row.portal_token[0] : row.portal_token
  return {
    id: row.id,
    org_id: row.org_id,
    submittal_id: row.submittal_id,
    step_order: row.step_order,
    review_group: row.review_group,
    reviewer_kind: row.reviewer_kind,
    reviewer_user_id: row.reviewer_user_id ?? null,
    reviewer_contact_id: row.reviewer_contact_id ?? null,
    reviewer_company_id: row.reviewer_company_id ?? null,
    reviewer_name: reviewerUser?.full_name ?? reviewerContact?.full_name ?? null,
    reviewer_company_name: reviewerCompany?.name ?? null,
    role_label: row.role_label ?? null,
    status: row.status,
    decision: row.decision ?? null,
    notes: row.notes ?? null,
    decided_at: row.decided_at ?? null,
    due_date: row.due_date ?? null,
    markup_file_id: row.markup_file_id ?? null,
    reviewer_portal_url: typeof portalToken?.token === "string" ? `${APP_URL}/r/${portalToken.token}` : null,
    created_at: row.created_at,
  }
}

export async function listSubmittalReviewSteps({
  orgId,
  submittalId,
}: {
  orgId: string
  submittalId: string
}): Promise<SubmittalReviewStep[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("submittal_review_steps")
    .select(REVIEW_STEP_SELECT)
    .eq("org_id", orgId)
    .eq("submittal_id", submittalId)
    .order("step_order", { ascending: true })

  if (error) throw new Error(`Failed to load review steps: ${error.message}`)
  return (data ?? []).map(mapReviewStep)
}

/** "Subcontractor (CompanyName)" — the label used while the sub owes documents. */
async function subCourtLabel(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  assignedCompanyId: string | null | undefined,
): Promise<string> {
  if (!assignedCompanyId) return "Subcontractor"
  const { data } = await supabase
    .from("companies")
    .select("name")
    .eq("id", assignedCompanyId)
    .eq("org_id", orgId)
    .maybeSingle()
  return data?.name ? `Subcontractor (${data.name})` : "Subcontractor"
}

/** Org-level workflow template: org_settings.settings.submittal_review_workflow. */
async function getOrgSubmittalWorkflowTemplate(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
): Promise<SubmittalWorkflowTemplateStep[] | null> {
  const { data } = await supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle()
  const raw = (data?.settings as Record<string, unknown> | null)?.submittal_review_workflow
  if (!Array.isArray(raw)) return null
  const steps = raw
    .filter(
      (step): step is Record<string, unknown> =>
        !!step &&
        typeof step === "object" &&
        ((step as any).reviewer_kind === "internal" || (step as any).reviewer_kind === "external") &&
        typeof (step as any).role_label === "string",
    )
    .map((step) => ({
      reviewer_kind: step.reviewer_kind as "internal" | "external",
      role_label: step.role_label as string,
      review_group: typeof step.review_group === "number" && step.review_group > 0 ? step.review_group : undefined,
    }))
  return steps.length > 0 ? steps : null
}

/**
 * Instantiates the review workflow for a new submittal (or new revision).
 * Commercial-posture projects get the org template (or the 2-step default);
 * residential projects get no steps and keep the legacy single-decision path.
 * When template steps are provided (revision recreation), they win.
 */
async function instantiateSubmittalReviewWorkflow({
  orgId,
  submittal,
  steps,
}: {
  orgId: string
  submittal: Pick<Submittal, "id" | "project_id" | "assigned_company_id">
  steps?: Array<Partial<SubmittalReviewStep> & SubmittalWorkflowTemplateStep>
}): Promise<void> {
  const supabase = createServiceSupabaseClient()

  const { data: existing } = await supabase
    .from("submittal_review_steps")
    .select("id")
    .eq("org_id", orgId)
    .eq("submittal_id", submittal.id)
    .limit(1)

  if ((existing ?? []).length > 0) return

  let resolvedSteps = steps ?? null
  if (!resolvedSteps) {
    const [{ data: project }, { data: org }] = await Promise.all([
      supabase.from("projects").select("property_type").eq("id", submittal.project_id).maybeSingle(),
      supabase.from("orgs").select("product_tier").eq("id", orgId).maybeSingle(),
    ])
    const posture = getProjectPosture(project?.property_type, normalizeProductTier(org?.product_tier))
    if (posture !== "commercial") return
    resolvedSteps = (await getOrgSubmittalWorkflowTemplate(supabase, orgId)) ?? DEFAULT_COMMERCIAL_REVIEW_WORKFLOW
  }

  if (resolvedSteps.length === 0) return

  const { error } = await supabase.from("submittal_review_steps").insert(
    resolvedSteps.map((step, index) => ({
      org_id: orgId,
      submittal_id: submittal.id,
      step_order: index + 1,
      review_group: step.review_group ?? index + 1,
      reviewer_kind: step.reviewer_kind,
      role_label: step.role_label,
      reviewer_user_id: step.reviewer_user_id ?? null,
      reviewer_contact_id: step.reviewer_contact_id ?? null,
      reviewer_company_id: step.reviewer_company_id ?? null,
      due_date: step.due_date ?? null,
    })),
  )

  if (error) {
    console.warn("Failed to instantiate submittal review workflow", error)
    return
  }

  const bic = await subCourtLabel(supabase, orgId, submittal.assigned_company_id)
  await supabase.from("submittals").update({ ball_in_court: bic }).eq("id", submittal.id).eq("org_id", orgId)
}

/** Replaces the workflow while nothing has started (all steps still pending). */
export async function setSubmittalReviewSteps({
  input,
  orgId,
}: {
  input: SetSubmittalReviewStepsInput
  orgId?: string
}): Promise<SubmittalReviewStep[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("submittal.route", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const { data: submittal } = await serviceClient
    .from("submittals")
    .select("id, project_id, assigned_company_id, decision_status")
    .eq("id", input.submittal_id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()
  if (!submittal) throw new Error("Submittal not found")
  if (submittal.decision_status) throw new Error("This submittal has already been decided")

  const { data: startedSteps } = await serviceClient
    .from("submittal_review_steps")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("submittal_id", input.submittal_id)
    .neq("status", "pending")
    .limit(1)
  if ((startedSteps ?? []).length > 0) {
    throw new Error("Review has started — edit the remaining steps individually instead of replacing the workflow")
  }

  const { error: deleteError } = await serviceClient
    .from("submittal_review_steps")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("submittal_id", input.submittal_id)
  if (deleteError) throw new Error(`Failed to replace review steps: ${deleteError.message}`)

  if (input.steps.length > 0) {
    const { error: insertError } = await serviceClient.from("submittal_review_steps").insert(
      input.steps.map((step: SubmittalReviewStepInput, index: number) => ({
        org_id: resolvedOrgId,
        submittal_id: input.submittal_id,
        step_order: index + 1,
        review_group: step.review_group ?? index + 1,
        reviewer_kind: step.reviewer_kind,
        role_label: step.role_label,
        reviewer_user_id: step.reviewer_user_id ?? null,
        reviewer_contact_id: step.reviewer_contact_id ?? null,
        reviewer_company_id: step.reviewer_company_id ?? null,
        due_date: step.due_date ?? null,
      })),
    )
    if (insertError) throw new Error(`Failed to save review steps: ${insertError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "submittal",
    entityId: input.submittal_id,
    after: { review_steps: input.steps },
  })

  return listSubmittalReviewSteps({ orgId: resolvedOrgId, submittalId: input.submittal_id })
}

/** Patches reviewer/label/due date on a single not-yet-decided step. */
export async function updateSubmittalReviewStep({
  input,
  orgId,
}: {
  input: UpdateSubmittalReviewStepInput
  orgId?: string
}): Promise<SubmittalReviewStep[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("submittal.route", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const { data: step } = await serviceClient
    .from("submittal_review_steps")
    .select("id, submittal_id, status, reviewer_kind, reviewer_contact_id, review_group")
    .eq("id", input.step_id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()
  if (!step) throw new Error("Review step not found")
  if (step.status === "returned" || step.status === "skipped") {
    throw new Error("This step has already been decided")
  }
  if (step.status === "in_review" && input.review_group !== undefined && input.review_group !== step.review_group) {
    throw new Error("Parallel grouping cannot change after review starts")
  }

  const patch: Record<string, unknown> = {}
  if (input.role_label !== undefined) patch.role_label = input.role_label
  if (input.reviewer_user_id !== undefined) patch.reviewer_user_id = input.reviewer_user_id
  if (input.reviewer_contact_id !== undefined) patch.reviewer_contact_id = input.reviewer_contact_id
  if (input.reviewer_company_id !== undefined) patch.reviewer_company_id = input.reviewer_company_id
  if (input.due_date !== undefined) patch.due_date = input.due_date || null
  if (input.review_group !== undefined) patch.review_group = input.review_group

  const { error } = await serviceClient
    .from("submittal_review_steps")
    .update(patch)
    .eq("id", input.step_id)
    .eq("org_id", resolvedOrgId)
  if (error) throw new Error(`Failed to update review step: ${error.message}`)

  const externalReviewerChanged =
    step.reviewer_kind === "external" &&
    typeof input.reviewer_contact_id === "string" &&
    input.reviewer_contact_id !== step.reviewer_contact_id
  if (step.status === "in_review" && externalReviewerChanged) {
    await notifyReviewStepAssigned({ orgId: resolvedOrgId, submittalId: step.submittal_id, stepId: input.step_id })
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "submittal_review_step",
    entityId: input.step_id,
    after: patch,
  })

  return listSubmittalReviewSteps({ orgId: resolvedOrgId, submittalId: step.submittal_id })
}

/** Moves one review group into court concurrently. */
async function activateReviewGroup({
  orgId,
  submittalId,
  steps,
}: {
  orgId: string
  submittalId: string
  steps: Array<{ id: string; role_label?: string | null }>
}) {
  if (steps.length === 0) return
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("submittal_review_steps")
    .update({ status: "in_review" })
    .eq("org_id", orgId)
    .in("id", steps.map((step) => step.id))
  await supabase
    .from("submittals")
    .update({
      current_review_step_id: steps[0].id,
      ball_in_court: reviewGroupCourtLabel(steps.map((step, index) => ({
        ...step,
        step_order: index + 1,
        review_group: 1,
        status: "in_review" as const,
      }))),
      status: "in_review",
    })
    .eq("id", submittalId)
    .eq("org_id", orgId)
}

/**
 * Called when the sub submits documents: the first pending step goes into
 * review. Zero-step submittals fall through to the legacy status flow.
 */
async function startReviewWorkflowIfIdle({ orgId, submittalId }: { orgId: string; submittalId: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: steps } = await supabase
    .from("submittal_review_steps")
    .select("id, step_order, review_group, status, role_label, reviewer_kind, reviewer_contact_id, reviewer_user_id, reviewer_company_id")
    .eq("org_id", orgId)
    .eq("submittal_id", submittalId)
    .order("step_order", { ascending: true })

  if (!steps || steps.length === 0) return
  if (steps.some((step) => step.status === "in_review")) return
  // Only auto-start a fresh workflow; a returned step means review already ran.
  if (steps.some((step) => step.status === "returned")) return
  const firstGroup = nextPendingReviewGroup(steps as ReviewWorkflowStepState[])
  if (firstGroup.length === 0) return

  await activateReviewGroup({ orgId, submittalId, steps: firstGroup })
  await Promise.all(firstGroup.map((step) => notifyReviewStepAssigned({ orgId, submittalId, stepId: step.id })))
}

/**
 * Core state machine for a step decision. Callers own authorization:
 * the internal action checks submittal.route, the reviewer portal checks the
 * token's can_review_submittals capability and step identity.
 */
export async function applyReviewStepDecision({
  orgId,
  stepId,
  decision,
  notes,
  markupFileId,
  actorUserId,
  actorContactId,
  portalTokenId,
}: {
  orgId: string
  stepId: string
  decision: SubmittalReviewDecision
  notes?: string | null
  markupFileId?: string | null
  actorUserId?: string | null
  actorContactId?: string | null
  portalTokenId?: string | null
}): Promise<Submittal> {
  const supabase = createServiceSupabaseClient()

  const { data: step, error: stepError } = await supabase
    .from("submittal_review_steps")
    .select("id, submittal_id, step_order, review_group, status, role_label, reviewer_kind")
    .eq("id", stepId)
    .eq("org_id", orgId)
    .maybeSingle()
  if (stepError || !step) throw new Error("Review step not found")
  if (step.status !== "in_review") throw new Error("This step is not currently in review")

  const { data: submittal } = await supabase
    .from("submittals")
    .select(SUBMITTAL_SELECT)
    .eq("id", step.submittal_id)
    .eq("org_id", orgId)
    .maybeSingle()
  if (!submittal) throw new Error("Submittal not found")

  const decidedAt = new Date().toISOString()
  const { error: updateError } = await supabase
    .from("submittal_review_steps")
    .update({
      status: "returned",
      decision,
      notes: notes ?? null,
      decided_at: decidedAt,
      markup_file_id: markupFileId ?? null,
      portal_token_id: portalTokenId ?? null,
      ...(actorContactId ? { reviewer_contact_id: actorContactId } : {}),
      ...(actorUserId && step.reviewer_kind === "internal" ? { reviewer_user_id: actorUserId } : {}),
    })
    .eq("id", stepId)
    .eq("org_id", orgId)
  if (updateError) throw new Error(`Failed to record step decision: ${updateError.message}`)

  if (markupFileId) {
    try {
      await attachFileWithServiceRole({
        orgId,
        fileId: markupFileId,
        projectId: submittal.project_id,
        entityType: "submittal",
        entityId: step.submittal_id,
        linkRole: "review_markup",
        createdBy: actorUserId ?? null,
      })
    } catch (error) {
      console.warn("Failed to attach review markup to file_links", error)
    }
  }

  await recordEvent({
    orgId,
    eventType: "submittal_step_decided",
    entityType: "submittal",
    entityId: step.submittal_id,
    payload: {
      step_id: stepId,
      step_order: step.step_order,
      role_label: step.role_label,
      decision,
      via_portal: !!portalTokenId,
    },
  })

  await recordAudit({
    orgId,
    actorId: actorUserId ?? actorContactId ?? undefined,
    action: "update",
    entityType: "submittal_review_step",
    entityId: stepId,
    after: { decision, notes: notes ?? null, markup_file_id: markupFileId ?? null },
    source: portalTokenId ? "portal" : undefined,
  })

  if (decision === "approved" || decision === "approved_as_noted") {
    const { data: workflowRows, error: workflowError } = await supabase
      .from("submittal_review_steps")
      .select("id, step_order, review_group, status, role_label, decision")
      .eq("org_id", orgId)
      .eq("submittal_id", step.submittal_id)
      .order("step_order", { ascending: true })
    if (workflowError) throw new Error(`Failed to advance review workflow: ${workflowError.message}`)
    const workflow = (workflowRows ?? []) as ReviewWorkflowStepState[]

    if (!reviewGroupIsComplete(workflow, step.review_group)) {
      const activeGroup = workflow.filter((candidate) => candidate.review_group === step.review_group && candidate.status === "in_review")
      await supabase
        .from("submittals")
        .update({
          current_review_step_id: activeGroup[0]?.id ?? null,
          ball_in_court: reviewGroupCourtLabel(activeGroup),
        })
        .eq("id", step.submittal_id)
        .eq("org_id", orgId)
      const { data: refreshed } = await supabase
        .from("submittals")
        .select(SUBMITTAL_SELECT)
        .eq("id", step.submittal_id)
        .eq("org_id", orgId)
        .single()
      return refreshed as Submittal
    }

    const nextGroup = nextPendingReviewGroup(workflow, step.review_group)
    if (nextGroup.length > 0) {
      await activateReviewGroup({ orgId, submittalId: step.submittal_id, steps: nextGroup })
      await Promise.all(nextGroup.map((nextStep) => notifyReviewStepAssigned({ orgId, submittalId: step.submittal_id, stepId: nextStep.id })))
      const { data: refreshed } = await supabase
        .from("submittals")
        .select(SUBMITTAL_SELECT)
        .eq("id", step.submittal_id)
        .eq("org_id", orgId)
        .single()
      return refreshed as Submittal
    }

    const finalDecision = finalApprovedDecision(workflow)

    const finalized = await finalizeSubmittalDecision({
      orgId,
      submittalId: step.submittal_id,
      decisionStatus: finalDecision,
      decisionNote: notes ?? null,
      actorUserId,
      actorContactId,
      portalTokenId,
    })
    await stampReturnedSubmittal({ orgId, submittal: finalized, finalStepId: stepId, decision: finalDecision })
    return finalized
  }

  // revise_resubmit / rejected short-circuit the workflow.
  await supabase
    .from("submittal_review_steps")
    .update({ status: "skipped" })
    .eq("org_id", orgId)
    .eq("submittal_id", step.submittal_id)
    .eq("status", "pending")

  await recordEvent({
    orgId,
    eventType: "submittal_returned",
    entityType: "submittal",
    entityId: step.submittal_id,
    payload: { step_id: stepId, decision },
  })

  const finalized = await finalizeSubmittalDecision({
    orgId,
    submittalId: step.submittal_id,
    decisionStatus: decision,
    decisionNote: notes ?? null,
    actorUserId,
    actorContactId,
    portalTokenId,
  })
  await stampReturnedSubmittal({ orgId, submittal: finalized, finalStepId: stepId, decision })
  return finalized
}

export interface ReviewerQueueEntry {
  step: SubmittalReviewStep
  is_history: boolean
  submittal: Pick<
    Submittal,
    "id" | "submittal_number" | "revision" | "title" | "description" | "spec_section" | "due_date" | "status"
  >
}

/** The reviewer portal's active queue plus that reviewer's returned-step history. */
export async function listReviewStepsForReviewer({
  orgId,
  projectId,
  contactId,
}: {
  orgId: string
  projectId: string
  contactId: string
}): Promise<ReviewerQueueEntry[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("submittal_review_steps")
    .select(
      `
      ${REVIEW_STEP_SELECT},
      submittal:submittals!inner(id, project_id, submittal_number, revision, title, description, spec_section, due_date, status)
      `,
    )
    .eq("org_id", orgId)
    .eq("reviewer_contact_id", contactId)
    .in("status", ["in_review", "returned"])
    .eq("submittal.project_id", projectId)
    .order("created_at", { ascending: true })

  if (error) throw new Error(`Failed to load review queue: ${error.message}`)

  return (data ?? []).map((row: any) => {
    const submittal = Array.isArray(row.submittal) ? row.submittal[0] : row.submittal
    return {
      step: mapReviewStep(row),
      is_history: row.status === "returned",
      submittal: {
        id: submittal.id,
        submittal_number: submittal.submittal_number,
        revision: submittal.revision ?? 0,
        title: submittal.title,
        description: submittal.description ?? null,
        spec_section: submittal.spec_section ?? null,
        due_date: submittal.due_date ?? null,
        status: submittal.status,
      },
    }
  })
}

/** Internal decide path — submittal.route holders decide any step from the workbench. */
export async function decideSubmittalReviewStep({
  input,
  orgId,
}: {
  input: DecideSubmittalReviewStepInput
  orgId?: string
}): Promise<Submittal> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("submittal.route", { supabase, orgId: resolvedOrgId, userId })

  return applyReviewStepDecision({
    orgId: resolvedOrgId,
    stepId: input.step_id,
    decision: input.decision,
    notes: input.notes ?? null,
    markupFileId: input.markup_file_id ?? null,
    actorUserId: userId,
  })
}

/** Emails the newly active step's reviewer (portal link for external seats). */
async function notifyReviewStepAssigned({
  orgId,
  submittalId,
  stepId,
}: {
  orgId: string
  submittalId: string
  stepId: string
}) {
  const supabase = createServiceSupabaseClient()

  const [{ data: step }, { data: submittal }, { data: org }] = await Promise.all([
    supabase
      .from("submittal_review_steps")
      .select("id, reviewer_kind, reviewer_user_id, reviewer_contact_id, reviewer_company_id, role_label, due_date")
      .eq("id", stepId)
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase
      .from("submittals")
      .select("id, project_id, submittal_number, revision, title, description, spec_section, due_date, required_on_site, project:projects(name)")
      .eq("id", submittalId)
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase.from("orgs").select("name, slug, logo_url, document_numbering").eq("id", orgId).maybeSingle(),
  ])

  if (!step || !submittal) return

  let recipient: { email: string; name?: string | null } | null = null
  let actionHref = `${APP_URL}/projects/${submittal.project_id}/submittals`
  let actionLabel = "Open in Arc"
  let audience: "internal" | "reviewer" = "internal"

  if (step.reviewer_kind === "external") {
    if (!step.reviewer_contact_id) return // nothing to notify until a reviewer is assigned
    audience = "reviewer"
    actionHref = await ensureReviewerLink({
      supabase,
      orgId,
      projectId: submittal.project_id,
      contactId: step.reviewer_contact_id,
      companyId: step.reviewer_company_id ?? null,
    })
    const token = actionHref.split("/").filter(Boolean).at(-1)
    if (token) {
      const { data: portalToken } = await supabase.from("portal_access_tokens").select("id").eq("org_id", orgId).eq("token", token).maybeSingle()
      if (portalToken) {
        await supabase.from("submittal_review_steps").update({ portal_token_id: portalToken.id }).eq("org_id", orgId).eq("id", stepId)
      }
    }
    actionLabel = "Open Review Portal"
    const contact = await fetchContactEmail(supabase, step.reviewer_contact_id)
    if (!contact?.email) return
    recipient = { email: contact.email, name: contact.full_name }
  } else {
    if (!step.reviewer_user_id) return
    const user = await fetchUserEmail(supabase, step.reviewer_user_id)
    if (!user?.email) return
    recipient = { email: user.email, name: user.full_name }
  }

  if (!recipient) return

  const formatDateLabel = (value: string | null | undefined) =>
    value
      ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : null

  const project = Array.isArray(submittal.project) ? submittal.project[0] : submittal.project
  const displayNumber = formatDocNumber("submittal", submittal.submittal_number, (org?.document_numbering ?? {}) as DocumentNumberingSettings)
  const numberLabel = (submittal.revision ?? 0) > 0 ? `#${displayNumber} Rev ${submittal.revision}` : `#${displayNumber}`

  const html = await renderEmailTemplate(
    SubmittalNotificationEmail({
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      recipientName: recipient.name ?? null,
      audience,
      projectName: project?.name ?? null,
      submittalNumber: displayNumber,
      revision: submittal.revision ?? 0,
      title: submittal.title,
      description: submittal.description,
      kind: "review_requested",
      specSection: submittal.spec_section,
      dueDate: formatDateLabel(step.due_date ?? submittal.due_date),
      requiredOnSite: formatDateLabel(submittal.required_on_site),
      actionHref,
      actionLabel,
    }),
  )

  await sendEmail({
    to: [recipient.email],
    subject: `Review requested: submittal ${numberLabel} — ${submittal.title}`,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })
}

/**
 * Imprints the review stamp on the submittal's primary document (latest PDF
 * item) as a NEW file version — the sub's original upload survives as the
 * prior version. Stamping failure never blocks the review return; the
 * decision itself is already recorded.
 */
async function stampReturnedSubmittal({
  orgId,
  submittal,
  finalStepId,
  decision,
}: {
  orgId: string
  submittal: Submittal
  finalStepId: string
  decision: SubmittalReviewDecision
}): Promise<void> {
  const supabase = createServiceSupabaseClient()

  try {
    const [{ data: items }, { data: step }, { data: org }, { data: orgSettings }] = await Promise.all([
      supabase
        .from("submittal_items")
        .select("id, file_id, created_at, file:files(id, file_name, mime_type, storage_path)")
        .eq("org_id", orgId)
        .eq("submittal_id", submittal.id)
        .not("file_id", "is", null)
        .order("item_number", { ascending: false }),
      supabase
        .from("submittal_review_steps")
        .select(REVIEW_STEP_SELECT)
        .eq("id", finalStepId)
        .eq("org_id", orgId)
        .maybeSingle(),
      supabase.from("orgs").select("name").eq("id", orgId).maybeSingle(),
      supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle(),
    ])

    const primary = (items ?? [])
      .map((row: any) => ({ ...row, file: Array.isArray(row.file) ? row.file[0] : row.file }))
      .find((row: any) => (row.file?.mime_type ?? "").includes("pdf"))

    if (!primary?.file?.storage_path) return // nothing stampable

    const finalStep = step ? mapReviewStep(step) : null
    const reviewerLine =
      [finalStep?.reviewer_name, finalStep?.role_label].filter(Boolean).join(" — ") ||
      finalStep?.role_label ||
      "Review"

    const disclaimer = ((orgSettings?.settings as Record<string, unknown> | null)?.submittal_stamp_disclaimer ??
      null) as string | null

    const originalBytes = await downloadFilesObject({
      supabase,
      orgId,
      path: primary.file.storage_path,
    })

    const stampedBytes = await applySubmittalReviewStamp({
      pdfBytes: originalBytes,
      orgName: org?.name ?? "Arc",
      decision,
      reviewerLine,
      dateLabel: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      disclaimer,
    })

    const baseName = String(primary.file.file_name ?? "submittal.pdf").replace(/\.pdf$/i, "")
    await createVersionFromBytes({
      orgId,
      fileId: primary.file.id,
      bytes: Buffer.from(stampedBytes),
      fileName: `${baseName} (Stamped).pdf`,
      mimeType: "application/pdf",
      label: "Review stamp",
      notes: `Stamped on return: ${decision.replace(/_/g, " ")}`,
    })

    await supabase
      .from("submittals")
      .update({ stamped_file_id: primary.file.id })
      .eq("id", submittal.id)
      .eq("org_id", orgId)

    await recordEvent({
      orgId,
      eventType: "submittal_stamped",
      entityType: "submittal",
      entityId: submittal.id,
      payload: { file_id: primary.file.id, decision },
    })
  } catch (error) {
    console.warn("Failed to stamp returned submittal", error)
  }
}
