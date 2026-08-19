import type { SupabaseClient } from "@supabase/supabase-js"

import type { ComplianceDocumentStatus } from "@/lib/types"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import {
  normalizePrequalificationTemplate,
  prequalificationReviewSchema,
  prequalificationSubmissionIssues,
  prequalificationSubmissionSchema,
  prequalificationTemplatesMatch,
  prequalificationWaiverSchema,
  prequalificationTemplateSchema,
  type PrequalificationTemplate,
} from "@/lib/validation/prequalification"
import { getComplianceRules } from "@/lib/services/compliance"

const SELECT =
  "id, org_id, company_id, status, requested_by, requested_at, submitted_at, reviewed_by, reviewed_at, expires_at, single_project_limit_cents, aggregate_limit_cents, emr, bonding_single_cents, bonding_aggregate_cents, years_in_business, annual_revenue_cents, largest_project_cents, trades, references_data, questionnaire, template, invited_at, submitted_by_name, submitted_by_email, review_notes, portal_token_id, created_at, updated_at"

export type PrequalificationStatus =
  | "requested"
  | "submitted"
  | "under_review"
  | "approved"
  | "approved_with_limits"
  | "declined"
  | "expired"
  | "waived"

export type Prequalification = {
  id: string
  org_id: string
  company_id: string
  status: PrequalificationStatus
  requested_by: string | null
  requested_at: string
  submitted_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  expires_at: string | null
  single_project_limit_cents: number | null
  aggregate_limit_cents: number | null
  emr: number | null
  bonding_single_cents: number | null
  bonding_aggregate_cents: number | null
  years_in_business: number | null
  annual_revenue_cents: number | null
  largest_project_cents: number | null
  trades: string[] | null
  references_data: Array<Record<string, unknown>>
  questionnaire: Record<string, unknown>
  /** The program as it stood when this request was issued. */
  template: PrequalificationTemplate
  invited_at: string | null
  submitted_by_name: string | null
  submitted_by_email: string | null
  review_notes: string | null
  portal_token_id: string | null
  created_at: string
  updated_at: string
}

const OPEN_STATUSES: PrequalificationStatus[] = ["requested", "submitted", "under_review"]
const REVIEWABLE_STATUSES: PrequalificationStatus[] = ["requested", "submitted", "under_review"]
/** Statuses that satisfy the commitment and bid gates, and that expiry sweeps. */
const CURRENT_STATUSES: PrequalificationStatus[] = [
  "approved",
  "approved_with_limits",
  "waived",
]

function mapPrequalification(row: Record<string, unknown>): Prequalification {
  return {
    ...(row as unknown as Omit<Prequalification, "template">),
    template: normalizePrequalificationTemplate(row.template),
  }
}

function defaultExpiryDate(validityDays = 365) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + validityDays)
  return date.toISOString().slice(0, 10)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// ============ The org program ============

export async function getPrequalificationTemplateWithClient(
  supabase: SupabaseClient,
  orgId: string,
): Promise<PrequalificationTemplate> {
  const { data, error } = await supabase
    .from("orgs")
    .select("prequalification_template")
    .eq("id", orgId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load prequalification program: ${error.message}`)
  return normalizePrequalificationTemplate(data?.prequalification_template)
}

export async function getPrequalificationTemplate(orgId?: string): Promise<PrequalificationTemplate> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })
  return getPrequalificationTemplateWithClient(supabase, resolvedOrgId)
}

export async function updatePrequalificationTemplate({
  template,
  orgId,
}: {
  template: unknown
  orgId?: string
}): Promise<PrequalificationTemplate> {
  const parsed = prequalificationTemplateSchema.parse(template)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.admin", "billing.manage"], { supabase, orgId: resolvedOrgId, userId })

  const before = await getPrequalificationTemplateWithClient(supabase, resolvedOrgId)
  const payload = normalizePrequalificationTemplate(parsed)

  const { data, error } = await supabase
    .from("orgs")
    .update({ prequalification_template: payload })
    .eq("id", resolvedOrgId)
    .select("prequalification_template")
    .single()
  if (error || !data) throw new Error(`Failed to update prequalification program: ${error?.message}`)

  const after = normalizePrequalificationTemplate(data.prequalification_template)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "org_prequalification_template",
    entityId: resolvedOrgId,
    before: { prequalification_template: before },
    after: { prequalification_template: after },
    source: "settings.compliance",
  })
  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "prequalification_template_updated",
    entityType: "org_prequalification_template",
    entityId: resolvedOrgId,
    channel: "activity",
  }).catch(() => null)

  return after
}

// ============ Reading ============

export async function getLatestPrequalificationWithClient(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
): Promise<Prequalification | null> {
  const { data, error } = await supabase
    .from("prequalifications")
    .select(SELECT)
    .eq("org_id", orgId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to load prequalification: ${error.message}`)
  return data ? mapPrequalification(data) : null
}

