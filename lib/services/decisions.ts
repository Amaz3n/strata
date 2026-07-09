import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { renderEmailTemplate, sendEmail, getOrgSenderEmail } from "@/lib/services/mailer"
import { ensurePortalLink, fetchContactEmail } from "@/lib/services/portal-links"
import { DecisionRequestEmail } from "@/lib/emails/decision-request-email"
import {
  decisionInputSchema,
  decisionUpdateSchema,
  type DecisionInput,
  type DecisionOption,
  type DecisionUpdateInput,
  type PortalDecisionInput,
} from "@/lib/validation/decisions"
import type { Decision } from "@/lib/types"

const DECISION_SELECT =
  "id, org_id, project_id, title, description, status, due_date, options, selected_option_id, decision_note, notify_contact_id, requested_at, approved_at, approved_by, decided_by_contact_id, decided_via_portal, created_at, updated_at"

function mapDecision(row: Record<string, unknown>): Decision {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    project_id: row.project_id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? undefined,
    status: (row.status as string | null) ?? "requested",
    due_date: (row.due_date as string | null) ?? undefined,
    options: (row.options as DecisionOption[] | null) ?? [],
    selected_option_id: (row.selected_option_id as string | null) ?? null,
    decision_note: (row.decision_note as string | null) ?? null,
    notify_contact_id: (row.notify_contact_id as string | null) ?? null,
    requested_at: (row.requested_at as string | null) ?? null,
    approved_at: (row.approved_at as string | null) ?? undefined,
    approved_by: (row.approved_by as string | null) ?? undefined,
    decided_by_contact_id: (row.decided_by_contact_id as string | null) ?? null,
    decided_via_portal: (row.decided_via_portal as boolean | null) ?? false,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string | null) ?? (row.created_at as string),
  }
}

export async function listDecisions(projectId: string, orgId?: string): Promise<Decision[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("decision.read", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("decisions")
    .select(DECISION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load decisions: ${error.message}`)
  }

  return (data ?? []).map(mapDecision)
}

export async function createDecision({
  input,
  orgId,
}: {
  input: DecisionInput
  orgId?: string
}): Promise<Decision> {
  const parsed = decisionInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("decision.write", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("decisions")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      title: parsed.title,
      description: parsed.description ?? null,
      status: parsed.status ?? "requested",
      due_date: parsed.due_date ?? null,
      options: parsed.options ?? [],
      notify_contact_id: parsed.notify_contact_id ?? null,
    })
    .select(DECISION_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create decision: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "decision_created",
    entityType: "decision",
    entityId: data.id as string,
    payload: { project_id: parsed.project_id, title: parsed.title, status: data.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "decision",
    entityId: data.id as string,
    after: data,
  })

  return mapDecision(data)
}

export async function updateDecision({
  decisionId,
  input,
  orgId,
}: {
  decisionId: string
  input: DecisionUpdateInput
  orgId?: string
}): Promise<Decision> {
  const parsed = decisionUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("decision.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("decisions")
    .select(DECISION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", decisionId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Decision not found")
  }

  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }

  if (parsed.title !== undefined) updateData.title = parsed.title
  if (parsed.description !== undefined) updateData.description = parsed.description
  if (parsed.due_date !== undefined) updateData.due_date = parsed.due_date
  if (parsed.options !== undefined) updateData.options = parsed.options
  if (parsed.notify_contact_id !== undefined) updateData.notify_contact_id = parsed.notify_contact_id
  if (parsed.status !== undefined) {
    updateData.status = parsed.status
    if (parsed.status === "approved") {
      updateData.approved_at = new Date().toISOString()
      updateData.approved_by = userId
    } else if (existing.approved_at) {
      updateData.approved_at = null
      updateData.approved_by = null
      updateData.decided_by_contact_id = null
      updateData.decided_via_portal = false
      updateData.selected_option_id = null
    }
  }

  const { data, error } = await supabase
    .from("decisions")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", decisionId)
    .select(DECISION_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update decision: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "decision_updated",
    entityType: "decision",
    entityId: decisionId,
    payload: { project_id: data.project_id, status: data.status, title: data.title },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "decision",
    entityId: decisionId,
    before: existing,
    after: data,
  })

  return mapDecision(data)
}

/**
 * Sends the decision to the client: status → pending, requested_at stamped,
 * email with a portal link where they can approve or decline.
 */
export async function sendDecisionToClient({
  decisionId,
  orgId,
}: {
  decisionId: string
  orgId?: string
}): Promise<Decision> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("decision.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("decisions")
    .select(`${DECISION_SELECT}, project:projects(name, client_id)`)
    .eq("org_id", resolvedOrgId)
    .eq("id", decisionId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Decision not found")
  }
  if (existing.status === "approved" || existing.status === "declined") {
    throw new Error("This decision has already been decided")
  }

  const project = Array.isArray(existing.project) ? existing.project[0] : existing.project
  const contactId = existing.notify_contact_id ?? project?.client_id ?? null
  if (!contactId) {
    throw new Error("No client contact to send this decision to — set a project client or notify contact first")
  }

  const serviceSupabase = createServiceSupabaseClient()
  const contact = await fetchContactEmail(serviceSupabase, contactId)
  if (!contact?.email) {
    throw new Error("The client contact has no email address")
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("decisions")
    .update({ status: "pending", requested_at: now, notify_contact_id: contactId, updated_at: now })
    .eq("org_id", resolvedOrgId)
    .eq("id", decisionId)
    .select(DECISION_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to send decision: ${error?.message}`)
  }

  const portalLink = await ensurePortalLink({
    supabase: serviceSupabase,
    orgId: resolvedOrgId,
    projectId: data.project_id,
    portalType: "client",
    contactId,
    companyId: null,
    createdBy: userId,
    capabilities: { can_submit_selections: true },
    fallbackPath: `/projects/${data.project_id}/decisions`,
  })

  await sendDecisionEmail({
    orgId: resolvedOrgId,
    decision: mapDecision(data),
    kind: "request",
    to: { email: contact.email, name: contact.full_name ?? null },
    actionHref: portalLink.includes("/p/") ? `${portalLink}/decisions` : portalLink,
    projectName: project?.name ?? null,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "decision_sent",
    entityType: "decision",
    entityId: decisionId,
    payload: { project_id: data.project_id, contact_id: contactId },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "decision",
    entityId: decisionId,
    after: { status: "pending", requested_at: now, notify_contact_id: contactId },
  })

  return mapDecision(data)
}

/**
 * Resolves which contact a portal token acts as: the token's own contact, or
 * the project's client for project-level client tokens.
 */
async function resolvePortalContactId({
  orgId,
  projectId,
  contactId,
}: {
  orgId: string
  projectId: string
  contactId?: string | null
}): Promise<string | null> {
  if (contactId) return contactId
  const supabase = createServiceSupabaseClient()
  const { data: project } = await supabase
    .from("projects")
    .select("client_id")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()
  return project?.client_id ?? null
}

export async function listDecisionsForPortal(
  orgId: string,
  projectId: string,
  contactId?: string | null,
): Promise<Decision[]> {
  const supabase = createServiceSupabaseClient()
  const effectiveContactId = await resolvePortalContactId({ orgId, projectId, contactId })

  let query = supabase
    .from("decisions")
    .select(DECISION_SELECT)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "requested")
    .order("created_at", { ascending: false })

  // Scope to the contact the token represents; sent decisions always carry a
  // notify_contact_id, so an unmatched token sees nothing rather than
  // everything.
  query = effectiveContactId ? query.eq("notify_contact_id", effectiveContactId) : query.is("notify_contact_id", null)

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to load decisions: ${error.message}`)
  }

  return (data ?? []).map(mapDecision)
}

/** Client decision from the portal, with full identity capture. */
export async function decideDecisionFromPortal({
  orgId,
  projectId,
  contactId,
  portalTokenId,
  input,
}: {
  orgId: string
  projectId: string
  contactId?: string | null
  portalTokenId?: string | null
  input: PortalDecisionInput
}): Promise<Decision> {
  const supabase = createServiceSupabaseClient()

  const { data: existing, error: existingError } = await supabase
    .from("decisions")
    .select(`${DECISION_SELECT}, project:projects(name)`)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", input.decision_id)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Decision not found")
  }
  if (existing.status !== "pending") {
    throw new Error("This decision is not awaiting your response")
  }

  // The token must represent the contact the decision was sent to.
  const effectiveContactId = await resolvePortalContactId({ orgId, projectId, contactId })
  if (existing.notify_contact_id && existing.notify_contact_id !== effectiveContactId) {
    throw new Error("This decision was sent to a different contact")
  }

  const options = (existing.options as DecisionOption[] | null) ?? []
  if (input.approve && options.length > 0 && !input.selected_option_id) {
    throw new Error("Select an option to approve")
  }
  if (input.selected_option_id && !options.some((option) => option.id === input.selected_option_id)) {
    throw new Error("Unknown option")
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("decisions")
    .update({
      status: input.approve ? "approved" : "declined",
      selected_option_id: input.approve ? (input.selected_option_id ?? null) : null,
      decision_note: input.note ?? null,
      approved_at: input.approve ? now : null,
      approved_by: null,
      decided_by_contact_id: contactId ?? null,
      decided_via_portal: true,
      decision_portal_token_id: portalTokenId ?? null,
      updated_at: now,
    })
    .eq("org_id", orgId)
    .eq("id", input.decision_id)
    .eq("status", "pending")
    .select(DECISION_SELECT)
    .maybeSingle()

  if (error || !data) {
    // The status predicate makes the claim atomic: a concurrent response that
    // landed first leaves zero rows here instead of being overwritten.
    throw new Error(error ? `Failed to record decision: ${error.message}` : "This decision was already decided")
  }

  await recordEvent({
    orgId,
    actorId: contactId ?? null,
    eventType: "decision_decided",
    entityType: "decision",
    entityId: input.decision_id,
    payload: {
      project_id: projectId,
      approved: input.approve,
      selected_option_id: input.selected_option_id ?? null,
      via_portal: true,
    },
  })

  await recordAudit({
    orgId,
    action: "update",
    entityType: "decision",
    entityId: input.decision_id,
    before: existing,
    after: data,
    source: "portal",
  })

  // Notify the project team someone decided.
  const project = Array.isArray(existing.project) ? existing.project[0] : existing.project
  const decision = mapDecision(data)
  const selectedOption = decision.options.find((option) => option.id === decision.selected_option_id)

  const { data: creatorAudit } = await supabase
    .from("audit_log")
    .select("actor_id")
    .eq("org_id", orgId)
    .eq("entity_type", "decision")
    .eq("entity_id", input.decision_id)
    .eq("action", "insert")
    .maybeSingle()

  if (creatorAudit?.actor_id) {
    const { data: creator } = await supabase
      .from("app_users")
      .select("email, full_name")
      .eq("id", creatorAudit.actor_id)
      .maybeSingle()
    if (creator?.email) {
      const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"
      await sendDecisionEmail({
        orgId,
        decision,
        kind: "decided",
        to: { email: creator.email, name: creator.full_name ?? null },
        actionHref: `${APP_URL}/projects/${projectId}/decisions`,
        projectName: project?.name ?? null,
        selectedOptionLabel: selectedOption?.label ?? null,
      })
    }
  }

  return decision
}

function formatCostDelta(cents?: number | null): string | null {
  if (cents == null || cents === 0) return null
  const amount = `$${Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
  return cents > 0 ? `+${amount}` : `-${amount}`
}