export async function getLatestPrequalification(companyId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "directory.read", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })
  return getLatestPrequalificationWithClient(supabase, resolvedOrgId, companyId)
}

export type PrequalificationDocumentSlot = {
  document_type_id: string
  document_type_name: string
  is_required: boolean
  document: {
    id: string
    status: ComplianceDocumentStatus
    file_name: string | null
    expiry_date: string | null
    created_at: string
    /** True when the vendor sent it as part of this prequalification package. */
    from_this_package: boolean
  } | null
}

export type PrequalificationPackage = {
  /** The snapshot for the open request, or the current org program when none is open. */
  template: PrequalificationTemplate
  /** The org program as it stands today, for previews and for resetting a request. */
  orgTemplate: PrequalificationTemplate
  current: Prequalification | null
  history: Prequalification[]
  documents: PrequalificationDocumentSlot[]
  /** Required document slots with nothing approved behind them. */
  missingDocumentCount: number
  /**
   * The open request was issued with an older program than the org now runs.
   * Only ever true before the vendor has answered anything.
   */
  templateOutdated: boolean
  exposure: {
    active_commitment_cents: number
    aggregate_headroom_cents: number | null
  }
  submissionIssues: string[]
}

/**
 * Everything the builder's prequalification tab renders, in one pass.
 *
 * Document slots resolve against the company's real compliance record rather
 * than only what came in through this package — a certificate the vendor
 * already has on file satisfies the requirement instead of asking them to
 * upload the same PDF a second time.
 */
export async function getPrequalificationPackage(
  companyId: string,
  orgId?: string,
): Promise<PrequalificationPackage> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "directory.read", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const [historyResult, orgTemplate, commitmentResult, documentTypesResult] = await Promise.all([
    supabase
      .from("prequalifications")
      .select(SELECT)
      .eq("org_id", resolvedOrgId)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(20),
    getPrequalificationTemplateWithClient(supabase, resolvedOrgId),
    supabase
      .from("commitments")
      .select("total_cents")
      .eq("org_id", resolvedOrgId)
      .eq("company_id", companyId)
      .eq("status", "approved"),
    supabase
      .from("compliance_document_types")
      .select("id, name")
      .eq("org_id", resolvedOrgId)
      .eq("is_active", true),
  ])

  if (historyResult.error) {
    throw new Error(`Failed to load prequalification history: ${historyResult.error.message}`)
  }

  const history = (historyResult.data ?? []).map(mapPrequalification)
  const current = history[0] ?? null
  const template = current ? current.template : orgTemplate

  // Worth offering to re-issue only while the vendor has not answered: once a
  // submission exists, swapping the program would re-label their answers.
  const templateOutdated =
    current?.status === "requested" && !prequalificationTemplatesMatch(current.template, orgTemplate)

  const activeCommitmentCents = (commitmentResult.data ?? []).reduce(
    (sum, row) => sum + Number(row.total_cents ?? 0),
    0,
  )

  const documentTypeNames = new Map(
    (documentTypesResult.data ?? []).map((row) => [String(row.id), String(row.name)]),
  )

  const documents = await resolveDocumentSlots({
    supabase,
    orgId: resolvedOrgId,
    companyId,
    template,
    prequalificationId: current?.id ?? null,
    documentTypeNames,
  })

  // What the vendor still owes against the program they were sent, so the
  // reviewer sees the gaps rather than having to compare two screens.
  const submissionIssues =
    current && current.status !== "requested"
      ? prequalificationSubmissionIssues(template, current)
      : []

  return {
    template,
    orgTemplate,
    current,
    history: history.slice(1),
    documents,
    missingDocumentCount: documents.filter((slot) => slot.is_required && !slot.document).length,
    templateOutdated,
    exposure: {
      active_commitment_cents: activeCommitmentCents,
      aggregate_headroom_cents:
        current?.aggregate_limit_cents != null
          ? current.aggregate_limit_cents - activeCommitmentCents
          : null,
    },
    submissionIssues,
  }
}