async function sendDecisionEmail({
  orgId,
  decision,
  kind,
  to,
  actionHref,
  projectName,
  selectedOptionLabel,
}: {
  orgId: string
  decision: Decision
  kind: "request" | "decided" | "reminder"
  to: { email: string; name: string | null }
  actionHref: string
  projectName: string | null
  selectedOptionLabel?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const { data: org } = await supabase.from("orgs").select("name, slug, logo_url").eq("id", orgId).maybeSingle()

  const dueDate = decision.due_date
    ? new Date(decision.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null

  const html = await renderEmailTemplate(
    DecisionRequestEmail({
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      recipientName: to.name,
      projectName,
      title: decision.title,
      description: decision.description ?? null,
      kind,
      decidedApproved: decision.status === "approved",
      selectedOptionLabel: selectedOptionLabel ?? null,
      note: decision.decision_note ?? null,
      dueDate,
      options: decision.options.map((option) => ({
        label: option.label,
        costDeltaLabel: formatCostDelta(option.cost_delta_cents),
      })),
      actionHref,
      actionLabel: kind === "decided" ? "Open in Arc" : "Review & Decide",
    }),
  )

  const subject =
    kind === "request"
      ? `Decision needed: ${decision.title}`
      : kind === "reminder"
        ? `Reminder — decision due: ${decision.title}`
        : `Decision ${decision.status}: ${decision.title}`

  await sendEmail({
    to: [to.email],
    subject,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })
}