async function resolveDocumentSlots({
  supabase,
  orgId,
  companyId,
  template,
  prequalificationId,
  documentTypeNames,
}: {
  supabase: SupabaseClient
  orgId: string
  companyId: string
  template: PrequalificationTemplate
  prequalificationId: string | null
  documentTypeNames: Map<string, string>
}): Promise<PrequalificationDocumentSlot[]> {
  if (template.documents.length === 0) return []

  const typeIds = template.documents.map((entry) => entry.document_type_id)
  const { data, error } = await supabase
    .from("compliance_documents")
    .select("id, document_type_id, status, expiry_date, created_at, prequalification_id, files(file_name)")
    .eq("org_id", orgId)
    .eq("company_id", companyId)
    .in("document_type_id", typeIds)
    .order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to load prequalification documents: ${error.message}`)

  const now = today()
  const rows = data ?? []

  return template.documents.map((entry) => {
    const forType = rows.filter((row) => row.document_type_id === entry.document_type_id)
    // What the vendor sent for this package wins, so the reviewer sees the
    // document they were asked for; otherwise fall back to anything current.
    const linked = forType.find(
      (row) => prequalificationId && row.prequalification_id === prequalificationId,
    )
    const usable =
      linked ??
      forType.find(
        (row) =>
          row.status === "approved" && (!row.expiry_date || String(row.expiry_date) >= now),
      ) ??
      forType.find((row) => row.status === "pending_review") ??
      null

    const file = Array.isArray(usable?.files) ? usable?.files[0] : usable?.files

    return {
      document_type_id: entry.document_type_id,
      document_type_name: documentTypeNames.get(entry.document_type_id) ?? "Document",
      is_required: entry.is_required,
      document: usable
        ? {
            id: String(usable.id),
            status: usable.status as ComplianceDocumentStatus,
            file_name: file ? String(file.file_name) : null,
            expiry_date: usable.expiry_date ? String(usable.expiry_date) : null,
            created_at: String(usable.created_at),
            from_this_package: Boolean(
              prequalificationId && usable.prequalification_id === prequalificationId,
            ),
          }
        : null,
    }
  })
}

// ============ Requesting ============

export async function requestPrequalification(
  companyId: string,
  options: { template?: unknown; orgId?: string } = {},
): Promise<Prequalification> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(options.orgId)
  await requireAnyPermission(["directory.write", "prequal.review"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const { data: company } = await supabase
    .from("companies")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .maybeSingle()
  if (!company) throw new Error("Company not found")

  const latest = await getLatestPrequalificationWithClient(supabase, resolvedOrgId, companyId)
  if (latest && OPEN_STATUSES.includes(latest.status)) return latest

  // Snapshot the program. A later edit to the org template must not re-label
  // answers this vendor already gave, or silently add a question to a request
  // that has already gone out. A caller may hand over a version tailored to
  // this vendor instead of the org default.
  const template =
    options.template === undefined
      ? await getPrequalificationTemplateWithClient(supabase, resolvedOrgId)
      : normalizePrequalificationTemplate(prequalificationTemplateSchema.parse(options.template))

  const { data, error } = await supabase
    .from("prequalifications")
    .insert({
      org_id: resolvedOrgId,
      company_id: companyId,
      status: "requested",
      requested_by: userId,
      template,
    })
    .select(SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to request prequalification: ${error?.message}`)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "prequalification",
    entityId: data.id,
    after: data,
  })
  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "prequalification.requested",
    entityType: "prequalification",
    entityId: data.id,
    channel: "activity",
    payload: { company_id: companyId },
  }).catch(() => null)

  return mapPrequalification(data)
}

/**
 * Changes what an open request asks for.
 *
 * A request snapshots the program so a later edit cannot rewrite what a vendor
 * was asked. That is right once they have answered, but before they start it
 * only strands the request on a stale or ill-fitting program — this is the way
 * to move it, and it is refused the moment a submission exists. Passing null
 * adopts whatever the org program says today.
 */
export async function setPrequalificationRequestTemplate({
  prequalificationId,
  template,
  orgId,
}: {
  prequalificationId: string
  /** Null adopts the current org program. */
  template: unknown | null
  orgId?: string
}): Promise<Prequalification> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["directory.write", "prequal.review"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const { data: existing } = await supabase
    .from("prequalifications")
    .select(SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", prequalificationId)
    .maybeSingle()
  if (!existing) throw new Error("Prequalification not found")
  if (existing.status !== "requested") {
    throw new Error("This request has already been started, so its questions are locked")
  }

  const nextTemplate =
    template === null
      ? await getPrequalificationTemplateWithClient(supabase, resolvedOrgId)
      : normalizePrequalificationTemplate(prequalificationTemplateSchema.parse(template))

  const { data, error } = await supabase
    .from("prequalifications")
    .update({ template: nextTemplate })
    .eq("org_id", resolvedOrgId)
    .eq("id", prequalificationId)
    .select(SELECT)
    .single()
  if (error || !data) {
    throw new Error(`Failed to update the prequalification program: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "prequalification",
    entityId: prequalificationId,
    before: existing,
    after: data,
  })

  return mapPrequalification(data)
}

/**
 * Records that this vendor does not need to prequalify.
 *
 * Waiving replaces an open request rather than sitting beside it, so a vendor
 * is never both being chased and excused at the same time. It satisfies the
 * commitment and bid gates the way an approval does and expires the same way,
 * which is what makes a seasonal waiver safe to grant.
 */
export async function waivePrequalification({
  companyId,
  reason,
  expiresAt,
  orgId,
}: {
  companyId: string
  reason: string
  expiresAt?: string | null
  orgId?: string
}): Promise<Prequalification> {
  const parsed = prequalificationWaiverSchema.parse({ reason, expires_at: expiresAt ?? null })
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("prequal.review", { supabase, orgId: resolvedOrgId, userId })

  const { data: company } = await supabase
    .from("companies")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .maybeSingle()
  if (!company) throw new Error("Company not found")

  const now = new Date().toISOString()
  const existing = await getLatestPrequalificationWithClient(supabase, resolvedOrgId, companyId)
  const patch = {
    status: "waived" as const,
    reviewed_by: userId,
    reviewed_at: now,
    expires_at: parsed.expires_at,
    review_notes: parsed.reason,
    single_project_limit_cents: null,
    aggregate_limit_cents: null,
  }

  const { data, error } =
    existing && OPEN_STATUSES.includes(existing.status)
      ? await supabase
          .from("prequalifications")
          .update(patch)
          .eq("org_id", resolvedOrgId)
          .eq("id", existing.id)
          .select(SELECT)
          .single()
      : await supabase
          .from("prequalifications")
          .insert({
            org_id: resolvedOrgId,
            company_id: companyId,
            requested_by: userId,
            template: {},
            ...patch,
          })
          .select(SELECT)
          .single()

  if (error || !data) throw new Error(`Failed to waive prequalification: ${error?.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "prequalification.waived",
    entityType: "prequalification",
    entityId: data.id,
    channel: "activity",
    payload: { company_id: companyId, expires_at: parsed.expires_at },
  }).catch(() => null)
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: existing && OPEN_STATUSES.includes(existing.status) ? "update" : "insert",
    entityType: "prequalification",
    entityId: data.id,
    before: existing ?? undefined,
    after: data,
  })

  return mapPrequalification(data)
}

/** Records that an invitation carrying a portal link went out for this request. */
export async function markPrequalificationInvited({
  supabase,
  orgId,
  prequalificationId,
  portalTokenId,
}: {
  supabase: SupabaseClient
  orgId: string
  prequalificationId: string
  portalTokenId: string | null
}): Promise<void> {
  const { error } = await supabase
    .from("prequalifications")
    .update({ invited_at: new Date().toISOString(), portal_token_id: portalTokenId })
    .eq("org_id", orgId)
    .eq("id", prequalificationId)
  if (error) throw new Error(`Failed to record prequalification invite: ${error.message}`)
}

// ============ Vendor submission ============

export async function submitPrequalificationFromPortal(args: {
  supabase: SupabaseClient
  orgId: string
  companyId: string
  portalTokenId: string
  input: unknown
}): Promise<Prequalification> {
  const parsed = prequalificationSubmissionSchema.parse(args.input)
  const latest = await getLatestPrequalificationWithClient(args.supabase, args.orgId, args.companyId)
  if (!latest || !["requested", "submitted"].includes(latest.status)) {
    throw new Error("No open prequalification request")
  }

  // The snapshot decides what complete means. Checking it here as well as in the
  // form means a hand-rolled POST cannot skip a mandatory question.
  const issues = prequalificationSubmissionIssues(latest.template, parsed)
  if (issues.length > 0) throw new Error(issues.join(". "))

  const now = new Date().toISOString()
  const { data, error } = await args.supabase
    .from("prequalifications")
    .update({
      years_in_business: parsed.years_in_business ?? null,
      annual_revenue_cents: parsed.annual_revenue_cents ?? null,
      largest_project_cents: parsed.largest_project_cents ?? null,
      emr: parsed.emr ?? null,
      bonding_single_cents: parsed.bonding_single_cents ?? null,
      bonding_aggregate_cents: parsed.bonding_aggregate_cents ?? null,
      trades: parsed.trades,
      references_data: parsed.references_data,
      questionnaire: parsed.questionnaire,
      submitted_by_name: parsed.submitted_by_name || null,
      submitted_by_email: parsed.submitted_by_email || null,
      status: "under_review",
      submitted_at: now,
      portal_token_id: args.portalTokenId,
    })
    .eq("org_id", args.orgId)
    .eq("id", latest.id)
    .select(SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to submit prequalification: ${error?.message}`)

  await recordEvent({
    orgId: args.orgId,
    eventType: "prequalification.submitted",
    entityType: "prequalification",
    entityId: latest.id,
    channel: "notification",
    payload: { company_id: args.companyId, requested_by: latest.requested_by },
  })

  return mapPrequalification(data)
}

// ============ Review ============

export async function reviewPrequalification(
  prequalificationId: string,
  input: unknown,
  orgId?: string,
): Promise<Prequalification> {
  const parsed = prequalificationReviewSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("prequal.review", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("prequalifications")
    .select(SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", prequalificationId)
    .maybeSingle()
  if (!existing) throw new Error("Prequalification not found")
  if (!REVIEWABLE_STATUSES.includes(existing.status as PrequalificationStatus)) {
    throw new Error("This prequalification has already been decided")
  }

  const now = new Date().toISOString()
  const rules = await getComplianceRules(resolvedOrgId)
  const expiresAt =
    parsed.decision === "declined"
      ? null
      : (parsed.expires_at ?? defaultExpiryDate(rules.prequalification_validity_days))

  const { data, error } = await supabase
    .from("prequalifications")
    .update({
      status: parsed.decision,
      reviewed_by: userId,
      reviewed_at: now,
      expires_at: expiresAt,
      single_project_limit_cents: parsed.single_project_limit_cents ?? null,
      aggregate_limit_cents: parsed.aggregate_limit_cents ?? null,
      review_notes: parsed.review_notes ?? null,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", prequalificationId)
    .select(SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to review prequalification: ${error?.message}`)

  const approved = parsed.decision === "approved" || parsed.decision === "approved_with_limits"
  const { error: companyError } = await supabase
    .from("companies")
    .update({ prequalified: approved, prequalified_at: approved ? now : null })
    .eq("org_id", resolvedOrgId)
    .eq("id", existing.company_id)
  if (companyError) {
    throw new Error(`Failed to update company prequalification: ${companyError.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: approved ? "prequalification.approved" : "prequalification.declined",
    entityType: "prequalification",
    entityId: prequalificationId,
    channel: "notification",
    payload: { company_id: existing.company_id, status: parsed.decision },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "prequalification",
    entityId: prequalificationId,
    before: existing,
    after: data,
  })

  return mapPrequalification(data)
}

// ============ Expiry ============

export async function expirePrequalificationsWithClient(
  supabase: SupabaseClient,
  orgId: string,
  todayKey: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("prequalifications")
    .select("id, company_id")
    .eq("org_id", orgId)
    .in("status", CURRENT_STATUSES)
    .lt("expires_at", todayKey)
  if (error) throw new Error(`Failed to find expired prequalifications: ${error.message}`)
  if (!data?.length) return 0

  const ids = data.map((row) => row.id)
  const companyIds = Array.from(new Set(data.map((row) => row.company_id)))

  const { error: updateError } = await supabase
    .from("prequalifications")
    .update({ status: "expired" })
    .eq("org_id", orgId)
    .in("id", ids)
  if (updateError) throw new Error(`Failed to expire prequalifications: ${updateError.message}`)

  await supabase
    .from("companies")
    .update({ prequalified: false, prequalified_at: null })
    .eq("org_id", orgId)
    .in("id", companyIds)

  for (const row of data) {
    await recordEvent({
      orgId,
      eventType: "prequalification.expired",
      entityType: "prequalification",
      entityId: row.id,
      channel: "notification",
      payload: { company_id: row.company_id },
    }).catch(() => null)
  }
  return data.length
}

// ============ Enforcement ============

export async function getCompanyPrequalificationWarning(args: {
  companyId: string | null
  commitmentTotalCents?: number
  excludeCommitmentId?: string
  orgId?: string
}): Promise<string | null> {
  if (!args.companyId) return "No vendor company is assigned; prequalification could not be checked."
  const latest = await getLatestPrequalification(args.companyId, args.orgId)
  if (!latest || !CURRENT_STATUSES.includes(latest.status)) {
    return "Vendor does not have a current approved prequalification."
  }
  if (latest.expires_at && latest.expires_at < today()) {
    return "Vendor prequalification has expired."
  }
  if (
    args.commitmentTotalCents != null &&
    latest.single_project_limit_cents != null &&
    args.commitmentTotalCents > latest.single_project_limit_cents
  ) {
    return `Commitment exceeds the vendor's single-project prequalification limit by $${(
      (args.commitmentTotalCents - latest.single_project_limit_cents) / 100
    ).toLocaleString("en-US")}.`
  }
  if (args.commitmentTotalCents != null && latest.aggregate_limit_cents != null) {
    const { supabase, orgId } = await requireOrgContext(args.orgId)
    let query = supabase
      .from("commitments")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("company_id", args.companyId)
      .eq("status", "approved")
    if (args.excludeCommitmentId) query = query.neq("id", args.excludeCommitmentId)
    const { data, error } = await query
    if (error) throw new Error(`Failed to check aggregate prequalification capacity: ${error.message}`)
    const activeTotal = (data ?? []).reduce((sum, commitment) => sum + Number(commitment.total_cents ?? 0), 0)
    const resultingTotal = activeTotal + args.commitmentTotalCents
    if (resultingTotal > latest.aggregate_limit_cents) {
      return `Commitments exceed the vendor's aggregate prequalification limit by $${(
        (resultingTotal - latest.aggregate_limit_cents) / 100
      ).toLocaleString("en-US")}.`
    }
  }
  return null
}

export async function getBidInvitePrequalificationWarnings(
  companyIds: string[],
  orgId?: string,
): Promise<Map<string, string>> {
  if (companyIds.length === 0) return new Map()
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const uniqueIds = Array.from(new Set(companyIds))
  const { data, error } = await supabase
    .from("prequalifications")
    .select("company_id, status, expires_at, created_at")
    .eq("org_id", resolvedOrgId)
    .in("company_id", uniqueIds)
    .order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to check bid invite prequalification: ${error.message}`)

  const latestByCompany = new Map<string, { status: string; expires_at: string | null }>()
  for (const row of data ?? []) {
    if (!latestByCompany.has(row.company_id)) latestByCompany.set(row.company_id, row)
  }
  const todayKey = today()
  const warnings = new Map<string, string>()
  for (const companyId of uniqueIds) {
    const latest = latestByCompany.get(companyId)
    if (!latest || !CURRENT_STATUSES.includes(latest.status as PrequalificationStatus)) {
      warnings.set(companyId, "Vendor does not have a current approved prequalification.")
    } else if (latest.expires_at && latest.expires_at < todayKey) {
      warnings.set(companyId, "Vendor prequalification has expired.")
    }
  }
  return warnings
}

export type PrequalificationGlance = {
  status: PrequalificationStatus
  expires_at: string | null
}

/**
 * Latest prequalification per company for list surfaces. One query for the whole
 * page — the directory renders hundreds of rows and cannot afford a lookup each.
 */
export async function getCompaniesPrequalificationSummary(
  companyIds: string[],
  orgId?: string,
): Promise<Record<string, PrequalificationGlance>> {
  if (companyIds.length === 0) return {}
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "directory.read", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const { data, error } = await supabase
    .from("prequalifications")
    .select("company_id, status, expires_at, created_at")
    .eq("org_id", resolvedOrgId)
    .in("company_id", Array.from(new Set(companyIds)))
    .order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to load prequalification summary: ${error.message}`)

  const byCompany: Record<string, PrequalificationGlance> = {}
  for (const row of data ?? []) {
    if (byCompany[row.company_id]) continue
    byCompany[row.company_id] = {
      status: row.status as PrequalificationStatus,
      expires_at: row.expires_at ? String(row.expires_at) : null,
    }
  }
  return byCompany
}
