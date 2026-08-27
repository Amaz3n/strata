import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  ComplianceDocument,
  ComplianceDocumentType,
  ComplianceRequirementDeficiency,
  ComplianceRequirement,
  ComplianceRequirementState,
  ComplianceRequirementStatus,
  ComplianceRequirementWaiver,
  ComplianceStatusSummary,
} from "@/lib/types"
import {
  complianceDocTypeInputSchema,
  complianceDocumentFiltersSchema,
  complianceDocumentRequestSchema,
  complianceDocumentUploadSchema,
  complianceRequirementInputSchema,
  complianceRequirementWaiverInputSchema,
  complianceRequirementWaiverRevokeSchema,
  complianceRequirementsBulkWaiverSchema,
  complianceReviewDecisionSchema,
  complianceRevokeDecisionSchema,
  type ComplianceDocTypeInput,
  type ComplianceDocumentFilters,
  type ComplianceDocumentRequestInput,
  type ComplianceDocumentUploadInput,
  type ComplianceRequirementInput,
  type ComplianceRequirementWaiverInput,
  type ComplianceRequirementWaiverRevokeInput,
  type ComplianceRequirementsBulkWaiverInput,
  type ComplianceReviewDecision,
  type ComplianceRevokeDecisionInput,
} from "@/lib/validation/compliance-documents"
import {
  coiExtractionSchema,
  isInsuranceDocumentTypeName,
  type CoiExtraction,
} from "@/lib/payments/ap-verification"
// The pure policy module, not the hold service: the hold service reads this one
// for a vendor's status, and importing it back would close the cycle.
import { parsePaymentHoldPolicy } from "@/lib/payments/payment-hold-policy"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { sendComplianceAutopilotEmail, sendComplianceDecisionEmail } from "@/lib/services/mailer"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { findExistingCompanyPortalToken } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Hand an insurance certificate to the reader, out of band.
 *
 * Opportunistic in both directions: extraction never blocks the upload or the
 * review, and a job that never runs costs nothing — the payment hold keeps
 * evaluating on the expiry a human recorded, exactly as it did before any
 * certificate was read. Deduped on the file, so uploading and then approving
 * the same certificate reads it once.
 *
 * The document type's `kind` decides this now. Matching on the name used to
 * mean a type called "Professional license" was read as an insurance
 * certificate; `isInsuranceDocumentTypeName` remains only for legacy rows whose
 * kind was never classified.
 */
async function enqueueCoiExtraction(params: {
  orgId: string
  fileId: string | null | undefined
  documentId: string
  documentType: { name?: string | null; code?: string | null; kind?: string | null } | null | undefined
}) {
  if (!params.fileId) return
  const kind = params.documentType?.kind
  const isInsurance =
    kind === "insurance" ||
    // `other` is also what an unclassified legacy row reads as, so the name
    // check still earns its place — without it, a type nobody has categorised
    // silently stops having its certificate read.
    ((!kind || kind === "other") &&
      (isInsuranceDocumentTypeName(params.documentType?.name) ||
        isInsuranceDocumentTypeName(params.documentType?.code)))
  if (!isInsurance) return
  await enqueueOutboxJob({
    orgId: params.orgId,
    jobType: "extract_coi_facts",
    payload: { file_id: params.fileId, compliance_document_id: params.documentId },
    dedupeByPayloadKeys: ["file_id"],
  })
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ============ Mappers ============

function mapDocumentType(row: any): ComplianceDocumentType {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    code: row.code,
    kind: row.kind ?? "other",
    description: row.description ?? undefined,
    has_expiry: row.has_expiry,
    expiry_warning_days: row.expiry_warning_days,
    is_system: row.is_system,
    is_active: row.is_active,
    created_at: row.created_at,
  }
}

function mapRequirement(row: any): ComplianceRequirement {
  return {
    id: row.id,
    org_id: row.org_id,
    company_id: row.company_id,
    document_type_id: row.document_type_id,
    document_type: row.compliance_document_types
      ? mapDocumentType(row.compliance_document_types)
      : undefined,
    source: row.source ?? "company_override",
    waiver: row.waiver ?? null,
    is_required: row.is_required,
    min_coverage_cents: row.min_coverage_cents ?? undefined,
    requires_additional_insured: row.requires_additional_insured ?? false,
    requires_primary_noncontributory: row.requires_primary_noncontributory ?? false,
    requires_waiver_of_subrogation: row.requires_waiver_of_subrogation ?? false,
    notes: row.notes ?? undefined,
    created_at: row.created_at,
    created_by: row.created_by ?? undefined,
    project_id: row.project_id ?? undefined,
    project_name: row.projects?.name ?? undefined,
  }
}

function mapWaiver(row: any): ComplianceRequirementWaiver {
  return {
    id: row.id,
    org_id: row.org_id,
    company_id: row.company_id,
    document_type_id: row.document_type_id,
    reason: row.reason ?? undefined,
    expires_at: row.expires_at ?? undefined,
    waived_by: row.waived_by ?? undefined,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? undefined,
    revoked_by: row.revoked_by ?? undefined,
    revoke_reason: row.revoke_reason ?? undefined,
  }
}

function mapDocument(row: any): ComplianceDocument {
  return {
    id: row.id,
    org_id: row.org_id,
    company_id: row.company_id,
    document_type_id: row.document_type_id,
    document_type: row.compliance_document_types
      ? mapDocumentType(row.compliance_document_types)
      : undefined,
    requirement_id: row.requirement_id ?? undefined,
    file_id: row.file_id ?? undefined,
    file: row.files
      ? {
          id: row.files.id,
          org_id: row.files.org_id,
          project_id: row.files.project_id,
          file_name: row.files.file_name,
          storage_path: row.files.storage_path,
          mime_type: row.files.mime_type,
          size_bytes: row.files.size_bytes,
          visibility: row.files.visibility,
          created_at: row.files.created_at,
        }
      : undefined,
    status: row.status,
    effective_date: row.effective_date ?? undefined,
    expiry_date: row.expiry_date ?? undefined,
    policy_number: row.policy_number ?? undefined,
    coverage_amount_cents: row.coverage_amount_cents ?? undefined,
    carrier_name: row.carrier_name ?? undefined,
    additional_insured: row.additional_insured ?? false,
    primary_noncontributory: row.primary_noncontributory ?? false,
    waiver_of_subrogation: row.waiver_of_subrogation ?? false,
    license_number: row.license_number ?? undefined,
    license_jurisdiction: row.license_jurisdiction ?? undefined,
    license_classification: row.license_classification ?? undefined,
    reviewed_by: row.reviewed_by ?? undefined,
    reviewed_at: row.reviewed_at ?? undefined,
    review_notes: row.review_notes ?? undefined,
    rejection_reason: row.rejection_reason ?? undefined,
    revoked_at: row.revoked_at ?? undefined,
    revoked_by: row.revoked_by ?? undefined,
    revoke_reason: row.revoke_reason ?? undefined,
    superseded_by_id: row.superseded_by_id ?? undefined,
    submitted_via_portal: row.submitted_via_portal,
    portal_token_id: row.portal_token_id ?? undefined,
    extraction: mapExtraction(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * The certificate reading the extraction pipeline left on the document, shaped
 * for the reviewer. Anything malformed reads as no reading at all — a bad parse
 * must never present itself as fact.
 */
function mapExtraction(metadata: unknown): CoiExtraction | null {
  if (!metadata || typeof metadata !== "object") return null
  const parsed = coiExtractionSchema.safeParse((metadata as Record<string, unknown>).coi_extraction)
  return parsed.success ? parsed.data : null
}

// ============ Document Types ============

export async function listComplianceDocumentTypes(
  orgId?: string
): Promise<ComplianceDocumentType[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("compliance_document_types")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("is_active", true)
    .order("is_system", { ascending: false })
    .order("name", { ascending: true })

  if (error) {
    throw new Error(`Failed to list compliance document types: ${error.message}`)
  }

  return (data ?? []).map(mapDocumentType)
}

export async function createComplianceDocumentType({
  input,
  orgId,
}: {
  input: ComplianceDocTypeInput
  orgId?: string
}): Promise<ComplianceDocumentType> {
  const parsed = complianceDocTypeInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("compliance_document_types")
    .insert({
      org_id: resolvedOrgId,
      name: parsed.name,
      code: parsed.code,
      kind: parsed.kind,
      description: parsed.description ?? null,
      has_expiry: parsed.has_expiry,
      expiry_warning_days: parsed.expiry_warning_days,
      is_system: false,
      is_active: true,
    })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create compliance document type: ${error?.message}`)
  }

  return mapDocumentType(data)
}

// ============ Requirements ============

export async function getCompanyRequirements(
  companyId: string,
  orgId?: string
): Promise<ComplianceRequirement[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("company_compliance_requirements")
    .select(
      `
      *,
      compliance_document_types (*)
    `
    )
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`Failed to get company requirements: ${error.message}`)
  }

  return (data ?? []).map(mapRequirement)
}

/**
 * Pause or resume compliance as one vendor-level decision.
 *
 * Requirements, waivers, documents, and their history are deliberately left
 * untouched. Resuming therefore restores the exact record that was paused.
 */
export async function setCompanyComplianceMonitoring({
  companyId,
  enabled,
  orgId,
}: {
  companyId: string
  enabled: boolean
  orgId?: string
}): Promise<{ companyId: string; enabled: boolean }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("companies")
    .select("id, compliance_monitoring_enabled")
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .maybeSingle()

  if (existingError || !existing) throw new Error("Company not found")

  const { data, error } = await supabase
    .from("companies")
    .update({
      compliance_monitoring_enabled: enabled,
      compliance_monitoring_updated_at: new Date().toISOString(),
      compliance_monitoring_updated_by: userId,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .select("id, compliance_monitoring_enabled")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update compliance monitoring: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "company_compliance_monitoring",
    entityId: companyId,
    before: { enabled: existing.compliance_monitoring_enabled ?? false },
    after: { enabled: data.compliance_monitoring_enabled },
    source: "directory.compliance.monitoring",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: enabled ? "compliance_monitoring_resumed" : "compliance_monitoring_paused",
    entityType: "company",
    entityId: companyId,
    payload: { enabled },
  })

  return { companyId, enabled: Boolean(data.compliance_monitoring_enabled) }
}

export async function setCompanyRequirements({
  companyId,
  requirements,
  orgId,
}: {
  companyId: string
  requirements: ComplianceRequirementInput[]
  orgId?: string
}): Promise<ComplianceRequirement[]> {
  const parsedRequirements = requirements.map((r) =>
    complianceRequirementInputSchema.parse(r)
  )
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", { supabase, orgId: resolvedOrgId, userId })

  // A diff, never delete-then-insert. The old shape emptied the table first, so
  // a failed insert — or a concurrent edit landing in the gap — left the vendor
  // with no requirements at all, which reads as "compliant" and releases every
  // held payable.
  const { data: existingRows, error: existingError } = await supabase
    .from("company_compliance_requirements")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)

  if (existingError) {
    throw new Error(`Failed to load company requirements: ${existingError.message}`)
  }

  const existingByTypeId = new Map(
    (existingRows ?? []).map((row: any) => [row.document_type_id as string, row])
  )
  const desiredByTypeId = new Map(parsedRequirements.map((r) => [r.document_type_id, r]))

  const toFields = (r: ComplianceRequirementInput) => ({
    is_required: r.is_required,
    min_coverage_cents: r.min_coverage_cents ?? null,
    requires_additional_insured: r.requires_additional_insured ?? false,
    requires_primary_noncontributory: r.requires_primary_noncontributory ?? false,
    requires_waiver_of_subrogation: r.requires_waiver_of_subrogation ?? false,
    notes: r.notes ?? null,
  })

  const inserts = parsedRequirements
    .filter((r) => !existingByTypeId.has(r.document_type_id))
    .map((r) => ({
      org_id: resolvedOrgId,
      company_id: companyId,
      document_type_id: r.document_type_id,
      created_by: userId,
      ...toFields(r),
    }))

  const updates = parsedRequirements
    .filter((r) => existingByTypeId.has(r.document_type_id))
    .map((r) => ({ id: existingByTypeId.get(r.document_type_id).id as string, fields: toFields(r) }))

  const removedIds = (existingRows ?? [])
    .filter((row: any) => !desiredByTypeId.has(row.document_type_id))
    .map((row: any) => row.id as string)

  if (inserts.length > 0) {
    const { error } = await supabase.from("company_compliance_requirements").insert(inserts)
    if (error) throw new Error(`Failed to add company requirements: ${error.message}`)
  }

  for (const update of updates) {
    const { error } = await supabase
      .from("company_compliance_requirements")
      .update(update.fields)
      .eq("org_id", resolvedOrgId)
      .eq("id", update.id)
    if (error) throw new Error(`Failed to update company requirements: ${error.message}`)
  }

  // Removals go last, so the window where a requirement is absent only ever
  // exists after everything that must survive is already in place.
  if (removedIds.length > 0) {
    const { error } = await supabase
      .from("company_compliance_requirements")
      .delete()
      .eq("org_id", resolvedOrgId)
      .in("id", removedIds)
    if (error) throw new Error(`Failed to remove company requirements: ${error.message}`)
  }

  const { data, error } = await supabase
    .from("company_compliance_requirements")
    .select(
      `
      *,
      compliance_document_types (*)
    `
    )
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`Failed to set company requirements: ${error.message}`)
  }

  const after = (data ?? []).map(mapRequirement)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "company_compliance_requirements",
    entityId: companyId,
    before: { requirements: existingRows ?? [] },
    after: { requirements: data ?? [] },
    source: "directory.compliance",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "compliance_requirements_updated",
    entityType: "company",
    entityId: companyId,
    payload: {
      requirement_count: after.length,
      added: inserts.length,
      updated: updates.length,
      removed: removedIds.length,
    },
  })

  return after
}

// ============ Requirement Waivers ============

export async function waiveCompanyRequirement({
  companyId,
  input,
  orgId,
}: {
  companyId: string
  input: ComplianceRequirementWaiverInput
  orgId?: string
}): Promise<ComplianceRequirementWaiver> {
  const parsed = complianceRequirementWaiverInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: company } = await supabase
    .from("companies")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .maybeSingle()

  if (!company) {
    throw new Error("Company not found")
  }

  const { data: documentType } = await supabase
    .from("compliance_document_types")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.document_type_id)
    .maybeSingle()

  if (!documentType) {
    throw new Error("Compliance document type not found")
  }

  await supabase
    .from("company_compliance_requirement_waivers")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: userId,
      revoke_reason: "Replaced by a newer waiver.",
    })
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)
    .eq("document_type_id", parsed.document_type_id)
    .is("revoked_at", null)

  const { data, error } = await supabase
    .from("company_compliance_requirement_waivers")
    .insert({
      org_id: resolvedOrgId,
      company_id: companyId,
      document_type_id: parsed.document_type_id,
      reason: parsed.reason ?? null,
      expires_at: parsed.expires_at ?? null,
      waived_by: userId,
    })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to waive compliance requirement: ${error?.message}`)
  }

  // A waiver releases a payment hold. It belongs on the audit trail beside the
  // override that would otherwise have been needed to move the same money.
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "compliance_requirement_waiver",
    entityId: data.id,
    after: data,
    source: "directory.compliance",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "compliance_requirement_waived",
    entityType: "company",
    entityId: companyId,
    payload: {
      document_type_id: parsed.document_type_id,
      expires_at: parsed.expires_at ?? null,
    },
  })

  return mapWaiver(data)
}

export async function revokeCompanyRequirementWaiver({
  waiverId,
  input,
  orgId,
}: {
  waiverId: string
  input?: ComplianceRequirementWaiverRevokeInput
  orgId?: string
}): Promise<ComplianceRequirementWaiver> {
  const parsed = complianceRequirementWaiverRevokeSchema.parse(input ?? {})
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("company_compliance_requirement_waivers")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", waiverId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Compliance waiver not found")
  }

  const { data, error } = await supabase
    .from("company_compliance_requirement_waivers")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: userId,
      revoke_reason: parsed.reason ?? null,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", waiverId)
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to revoke compliance waiver: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "compliance_requirement_waiver",
    entityId: waiverId,
    before: existing,
    after: data,
    source: "directory.compliance",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "compliance_requirement_waiver_revoked",
    entityType: "company",
    entityId: existing.company_id,
    payload: { document_type_id: existing.document_type_id },
  })

  return mapWaiver(data)
}

/**
 * Exempt a vendor from every standing requirement in one audited operation.
 *
 * This deliberately targets company requirements only. Project overlays are
 * job-specific owner/contract obligations and remain visible to the project
 * payment gate; the nightly autopilot only chases standing company rules.
 */
export async function waiveAllCompanyRequirements({
  companyId,
  input,
  orgId,
}: {
  companyId: string
  input: ComplianceRequirementsBulkWaiverInput
  orgId?: string
}): Promise<ComplianceRequirementWaiver[]> {
  const parsed = complianceRequirementsBulkWaiverSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", { supabase, orgId: resolvedOrgId, userId })

  const [companyResult, requirementsResult, waiversResult] = await Promise.all([
    supabase.from("companies").select("id").eq("org_id", resolvedOrgId).eq("id", companyId).maybeSingle(),
    supabase
      .from("company_compliance_requirements")
      .select("document_type_id")
      .eq("org_id", resolvedOrgId)
      .eq("company_id", companyId)
      .eq("is_required", true),
    supabase
      .from("company_compliance_requirement_waivers")
      .select("document_type_id, expires_at, revoked_at")
      .eq("org_id", resolvedOrgId)
      .eq("company_id", companyId)
      .is("revoked_at", null),
  ])

  if (companyResult.error || !companyResult.data) throw new Error("Company not found")
  if (requirementsResult.error) {
    throw new Error(`Failed to load compliance requirements: ${requirementsResult.error.message}`)
  }
  if (waiversResult.error) {
    throw new Error(`Failed to load compliance waivers: ${waiversResult.error.message}`)
  }

  const today = new Date().toISOString().slice(0, 10)
  const activelyWaivedTypeIds = new Set(
    (waiversResult.data ?? [])
      .filter((waiver: any) => !waiver.expires_at || waiver.expires_at >= today)
      .map((waiver: any) => waiver.document_type_id as string),
  )
  const expiredWaiverTypeIds = (waiversResult.data ?? [])
    .filter((waiver: any) => waiver.expires_at && waiver.expires_at < today)
    .map((waiver: any) => waiver.document_type_id as string)
  if (expiredWaiverTypeIds.length > 0) {
    const { error } = await supabase
      .from("company_compliance_requirement_waivers")
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: userId,
        revoke_reason: "Replaced by a permanent bulk waiver.",
      })
      .eq("org_id", resolvedOrgId)
      .eq("company_id", companyId)
      .is("revoked_at", null)
      .in("document_type_id", expiredWaiverTypeIds)
    if (error) throw new Error(`Failed to replace expired compliance waivers: ${error.message}`)
  }
  const rows = (requirementsResult.data ?? [])
    .filter((requirement: any) => !activelyWaivedTypeIds.has(requirement.document_type_id))
    .map((requirement: any) => ({
      org_id: resolvedOrgId,
      company_id: companyId,
      document_type_id: requirement.document_type_id,
      reason: parsed.reason,
      expires_at: null,
      waived_by: userId,
    }))

  let created: any[] = []
  if (rows.length > 0) {
    const { data, error } = await supabase
      .from("company_compliance_requirement_waivers")
      .insert(rows)
      .select("*")
    if (error) throw new Error(`Failed to waive compliance requirements: ${error.message}`)
    created = data ?? []
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "compliance_requirement_waiver",
    entityId: companyId,
    after: { reason: parsed.reason, document_type_ids: created.map((row) => row.document_type_id) },
    source: "directory.compliance.bulk_waiver",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "compliance_requirements_waived",
    entityType: "company",
    entityId: companyId,
    payload: { requirement_count: created.length },
  })

  return created.map(mapWaiver)
}

// ============ Documents ============

/**
 * The fact columns a document carries, from either upload path or from a
 * reviewer's corrections. Kept in one place so the builder form, the portal
 * form and the review dialog can never write a different subset.
 */
function documentFactColumns(input: Partial<ComplianceDocumentUploadInput>) {
  return {
    effective_date: input.effective_date ?? null,
    expiry_date: input.expiry_date ?? null,
    policy_number: input.policy_number ?? null,
    coverage_amount_cents: input.coverage_amount_cents ?? null,
    carrier_name: input.carrier_name ?? null,
    additional_insured: input.additional_insured ?? false,
    primary_noncontributory: input.primary_noncontributory ?? false,
    waiver_of_subrogation: input.waiver_of_subrogation ?? false,
    license_number: input.license_number ?? null,
    license_jurisdiction: input.license_jurisdiction ?? null,
    license_classification: input.license_classification ?? null,
  }
}

/**
 * Point every earlier submission for this requirement at the one that replaced
 * it. The old rows stay readable as history; they simply stop being the answer.
 *
 * Best-effort: a document that fails to be marked superseded is still outranked
 * by the newer one at read time, so this improves the record rather than
 * deciding anything.
 */
async function supersedePriorDocuments(params: {
  supabase: SupabaseClient
  orgId: string
  companyId: string
  documentTypeId: string
  newDocumentId: string
}) {
  await params.supabase
    .from("compliance_documents")
    .update({ superseded_by_id: params.newDocumentId })
    .eq("org_id", params.orgId)
    .eq("company_id", params.companyId)
    .eq("document_type_id", params.documentTypeId)
    .neq("id", params.newDocumentId)
    .is("superseded_by_id", null)
}

export async function listComplianceDocuments(
  filters?: ComplianceDocumentFilters,
  orgId?: string
): Promise<ComplianceDocument[]> {
  const parsedFilters = complianceDocumentFiltersSchema.parse(filters ?? {}) ?? {}
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  let query = supabase
    .from("compliance_documents")
    .select(
      `
      *,
      compliance_document_types (*),
      files (id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at)
    `
    )
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (parsedFilters.company_id) {
    query = query.eq("company_id", parsedFilters.company_id)
  }
  if (parsedFilters.status) {
    query = query.eq("status", parsedFilters.status)
  }
  if (parsedFilters.document_type_id) {
    query = query.eq("document_type_id", parsedFilters.document_type_id)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list compliance documents: ${error.message}`)
  }

  return (data ?? []).map(mapDocument)
}

export async function getComplianceDocument(
  documentId: string,
  orgId?: string
): Promise<ComplianceDocument> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("compliance_documents")
    .select(
      `
      *,
      compliance_document_types (*),
      files (id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at)
    `
    )
    .eq("org_id", resolvedOrgId)
    .eq("id", documentId)
    .maybeSingle()

  if (error || !data) {
    throw new Error("Compliance document not found")
  }

  return mapDocument(data)
}

export async function uploadComplianceDocument({
  companyId,
  input,
  fileId,
  prequalificationId,
  orgId,
}: {
  companyId: string
  input: ComplianceDocumentUploadInput
  fileId: string
  /** Set when the document arrived as part of a prequalification package. */
  prequalificationId?: string | null
  orgId?: string
}): Promise<ComplianceDocument> {
  const parsed = complianceDocumentUploadSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", { supabase, orgId: resolvedOrgId, userId })

  // Find matching requirement if exists
  const { data: requirement } = await supabase
    .from("company_compliance_requirements")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)
    .eq("document_type_id", parsed.document_type_id)
    .maybeSingle()

  const { data, error } = await supabase
    .from("compliance_documents")
    .insert({
      org_id: resolvedOrgId,
      company_id: companyId,
      document_type_id: parsed.document_type_id,
      requirement_id: requirement?.id ?? null,
      prequalification_id: prequalificationId ?? null,
      file_id: fileId,
      status: "pending_review",
      submitted_via_portal: false,
      ...documentFactColumns(parsed),
    })
    .select(
      `
      *,
      compliance_document_types (*),
      files (id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at)
    `
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to upload compliance document: ${error?.message}`)
  }

  await supersedePriorDocuments({
    supabase,
    orgId: resolvedOrgId,
    companyId,
    documentTypeId: parsed.document_type_id,
    newDocumentId: data.id,
  })

  const uploadedType = Array.isArray(data.compliance_document_types)
    ? data.compliance_document_types[0]
    : data.compliance_document_types
  if (uploadedType?.code === "w9") {
    const receivedAt = new Date().toISOString()
    const { error: companyError } = await supabase
      .from("companies")
      .update({ w9_file_id: fileId, w9_received_at: receivedAt })
      .eq("org_id", resolvedOrgId)
      .eq("id", companyId)
    if (companyError) throw new Error(`Failed to attach W-9 to company: ${companyError.message}`)
    await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "company.w9_received", entityType: "company", entityId: companyId, payload: { file_id: fileId } })
  }

  await enqueueCoiExtraction({ orgId: resolvedOrgId, fileId, documentId: data.id, documentType: uploadedType })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "compliance_document",
    entityId: data.id,
    after: data,
    source: "directory.compliance",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "compliance_document_uploaded",
    entityType: "company",
    entityId: companyId,
    payload: { document_type_id: parsed.document_type_id },
  })

  return mapDocument(data)
}

export async function uploadComplianceDocumentFromPortal({
  supabase,
  orgId,
  companyId,
  input,
  fileId,
  portalTokenId,
  prequalificationId,
}: {
  supabase: SupabaseClient
  orgId: string
  companyId: string
  input: ComplianceDocumentUploadInput
  fileId: string
  portalTokenId: string
  /** Set when the document arrived as part of a prequalification package. */
  prequalificationId?: string | null
}): Promise<ComplianceDocument> {
  const parsed = complianceDocumentUploadSchema.parse(input)

  // Find matching requirement if exists
  const { data: requirement } = await supabase
    .from("company_compliance_requirements")
    .select("id")
    .eq("org_id", orgId)
    .eq("company_id", companyId)
    .eq("document_type_id", parsed.document_type_id)
    .maybeSingle()

  const { data, error } = await supabase
    .from("compliance_documents")
    .insert({
      org_id: orgId,
      company_id: companyId,
      document_type_id: parsed.document_type_id,
      requirement_id: requirement?.id ?? null,
      file_id: fileId,
      status: "pending_review",
      submitted_via_portal: true,
      portal_token_id: portalTokenId,
      prequalification_id: prequalificationId ?? null,
      ...documentFactColumns(parsed),
    })
    .select(
      `
      *,
      compliance_document_types (*),
      files (id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at)
    `
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to upload compliance document: ${error?.message}`)
  }

  await supersedePriorDocuments({
    supabase,
    orgId,
    companyId,
    documentTypeId: parsed.document_type_id,
    newDocumentId: data.id,
  })

  const uploadedType = Array.isArray(data.compliance_document_types)
    ? data.compliance_document_types[0]
    : data.compliance_document_types
  if (uploadedType?.code === "w9") {
    const receivedAt = new Date().toISOString()
    const { error: companyError } = await supabase
      .from("companies")
      .update({ w9_file_id: fileId, w9_received_at: receivedAt })
      .eq("org_id", orgId)
      .eq("id", companyId)
    if (companyError) throw new Error(`Failed to attach W-9 to company: ${companyError.message}`)
    await recordEvent({ orgId, eventType: "company.w9_received", entityType: "company", entityId: companyId, payload: { file_id: fileId, submitted_via_portal: true } })
  }

  await enqueueCoiExtraction({ orgId, fileId, documentId: data.id, documentType: uploadedType })

  await recordEvent({
    orgId,
    eventType: "compliance_document_uploaded",
    entityType: "company",
    entityId: companyId,
    payload: {
      document_type_id: parsed.document_type_id,
      submitted_via_portal: true,
    },
  })

  // The event above is the activity record. This one is the notification: a
  // vendor's submission used to reach nobody, so a certificate that would have
  // released a held payable sat in the queue unseen.
  const { data: companyRow } = await supabase
    .from("companies")
    .select("name")
    .eq("org_id", orgId)
    .eq("id", companyId)
    .maybeSingle()

  await recordEvent({
    orgId,
    eventType: "compliance_document_submitted",
    entityType: "compliance_document",
    entityId: data.id,
    channel: "notification",
    payload: {
      company_id: companyId,
      company_name: companyRow?.name ?? null,
      document_name: uploadedType?.name ?? null,
      document_type_id: parsed.document_type_id,
    },
  }).catch(() => null)

  return mapDocument(data)
}

export async function reviewComplianceDocument({
  documentId,
  decision,
  orgId,
}: {
  documentId: string
  decision: ComplianceReviewDecision
  orgId?: string
}): Promise<ComplianceDocument> {
  const parsed = complianceReviewDecisionSchema.parse(decision)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  // Approving a certificate releases held money. `org.member` was never the
  // right bar for that, and it is the only permission the payment gate trusts
  // downstream of this decision.
  await requirePermission("compliance.review", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("compliance_documents")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", documentId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Compliance document not found")
  }

  if (existing.status !== "pending_review") {
    throw new Error(
      "This document has already been decided. Withdraw the decision first if it needs to change.",
    )
  }

  // The reviewer is the authority on what the certificate says. Extraction only
  // proposes; a correction made while deciding is written onto the document, so
  // the deficiency check reads what the human confirmed rather than what the
  // vendor typed.
  const corrections = parsed.corrections ? documentFactColumns(parsed.corrections) : {}

  const { data, error } = await supabase
    .from("compliance_documents")
    .update({
      ...corrections,
      status: parsed.decision,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      review_notes: parsed.notes ?? null,
      rejection_reason: parsed.decision === "rejected" ? parsed.rejection_reason ?? null : null,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", documentId)
    // Only a document still pending can be decided. Two reviewers opening the
    // same certificate cannot both record a verdict.
    .eq("status", "pending_review")
    .select(
      `
      *,
      compliance_document_types (*),
      files (id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at)
    `
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to review compliance document: ${error?.message}`)
  }

  // Approval is the moment the certificate starts gating payments, so it is the
  // moment worth reading it — a document rejected on sight is never read.
  const reviewedType = Array.isArray(data.compliance_document_types)
    ? data.compliance_document_types[0]
    : data.compliance_document_types
  if (parsed.decision === "approved") {
    await enqueueCoiExtraction({ orgId: resolvedOrgId, fileId: data.file_id, documentId: documentId, documentType: reviewedType })
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: `compliance_document_${parsed.decision}`,
    entityType: "company",
    entityId: existing.company_id,
    payload: { document_id: documentId },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "compliance_document",
    entityId: documentId,
    before: existing,
    after: data,
  })

  // A rejection the vendor never hears about is a document that never gets
  // fixed. Autopilot does not chase rejections, so this is the only signal.
  await notifyVendorOfComplianceDecision({
    supabase,
    orgId: resolvedOrgId,
    companyId: existing.company_id,
    documentName: reviewedType?.name ?? "A compliance document",
    decision: parsed.decision,
    rejectionReason: parsed.decision === "rejected" ? parsed.rejection_reason ?? null : null,
  }).catch((notifyError) => {
    console.error("Failed to notify vendor of compliance decision", notifyError)
  })

  return mapDocument(data)
}

/**
 * Withdraw a decision already recorded.
 *
 * An approval that turns out to be wrong — the wrong certificate, a forged
 * date, a policy cancelled the week after — used to have no cure at all:
 * `reviewComplianceDocument` refuses a second decision, so the only escape was
 * pretending it had never happened. The document stops satisfying its
 * requirement immediately, which puts the vendor back on the hook for a real
 * one and re-raises whatever payment hold the approval had released.
 */
export async function revokeComplianceDecision({
  documentId,
  input,
  orgId,
}: {
  documentId: string
  input: ComplianceRevokeDecisionInput
  orgId?: string
}): Promise<ComplianceDocument> {
  const parsed = complianceRevokeDecisionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("compliance.review", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("compliance_documents")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", documentId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Compliance document not found")
  }
  if (existing.status === "pending_review") {
    throw new Error("This document has not been decided yet, so there is nothing to withdraw")
  }
  if (existing.revoked_at) {
    throw new Error("This decision has already been withdrawn")
  }

  // The decision is withdrawn, not re-opened. The status stays as the record of
  // what was decided — `revoked_at` is what makes the document stop answering
  // its requirement, which puts the requirement back to missing and asks the
  // vendor for a fresh document. Re-reviewing the same certificate that was
  // just found wrong would be the wrong cure.
  const { data, error } = await supabase
    .from("compliance_documents")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: userId,
      revoke_reason: parsed.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", documentId)
    .select(
      `
      *,
      compliance_document_types (*),
      files (id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at)
    `
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to withdraw the decision: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "compliance_document",
    entityId: documentId,
    before: existing,
    after: data,
    source: "directory.compliance",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "compliance_document_decision_revoked",
    entityType: "company",
    entityId: existing.company_id,
    payload: { document_id: documentId, reason: parsed.reason },
  })

  return mapDocument(data)
}

/**
 * Tell the vendor what happened to the document they sent.
 *
 * Best-effort and quiet: a vendor with no reachable email is not an error in
 * the review, and the decision itself is already recorded.
 */
async function notifyVendorOfComplianceDecision(params: {
  supabase: SupabaseClient
  orgId: string
  companyId: string
  documentName: string
  decision: "approved" | "rejected"
  rejectionReason: string | null
}) {
  const [{ data: company }, { data: org }] = await Promise.all([
    params.supabase
      .from("companies")
      .select("id, name, email")
      .eq("org_id", params.orgId)
      .eq("id", params.companyId)
      .maybeSingle(),
    params.supabase
      .from("orgs")
      .select("name, logo_url, slug")
      .eq("id", params.orgId)
      .maybeSingle(),
  ])

  if (!company) return

  let recipientEmail = company.email?.trim() ?? ""
  let recipientName: string | null = company.name ?? null
  if (!recipientEmail) {
    const { data: contact } = await params.supabase
      .from("contacts")
      .select("full_name, email")
      .eq("org_id", params.orgId)
      .eq("primary_company_id", params.companyId)
      .not("email", "is", null)
      .limit(1)
      .maybeSingle()
    if (contact?.email) {
      recipientEmail = String(contact.email).trim()
      recipientName = contact.full_name ?? recipientName
    }
  }
  if (!recipientEmail) return

  const portalToken = await findExistingCompanyPortalToken({
    supabase: params.supabase,
    orgId: params.orgId,
    companyId: params.companyId,
  }).catch(() => null)

  await sendComplianceDecisionEmail({
    to: recipientEmail,
    recipientName,
    companyName: company.name ?? "your company",
    documentName: params.documentName,
    decision: params.decision,
    rejectionReason: params.rejectionReason,
    orgName: org?.name ?? null,
    orgLogoUrl: org?.logo_url ?? null,
    orgSlug: org?.slug ?? null,
    portalToken,
  })
}

// ============ Compliance Status ============

function isExpiredDocument(document: ComplianceDocument, now: Date): boolean {
  if (!document.expiry_date) return false
  return new Date(document.expiry_date) < now
}

function getMostRecentDocument(documents: ComplianceDocument[]): ComplianceDocument | null {
  if (documents.length === 0) return null
  return documents.reduce((latest, current) => {
    if (!latest) return current
    const latestTime = new Date(latest.created_at).getTime()
    const currentTime = new Date(current.created_at).getTime()
    return currentTime > latestTime ? current : latest
  }, documents[0] as ComplianceDocument | null)
}

function deficiencyMessage(
  codes: ComplianceRequirementDeficiency["codes"],
  requirement: ComplianceRequirement
): string {
  const parts: string[] = []
  if (codes.includes("min_coverage")) {
    const required = ((requirement.min_coverage_cents ?? 0) / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })
    parts.push(`Coverage below required minimum (${required})`)
  }
  if (codes.includes("additional_insured")) {
    parts.push("Additional insured endorsement required")
  }
  if (codes.includes("primary_noncontributory")) {
    parts.push("Primary & non-contributory wording required")
  }
  if (codes.includes("waiver_of_subrogation")) {
    parts.push("Waiver of subrogation endorsement required")
  }
  return parts.join("; ")
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function isActiveWaiver(waiver: ComplianceRequirementWaiver, now = new Date()): boolean {
  if (waiver.revoked_at) return false
  if (!waiver.expires_at) return true
  return waiver.expires_at >= todayKey(now)
}

/**
 * The one place a vendor's real obligations are decided.
 *
 * Two explicit layers, each overriding the last on the same document type:
 *   vendor requirement → what this vendor owes
 *   project overlay → what this job demands, because an owner said so
 *
 * A layer only ever replaces a rule, never weakens the set: an overlay adds a
 * requirement or raises its terms. The waiver is still the only exit, which is
 * what keeps the exit audited.
 *
 * Org defaults are templates for people configuring a vendor, not obligations
 * assigned to every company with a vendor role. This keeps adding a material
 * supplier or other non-submitting vendor from silently starting email chases.
 */
export function resolveEffectiveRequirements({
  companyId,
  companyRequirements,
  projectRequirements = [],
  documentTypes,
  waivers,
}: {
  companyId: string
  companyRequirements: ComplianceRequirement[]
  /** Overlay rows for the projects in scope. Already filtered to this company. */
  projectRequirements?: ComplianceRequirement[]
  documentTypes: ComplianceDocumentType[]
  waivers: ComplianceRequirementWaiver[]
}): ComplianceRequirement[] {
  const documentTypesById = new Map(documentTypes.map((type) => [type.id, type]))
  const activeWaiversByTypeId = new Map(
    waivers
      .filter((waiver) => isActiveWaiver(waiver))
      .map((waiver) => [waiver.document_type_id, waiver])
  )
  const byTypeId = new Map<string, ComplianceRequirement>()

  for (const requirement of companyRequirements) {
    if (!requirement.is_required) continue
    byTypeId.set(requirement.document_type_id, {
      ...requirement,
      document_type: requirement.document_type ?? documentTypesById.get(requirement.document_type_id),
      source: "company_override",
    })
  }

  for (const requirement of projectRequirements) {
    if (!requirement.is_required) continue
    const existing = byTypeId.get(requirement.document_type_id)
    byTypeId.set(requirement.document_type_id, {
      ...requirement,
      company_id: companyId,
      document_type:
        requirement.document_type ?? documentTypesById.get(requirement.document_type_id),
      source: "project_overlay",
      // A layer may raise terms, never drop one. `??` would have let an overlay
      // that names $1M replace a vendor rule of $5M — and with several projects
      // in scope, whichever row happened to sort last would win. The strictest
      // number stated by any layer is the one that governs.
      min_coverage_cents:
        Math.max(requirement.min_coverage_cents ?? 0, existing?.min_coverage_cents ?? 0) || undefined,
      requires_additional_insured:
        requirement.requires_additional_insured || Boolean(existing?.requires_additional_insured),
      requires_primary_noncontributory:
        requirement.requires_primary_noncontributory ||
        Boolean(existing?.requires_primary_noncontributory),
      requires_waiver_of_subrogation:
        requirement.requires_waiver_of_subrogation ||
        Boolean(existing?.requires_waiver_of_subrogation),
    })
  }

  return Array.from(byTypeId.values()).map((requirement) => ({
    ...requirement,
    waiver: activeWaiversByTypeId.get(requirement.document_type_id) ?? null,
  }))
}

/** One project overlay row, still carrying the scope it was written for. */
interface ProjectOverlayRequirement {
  projectId: string
  /** Null when the project's rule applies to every vendor on the job. */
  companyId: string | null
  requirement: ComplianceRequirement
}

/**
 * Project overlay rows that bear on these companies' work.
 *
 * A row with no `company_id` is the project's rule for every vendor on it; a
 * row naming a company narrows to that vendor, and wins — which is why the
 * named rows are ordered last, where the resolver applies them over the broad
 * ones.
 *
 * The rows come back tagged rather than grouped because the readers group them
 * differently: a page of vendors needs them by company, and what one vendor's
 * non-compliance is holding needs them by project.
 */
async function getProjectRequirementsWithClient(
  supabase: SupabaseClient,
  orgId: string,
  companyIds: string[],
  projectIds: string[]
): Promise<ProjectOverlayRequirement[]> {
  if (projectIds.length === 0) return []
  // The company ids are interpolated into a PostgREST filter string below, where
  // a comma or paren would rewrite the filter rather than fail it.
  const safeCompanyIds = companyIds.filter((companyId) => UUID_PATTERN.test(companyId))
  if (safeCompanyIds.length === 0) return []
  const { data, error } = await supabase
    .from("project_compliance_requirements")
    .select(
      `
      *,
      compliance_document_types (*),
      projects (name)
    `
    )
    .eq("org_id", orgId)
    .in("project_id", projectIds)
    .or(`company_id.is.null,company_id.in.(${safeCompanyIds.join(",")})`)
    .order("company_id", { ascending: true, nullsFirst: true })

  if (error) {
    throw new Error(`Failed to load project compliance requirements: ${error.message}`)
  }

  return (data ?? []).map((row) => ({
    projectId: row.project_id,
    companyId: row.company_id ?? null,
    requirement: mapRequirement(row),
  }))
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Used only for a document type that never declared its own window. */
const FALLBACK_EXPIRY_WARNING_DAYS = 30

function daysUntil(dateValue: string, now: Date): number {
  const target = new Date(dateValue)
  if (Number.isNaN(target.getTime())) return 0
  return Math.floor((target.getTime() - now.getTime()) / DAY_MS)
}

/**
 * How far ahead this document type wants to be warned. Stored on the type,
 * described to the user in settings, and — until now — read by nothing: both
 * the status summary and the autopilot hardcoded 30 days.
 */
function warningDaysFor(
  documentType: ComplianceDocumentType | undefined,
  document: ComplianceDocument,
): number {
  const days = documentType?.expiry_warning_days ?? document.document_type?.expiry_warning_days
  return typeof days === "number" && days > 0 ? days : FALLBACK_EXPIRY_WARNING_DAYS
}

/**
 * A document that can still answer a requirement: not withdrawn, and not
 * already replaced by a newer submission for the same requirement.
 *
 * History keeps both kinds — the point of history is what came before — but a
 * superseded or revoked document must never be counted as pending, expiring or
 * expired, or the tab reports work that no longer exists.
 */
function isLiveDocument(document: ComplianceDocument): boolean {
  return !document.revoked_at && !document.superseded_by_id
}

function buildComplianceStatus({
  companyId,
  requirements,
  documents,
}: {
  companyId: string
  requirements: ComplianceRequirement[]
  documents: ComplianceDocument[]
}): ComplianceStatusSummary {
  const now = new Date()
  // Two sets, deliberately: `liveDocuments` decides verdicts, `documents`
  // carries the trail. A superseded submission is still part of the record the
  // reviewer should be able to open — it just stops being the answer.
  const liveDocuments = documents.filter(isLiveDocument)

  const approvedDocs = liveDocuments.filter((d) => d.status === "approved")
  const pendingReview = liveDocuments.filter((d) => d.status === "pending_review")
  const rejected = liveDocuments.filter((d) => d.status === "rejected")

  // Scoped to what this vendor is actually asked for. Counting every approved
  // document meant a lapsed certificate for a type nobody requires made the
  // vendor permanently non-compliant — and the workspace, which renders only
  // the requirement rows, had nothing to show for it.
  const requiredTypeIds = new Set(
    requirements.filter((r) => r.is_required).map((r) => r.document_type_id),
  )
  const requiredApproved = approvedDocs.filter((d) => requiredTypeIds.has(d.document_type_id))
  const expired = requiredApproved.filter((d) => isExpiredDocument(d, now))
  const expiringSoon = requiredApproved.filter((d) => {
    if (!d.expiry_date) return false
    const days = daysUntil(d.expiry_date, now)
    return days >= 0 && days <= warningDaysFor(d.document_type, d)
  })

  const missing: ComplianceDocumentType[] = []
  const waived: ComplianceRequirement[] = []
  const deficiencies: ComplianceRequirementDeficiency[] = []
  const statuses: ComplianceRequirementStatus[] = []

  for (const requirement of requirements) {
    if (!requirement.is_required) continue

    const history = documents
      .filter((document) => document.document_type_id === requirement.document_type_id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    // Only a live document can answer the requirement; history is everything.
    const answering = history.filter(isLiveDocument)

    if (requirement.waiver && isActiveWaiver(requirement.waiver, now)) {
      waived.push(requirement)
      statuses.push({
        requirement,
        state: "waived",
        document: history[0] ?? null,
        history,
        days_until_expiry: null,
        deficiency: null,
      })
      continue
    }

    const approvedForType = answering.filter((document) => document.status === "approved")
    const nonExpiredApproved = approvedForType.filter((document) => !isExpiredDocument(document, now))
    const bestDocument = getMostRecentDocument(nonExpiredApproved)

    if (!bestDocument) {
      // A requirement whose document type cannot be resolved — deactivated, but
      // still named in the org template — used to be skipped here, which made
      // `is_compliant` true while the tab rendered the row as "Not provided".
      // The gate and the screen must never disagree about whether a vendor is
      // short, so an unresolvable type counts as missing under its own id.
      missing.push(
        requirement.document_type ?? {
          id: requirement.document_type_id,
          org_id: requirement.org_id,
          name: "Required document",
          code: "unknown",
          kind: "other",
          has_expiry: false,
          expiry_warning_days: FALLBACK_EXPIRY_WARNING_DAYS,
          is_system: false,
          is_active: false,
          created_at: "",
        },
      )
      // "Missing" is the verdict either way — none of these satisfy the
      // requirement — but the vendor and the reviewer both need to know which
      // of the three it is before they can act.
      const pendingForType = answering.find((document) => document.status === "pending_review")
      const expiredForType = approvedForType.find((document) => isExpiredDocument(document, now))
      const rejectedForType = answering.find((document) => document.status === "rejected")
      const state: ComplianceRequirementState = pendingForType
        ? "pending"
        : expiredForType
          ? "expired"
          : rejectedForType
            ? "rejected"
            : "missing"
      const shown = pendingForType ?? expiredForType ?? rejectedForType ?? null
      statuses.push({
        requirement,
        state,
        document: shown,
        history,
        days_until_expiry: shown?.expiry_date ? daysUntil(shown.expiry_date, now) : null,
        deficiency: null,
      })
      continue
    }

    const codes: ComplianceRequirementDeficiency["codes"] = []
    if (
      requirement.min_coverage_cents != null &&
      (bestDocument.coverage_amount_cents ?? 0) < requirement.min_coverage_cents
    ) {
      codes.push("min_coverage")
    }
    if (requirement.requires_additional_insured && !bestDocument.additional_insured) {
      codes.push("additional_insured")
    }
    if (requirement.requires_primary_noncontributory && !bestDocument.primary_noncontributory) {
      codes.push("primary_noncontributory")
    }
    if (requirement.requires_waiver_of_subrogation && !bestDocument.waiver_of_subrogation) {
      codes.push("waiver_of_subrogation")
    }

    const deficiency: ComplianceRequirementDeficiency | null =
      codes.length > 0
        ? {
            requirement_id: requirement.id,
            document_type_id: requirement.document_type_id,
            document_type_name:
              requirement.document_type?.name ?? bestDocument.document_type?.name ?? undefined,
            document_id: bestDocument.id,
            codes,
            message: deficiencyMessage(codes, requirement),
          }
        : null

    if (deficiency) deficiencies.push(deficiency)

    const daysLeft = bestDocument.expiry_date ? daysUntil(bestDocument.expiry_date, now) : null
    const expiringNow =
      daysLeft !== null && daysLeft >= 0 && daysLeft <= warningDaysFor(requirement.document_type, bestDocument)

    statuses.push({
      requirement,
      state: deficiency ? "deficient" : expiringNow ? "expiring" : "met",
      document: bestDocument,
      history,
      days_until_expiry: daysLeft,
      deficiency,
    })
  }

  const isCompliant = missing.length === 0 && expired.length === 0 && deficiencies.length === 0

  return {
    company_id: companyId,
    monitoring_enabled: true,
    requirements,
    documents,
    statuses,
    missing,
    waived,
    deficiencies,
    expiring_soon: expiringSoon,
    expired,
    pending_review: pendingReview,
    rejected,
    is_compliant: isCompliant,
  }
}

/** Keep the record readable while removing every active enforcement signal. */
function applyComplianceMonitoring(
  summary: ComplianceStatusSummary,
  enabled: boolean,
): ComplianceStatusSummary {
  if (enabled) return { ...summary, monitoring_enabled: true }
  return {
    ...summary,
    monitoring_enabled: false,
    missing: [],
    deficiencies: [],
    expiring_soon: [],
    expired: [],
    pending_review: [],
    rejected: [],
    is_compliant: true,
  }
}

export async function getCompanyComplianceStatus(
  companyId: string,
  orgId?: string,
  options?: { projectIds?: string[] }
): Promise<ComplianceStatusSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["compliance.read", "org.member"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  return getCompanyComplianceStatusWithClient(supabase, resolvedOrgId, companyId, options)
}

/** Everything one vendor's status is built from except the project overlay. */
interface CompanyComplianceInputs {
  monitoringEnabled: boolean
  companyRequirements: ComplianceRequirement[]
  documents: ComplianceDocument[]
  documentTypes: ComplianceDocumentType[]
  waivers: ComplianceRequirementWaiver[]
}

/**
 * The vendor's own compliance record, before any job's terms are laid over it.
 *
 * Separated from the status build because the overlay is the only thing that
 * differs between "what does this vendor owe" and "what does this job demand of
 * them" — so asking the second question once per project costs no extra reads.
 */
async function loadCompanyComplianceInputs(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string
): Promise<CompanyComplianceInputs> {
  const [companyResult, requirementsResult, documentsResult, documentTypesResult, waiversResult] = await Promise.all([
    supabase
      .from("companies")
      .select("compliance_monitoring_enabled")
      .eq("org_id", orgId)
      .eq("id", companyId)
      .maybeSingle(),
    supabase
      .from("company_compliance_requirements")
      .select(
        `
        *,
        compliance_document_types (*)
      `
      )
      .eq("org_id", orgId)
      .eq("company_id", companyId),
    supabase
      .from("compliance_documents")
      .select(
        `
        *,
        compliance_document_types (*),
        files (id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at)
      `
      )
      .eq("org_id", orgId)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false }),
    supabase
      .from("compliance_document_types")
      .select("*")
      .eq("org_id", orgId)
      .eq("is_active", true),
    supabase
      .from("company_compliance_requirement_waivers")
      .select("*")
      .eq("org_id", orgId)
      .eq("company_id", companyId),
  ])

  if (companyResult.error || !companyResult.data) {
    throw new Error("Company not found")
  }

  if (requirementsResult.error) {
    throw new Error(
      `Failed to get compliance requirements: ${requirementsResult.error.message}`
    )
  }
  if (documentsResult.error) {
    throw new Error(
      `Failed to get compliance documents: ${documentsResult.error.message}`
    )
  }
  if (documentTypesResult.error) {
    throw new Error(
      `Failed to get compliance document types: ${documentTypesResult.error.message}`
    )
  }
  if (waiversResult.error) {
    throw new Error(
      `Failed to get compliance waivers: ${waiversResult.error.message}`
    )
  }

  return {
    monitoringEnabled: Boolean(companyResult.data.compliance_monitoring_enabled),
    companyRequirements: (requirementsResult.data ?? []).map(mapRequirement),
    documents: (documentsResult.data ?? []).map(mapDocument),
    documentTypes: (documentTypesResult.data ?? []).map(mapDocumentType),
    waivers: (waiversResult.data ?? []).map(mapWaiver),
  }
}

export async function getCompanyComplianceStatusWithClient(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
  options?: {
    /**
     * Projects whose overlays apply. Omitted means the vendor's standing
     * obligations across the org; naming a project answers "is this vendor
     * eligible for THIS job", which is a stricter question.
     */
    projectIds?: string[]
  }
): Promise<ComplianceStatusSummary> {
  const [inputs, overlays] = await Promise.all([
    loadCompanyComplianceInputs(supabase, orgId, companyId),
    getProjectRequirementsWithClient(supabase, orgId, [companyId], options?.projectIds ?? []),
  ])

  const requirements = resolveEffectiveRequirements({
    companyId,
    companyRequirements: inputs.companyRequirements,
    projectRequirements: overlays.map((overlay) => overlay.requirement),
    documentTypes: inputs.documentTypes,
    waivers: inputs.waivers,
  })

  return applyComplianceMonitoring(
    buildComplianceStatus({
      companyId,
      requirements,
      documents: inputs.documents,
    }),
    inputs.monitoringEnabled,
  )
}

/** Everything a page of vendors' verdicts is built from, loaded once. */
interface CompaniesComplianceInputs {
  monitoringByCompanyId: Map<string, boolean>
  documentTypes: ComplianceDocumentType[]
  requirementsByCompanyId: Map<string, ComplianceRequirement[]>
  documentsByCompanyId: Map<string, ComplianceDocument[]>
  waiversByCompanyId: Map<string, ComplianceRequirementWaiver[]>
  /** Untouched, still carrying the project and company each row was written for. */
  overlays: ProjectOverlayRequirement[]
}

/**
 * The vendors' own compliance records plus every overlay bearing on the projects
 * in scope — five reads, however many vendors and projects are asked about.
 *
 * The overlays come back ungrouped because the readers group them differently:
 * a directory page asks what could apply to a vendor anywhere in scope, while
 * the money question asks what the one job a payable sits on demands. Grouping
 * them here would force the second reader to accept the first one's answer,
 * which is how a vendor gets judged against somebody else's project.
 */
async function loadCompaniesComplianceInputs(
  supabase: SupabaseClient,
  orgId: string,
  companyIds: string[],
  projectIds: string[]
): Promise<CompaniesComplianceInputs> {
  const [
    companiesResult,
    requirementsResult,
    documentsResult,
    documentTypesResult,
    waiversResult,
    overlays,
  ] = await Promise.all([
    supabase
      .from("companies")
      .select("id, compliance_monitoring_enabled")
      .eq("org_id", orgId)
      .in("id", companyIds),
    supabase
      .from("company_compliance_requirements")
      .select(
        `
        *,
        compliance_document_types (*)
      `
      )
      .eq("org_id", orgId)
      .in("company_id", companyIds),
    supabase
      .from("compliance_documents")
      .select(
        `
        *,
        compliance_document_types (*)
      `
      )
      .eq("org_id", orgId)
      .in("company_id", companyIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("compliance_document_types")
      .select("*")
      .eq("org_id", orgId)
      .eq("is_active", true),
    supabase
      .from("company_compliance_requirement_waivers")
      .select("*")
      .eq("org_id", orgId)
      .in("company_id", companyIds),
    getProjectRequirementsWithClient(supabase, orgId, companyIds, projectIds),
  ])

  if (companiesResult.error) {
    throw new Error(`Failed to get compliance monitoring state: ${companiesResult.error.message}`)
  }

  if (requirementsResult.error) {
    throw new Error(
      `Failed to get compliance requirements: ${requirementsResult.error.message}`
    )
  }
  if (documentsResult.error) {
    throw new Error(
      `Failed to get compliance documents: ${documentsResult.error.message}`
    )
  }
  if (documentTypesResult.error) {
    throw new Error(
      `Failed to get compliance document types: ${documentTypesResult.error.message}`
    )
  }
  if (waiversResult.error) {
    throw new Error(
      `Failed to get compliance waivers: ${waiversResult.error.message}`
    )
  }

  const requirementsByCompanyId = new Map<string, ComplianceRequirement[]>()
  for (const req of (requirementsResult.data ?? []).map(mapRequirement)) {
    const list = requirementsByCompanyId.get(req.company_id) ?? []
    list.push(req)
    requirementsByCompanyId.set(req.company_id, list)
  }

  const documentsByCompanyId = new Map<string, ComplianceDocument[]>()
  for (const doc of (documentsResult.data ?? []).map(mapDocument)) {
    const list = documentsByCompanyId.get(doc.company_id) ?? []
    list.push(doc)
    documentsByCompanyId.set(doc.company_id, list)
  }

  const waiversByCompanyId = new Map<string, ComplianceRequirementWaiver[]>()
  for (const waiver of (waiversResult.data ?? []).map(mapWaiver)) {
    const list = waiversByCompanyId.get(waiver.company_id) ?? []
    list.push(waiver)
    waiversByCompanyId.set(waiver.company_id, list)
  }

  return {
    monitoringByCompanyId: new Map(
      (companiesResult.data ?? []).map((company: any) => [
        company.id as string,
        Boolean(company.compliance_monitoring_enabled),
      ]),
    ),
    documentTypes: (documentTypesResult.data ?? []).map(mapDocumentType),
    requirementsByCompanyId,
    documentsByCompanyId,
    waiversByCompanyId,
    overlays,
  }
}

/**
 * One vendor's verdict, from inputs already in memory — no read of its own.
 *
 * `projectId` is the whole point. Naming a project answers "is this vendor
 * eligible for THIS job", which is the question the payment gate asks of a
 * payable; passing the union of a queue's projects instead would judge every
 * vendor against every other vendor's job and turn a current vendor red.
 * `null` asks the looser standing question across everything in scope.
 *
 * A row naming no company is the project's rule for every vendor on the job, so
 * it lands on all of them; a row naming one lands only there. Query order is
 * preserved, which puts the broad rows first, where the resolver applies the
 * narrow ones over them.
 */
function resolveStatusFromInputs(
  inputs: CompaniesComplianceInputs,
  companyId: string,
  projectId: string | null
): ComplianceStatusSummary {
  const projectRequirements = inputs.overlays
    .filter(
      (overlay) =>
        (projectId === null || overlay.projectId === projectId) &&
        (overlay.companyId === null || overlay.companyId === companyId)
    )
    .map((overlay) => overlay.requirement)

  const requirements = resolveEffectiveRequirements({
    companyId,
    companyRequirements: inputs.requirementsByCompanyId.get(companyId) ?? [],
    projectRequirements,
    documentTypes: inputs.documentTypes,
    waivers: inputs.waiversByCompanyId.get(companyId) ?? [],
  })

  return applyComplianceMonitoring(
    buildComplianceStatus({
      companyId,
      requirements,
      documents: inputs.documentsByCompanyId.get(companyId) ?? [],
    }),
    inputs.monitoringByCompanyId.get(companyId) ?? false,
  )
}

/**
 * The same verdict as `getCompanyComplianceStatusWithClient`, for a page of
 * vendors at once.
 *
 * `projectIds` is the scope the page is about, and it matters: the payment gate
 * evaluates a vendor against the job the payable is on, so a list that skipped
 * the project overlay rendered a vendor green and then blocked the payment at
 * release. Scope is asked for once and answered in one query for every vendor —
 * never a read per row.
 */
export async function getCompaniesComplianceStatus(
  companyIds: string[],
  orgId?: string,
  options?: {
    /**
     * Projects whose overlays apply. Omitted means these vendors' standing
     * obligations; naming the projects the rows belong to answers what those
     * jobs demand, which is the stricter question the gate asks.
     */
    projectIds?: string[]
  }
): Promise<Record<string, ComplianceStatusSummary>> {
  const uniqueCompanyIds = Array.from(new Set(companyIds.filter(Boolean)))
  if (uniqueCompanyIds.length === 0) return {}

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(
    ["compliance.read", "org.member", "org.read", "directory.read", "directory.write"],
    { supabase, orgId: resolvedOrgId, userId },
  )

  const inputs = await loadCompaniesComplianceInputs(
    supabase,
    resolvedOrgId,
    uniqueCompanyIds,
    Array.from(new Set((options?.projectIds ?? []).filter(Boolean))),
  )

  const result: Record<string, ComplianceStatusSummary> = {}
  for (const companyId of uniqueCompanyIds) {
    // Every project in scope at once: this list answers "what does this vendor
    // owe across the work in front of me", not "what does one payable's job
    // demand" — that stricter question is `getComplianceHeldPayables`'.
    result[companyId] = resolveStatusFromInputs(inputs, companyId, null)
  }

  return result
}

// ============ Review queue ============

export interface PendingComplianceReview {
  document: ComplianceDocument
  companyId: string
  companyName: string
  submittedViaPortal: boolean
  /**
   * Whether this vendor's non-compliance is actually stopping money: at least
   * one outstanding payable on a job they are short for, with no override on
   * that bill and the governing policy at block. A pending review on a vendor
   * who is otherwise current stops nothing, and now says so.
   */
  blocksPayment: boolean
  /** What the hold is stopping for this vendor, in cents. */
  heldCents: number
  href: string
}

export interface ComplianceReviewQueue {
  items: PendingComplianceReview[]
  totalPending: number
  /** What the compliance hold is actually stopping across the queue, in cents. */
  heldCents: number
  /**
   * True when the money scan hit a cap, so `heldCents` is a floor rather than
   * the total. Never render it as a total without saying so.
   */
  heldCentsTruncated: boolean
  truncated: boolean
}

const REVIEW_QUEUE_CAP = 50

/**
 * Every compliance document waiting on a decision, org-wide, ranked by what it
 * is costing.
 *
 * A certificate sitting unreviewed is money sitting still: the payment hold
 * evaluates on approved documents, so an unopened queue is indistinguishable
 * from a non-compliant vendor. Ordering by held dollars puts the reviews that
 * unblock payment first — which only ranks anything honestly because the dollars
 * are what the hold is provably stopping. Ranked on the vendor's whole AP
 * balance, as it once was, the queue put the biggest supplier on top whether or
 * not reviewing their paperwork would release a cent.
 */
export async function listPendingComplianceReviews(
  orgId?: string,
  options?: { limit?: number },
): Promise<ComplianceReviewQueue> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["compliance.read", "org.member"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const limit = Math.min(options?.limit ?? REVIEW_QUEUE_CAP, REVIEW_QUEUE_CAP)

  const { data, error, count } = await supabase
    .from("compliance_documents")
    .select(
      `
      *,
      compliance_document_types (*),
      companies (id, name)
      `,
      { count: "exact" },
    )
    .eq("org_id", resolvedOrgId)
    .eq("status", "pending_review")
    .is("revoked_at", null)
    .is("superseded_by_id", null)
    .order("created_at", { ascending: true })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to load the compliance review queue: ${error.message}`)
  }

  const rows = data ?? []
  const pageCompanyIds = Array.from(
    new Set(rows.map((row: any) => row.company_id as string).filter(Boolean)),
  )

  // The page cap bounds the rows shown, never the total the header reports — a
  // truncated list quietly under-reporting the money is worse than no number.
  // One scan answers both, with the vendors on this page named first so the
  // scan's own cap can only ever bite vendors nobody is looking at.
  const queueCompanyIds =
    (count ?? 0) > rows.length
      ? Array.from(
          new Set([
            ...pageCompanyIds,
            ...(await listCompanyIdsWithPendingReview(supabase, resolvedOrgId)),
          ]),
        )
      : pageCompanyIds
  const held = await getComplianceHeldPayablesByCompanyWithClient(
    supabase,
    resolvedOrgId,
    queueCompanyIds,
  )

  const items: PendingComplianceReview[] = rows.map((row: any) => {
    const company = Array.isArray(row.companies) ? row.companies[0] : row.companies
    const vendorHeld = held.byCompanyId.get(row.company_id)
    return {
      document: mapDocument(row),
      companyId: row.company_id,
      companyName: company?.name ?? "Unknown vendor",
      submittedViaPortal: Boolean(row.submitted_via_portal),
      blocksPayment: (vendorHeld?.billCount ?? 0) > 0,
      heldCents: vendorHeld?.heldCents ?? 0,
      href: `/directory/${row.company_id}/compliance`,
    }
  })

  items.sort((a, b) => b.heldCents - a.heldCents || a.companyName.localeCompare(b.companyName))

  return {
    items,
    totalPending: count ?? items.length,
    heldCents: held.totalCents,
    heldCentsTruncated: held.truncated,
    truncated: (count ?? items.length) > items.length,
  }
}

/** Every company with an outstanding review, for the queue's money total. */
async function listCompanyIdsWithPendingReview(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("compliance_documents")
    .select("company_id")
    .eq("org_id", orgId)
    .eq("status", "pending_review")
    .is("revoked_at", null)
    .is("superseded_by_id", null)
  if (error) return []
  return Array.from(
    new Set((data ?? []).map((row: { company_id: string }) => row.company_id).filter(Boolean)),
  )
}

/**
 * The money scan is bounded, because vendor and project ids ride in the query
 * string: past roughly these counts PostgREST is handed a URL it refuses, and a
 * request that fails outright is worse than one that stops and says so. In a
 * review queue neither cap is reachable in normal use — they are a rail, not a
 * routine truncation — and whenever one bites, the result says the number is a
 * floor.
 */
const HELD_PAYABLES_COMPANY_CAP = 100
const HELD_PAYABLES_PROJECT_CAP = 100
const HELD_PAYABLES_BILL_CAP = 1000

export interface ComplianceHeldPayables {
  /** Per vendor: what the hold is stopping, and how many payables it stops. */
  byCompanyId: Map<string, { heldCents: number; billCount: number }>
  totalCents: number
  /**
   * True when a cap bit or the scan could not run, so every figure above is a
   * floor. A screen that states one as a total without saying so is telling the
   * same class of lie as the overstatement this scan replaced.
   */
  truncated: boolean
}

/**
 * What vendors' non-compliance is holding up, in dollars.
 *
 * The number has to survive being read as a promise, because the screens state
 * it as one: these payables cannot be released until the compliance clears. So
 * a payable is counted only where the compliance hold is what stops it — the
 * vendor is short for THAT payable's own project, nobody has overridden the
 * hold on that bill, and the governing policy has the hold at block rather than
 * warn. It used to sum every outstanding approved payable owed to the vendor,
 * which turned an AP balance into a consequence it could not back up.
 *
 * Deliberately narrow in one direction: a payable that some other hold also
 * stops is still counted, because clearing compliance is still required before
 * it can be paid, while one held by the insurance hold alone is not — that hold
 * carries its own record and its own override.
 *
 * Nine reads however many vendors and payables are asked about: one for the
 * bills, six to load every vendor's compliance record and the overlays of the
 * jobs their money is on, and two for the hold tables. Every verdict after that
 * is pure.
 *
 * Read-only and best-effort: a failure costs a number on a card and must never
 * take down the queue that number decorates. It reports zero *and* `truncated`,
 * never a bare zero — "nothing counted" must not read as "nothing held".
 */
export async function getComplianceHeldPayablesByCompanyWithClient(
  supabase: SupabaseClient,
  orgId: string,
  companyIds: string[],
): Promise<ComplianceHeldPayables> {
  const byCompanyId = new Map<string, { heldCents: number; billCount: number }>()
  const uniqueCompanyIds = Array.from(
    new Set(companyIds.filter((companyId) => UUID_PATTERN.test(companyId))),
  )
  if (uniqueCompanyIds.length === 0) return { byCompanyId, totalCents: 0, truncated: false }

  const scannedCompanyIds = uniqueCompanyIds.slice(0, HELD_PAYABLES_COMPANY_CAP)
  let truncated = scannedCompanyIds.length < uniqueCompanyIds.length

  // Largest first, so a scan that hits the bill cap keeps the money that moves
  // the total rather than whichever rows the database happened to return. A
  // bill with no total is worth nothing to this count and sorts last, where it
  // cannot spend a cap slot — descending order puts nulls first by default.
  const { data, error } = await supabase
    .from("vendor_bills")
    .select("id, company_id, project_id, total_cents, paid_cents")
    .eq("org_id", orgId)
    .in("company_id", scannedCompanyIds)
    .in("status", ["approved", "partial"])
    .order("total_cents", { ascending: false, nullsFirst: false })
    .limit(HELD_PAYABLES_BILL_CAP + 1)

  if (error) return { byCompanyId, totalCents: 0, truncated: true }

  const rows = data ?? []
  if (rows.length > HELD_PAYABLES_BILL_CAP) truncated = true

  const outstanding = rows
    .slice(0, HELD_PAYABLES_BILL_CAP)
    .map((row) => ({
      id: String(row.id),
      companyId: String(row.company_id),
      projectId: String(row.project_id),
      outstandingCents: (row.total_cents ?? 0) - (row.paid_cents ?? 0),
    }))
    // A payable on no project has no job to be judged against, so no compliance
    // hold can be shown to stop it.
    .filter((bill) => bill.outstandingCents > 0 && UUID_PATTERN.test(bill.projectId))
  if (outstanding.length === 0) return { byCompanyId, totalCents: 0, truncated }

  const scannedProjectIds: string[] = []
  const scannedProjects = new Set<string>()
  for (const bill of outstanding) {
    if (scannedProjects.has(bill.projectId)) continue
    if (scannedProjects.size >= HELD_PAYABLES_PROJECT_CAP) {
      truncated = true
      break
    }
    scannedProjects.add(bill.projectId)
    scannedProjectIds.push(bill.projectId)
  }
  const bills = outstanding.filter((bill) => scannedProjects.has(bill.projectId))

  // Both hold tables are readable only with `payment.release`, and the people
  // reading a compliance tab or a review queue are reviewers, not payers. Under
  // their own client the two reads come back empty and every override is
  // invisible — which is the overstatement this function exists to stop. The
  // org id is the one this request was authorized for, and an elevated read can
  // only take payables OUT of a count already limited to the bills the caller
  // can see.
  //
  // Both are read whole for the org rather than filtered to these bills and
  // projects: those filters would put thousands of ids in the query string,
  // while the tables themselves are small — at most one policy row per project,
  // and an override is a deliberate written act on a single bill.
  const holdReader = createServiceSupabaseClient()
  const [inputs, overrideResult, policyResult] = await Promise.all([
    loadCompaniesComplianceInputs(
      supabase,
      orgId,
      Array.from(new Set(bills.map((bill) => bill.companyId))),
      scannedProjectIds,
    ).catch(() => null),
    holdReader
      .from("payment_hold_overrides")
      .select("bill_id")
      .eq("org_id", orgId)
      .eq("hold_kind", "compliance_docs_approved")
      .is("revoked_at", null),
    // The org row (`project_id is null`) is the fallback the hold engine uses
    // when a project has no policy of its own.
    holdReader.from("payment_hold_policies").select("project_id, conditions").eq("org_id", orgId),
  ])

  if (!inputs) return { byCompanyId, totalCents: 0, truncated: true }

  const overriddenBillIds = new Set(
    (overrideResult.data ?? []).map((row: { bill_id: string }) => row.bill_id),
  )
  const policyRows = policyResult.data ?? []
  const orgConditions = policyRows.find((row) => row.project_id === null)?.conditions
  const conditionsByProjectId = new Map<string, unknown>(
    policyRows
      .filter((row) => row.project_id !== null)
      .map((row) => [String(row.project_id), row.conditions]),
  )

  // One verdict per (vendor, job) pair: several payables sit on the same job and
  // ask the same question, and the answer is pure once the inputs are loaded.
  const statusByPair = new Map<string, ComplianceStatusSummary>()
  let totalCents = 0
  for (const bill of bills) {
    const pair = `${bill.companyId}:${bill.projectId}`
    let status = statusByPair.get(pair)
    if (!status) {
      status = resolveStatusFromInputs(inputs, bill.companyId, bill.projectId)
      statusByPair.set(pair, status)
    }
    if (status.is_compliant) continue
    if (overriddenBillIds.has(bill.id)) continue
    const policy = parsePaymentHoldPolicy(
      conditionsByProjectId.get(bill.projectId) ?? orgConditions,
    )
    if (policy.compliance_docs_approved !== "block") continue

    const entry = byCompanyId.get(bill.companyId) ?? { heldCents: 0, billCount: 0 }
    entry.heldCents += bill.outstandingCents
    entry.billCount += 1
    byCompanyId.set(bill.companyId, entry)
    totalCents += bill.outstandingCents
  }

  return { byCompanyId, totalCents, truncated }
}

/** One vendor's held payables, for the tab that reports it as their number. */
export async function getComplianceHeldPayables(
  companyId: string,
  orgId?: string,
): Promise<{ heldCents: number; billCount: number }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["compliance.read", "org.member"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const held = await getComplianceHeldPayablesByCompanyWithClient(supabase, resolvedOrgId, [
    companyId,
  ])
  return held.byCompanyId.get(companyId) ?? { heldCents: 0, billCount: 0 }
}

// ============ Requesting documents ============

/**
 * Ask a vendor for the documents that are outstanding.
 *
 * Until now the only outbound push was the nightly autopilot, so a builder who
 * needed a certificate today had no way to ask for one — the tab's own upload
 * dialog is for documents that arrived by email. Reuses an existing portal
 * link; a request never mints new bearer access on its own.
 */
export async function requestComplianceDocuments({
  companyId,
  input,
  orgId,
}: {
  companyId: string
  input: ComplianceDocumentRequestInput
  orgId?: string
}): Promise<{ sent: boolean; recipientEmail: string | null; documentCount: number }> {
  const parsed = complianceDocumentRequestSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", { supabase, orgId: resolvedOrgId, userId })

  const [{ data: company }, { data: org }, { data: types }] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, email, compliance_monitoring_enabled")
      .eq("org_id", resolvedOrgId)
      .eq("id", companyId)
      .maybeSingle(),
    supabase.from("orgs").select("name, logo_url, slug").eq("id", resolvedOrgId).maybeSingle(),
    supabase
      .from("compliance_document_types")
      .select("id, name")
      .eq("org_id", resolvedOrgId)
      .in("id", parsed.document_type_ids),
  ])

  if (!company) throw new Error("Company not found")
  if (!company.compliance_monitoring_enabled) {
    throw new Error("Turn compliance monitoring on before requesting documents")
  }
  if (!types || types.length === 0) throw new Error("Those document types no longer exist")

  let recipientEmail = company.email?.trim() ?? ""
  let recipientName: string | null = company.name ?? null
  if (!recipientEmail) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("full_name, email")
      .eq("org_id", resolvedOrgId)
      .eq("primary_company_id", companyId)
      .not("email", "is", null)
      .limit(1)
      .maybeSingle()
    if (contact?.email) {
      recipientEmail = String(contact.email).trim()
      recipientName = contact.full_name ?? recipientName
    }
  }

  if (!recipientEmail) {
    return { sent: false, recipientEmail: null, documentCount: types.length }
  }

  const portalToken = await findExistingCompanyPortalToken({
    supabase,
    orgId: resolvedOrgId,
    companyId,
  }).catch(() => null)
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com").replace(/\/$/, "")

  const sent = await sendComplianceAutopilotEmail({
    to: recipientEmail,
    recipientName,
    companyName: company.name ?? "your company",
    items: types.map((type: any) => ({
      documentName: type.name as string,
      reminderKind: "missing" as const,
      expiryDate: null,
    })),
    orgName: org?.name ?? null,
    orgLogoUrl: org?.logo_url ?? null,
    orgSlug: org?.slug ?? null,
    portalUrl: portalToken ? `${baseUrl}/s/${portalToken}/compliance` : null,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "compliance_documents_requested",
    entityType: "company",
    entityId: companyId,
    payload: {
      document_type_ids: parsed.document_type_ids,
      recipient_email: recipientEmail,
      sent,
    },
  })

  return { sent, recipientEmail, documentCount: types.length }
}

/**
 * A one-line compliance warning per bidder, for the surfaces where work is
 * awarded.
 *
 * Compliance has always been checked at the payable — the last possible moment,
 * when the sub has already done the work and is waiting to be paid. Awarding to
 * a vendor whose insurance lapsed is the mistake worth catching, and it costs
 * one query on a screen that already ranks bidders.
 *
 * Returns nothing for a compliant vendor, so callers can treat presence as the
 * problem.
 */
export async function getBidInviteComplianceWarnings(
  companyIds: string[],
  orgId?: string,
): Promise<Map<string, string>> {
  const uniqueIds = Array.from(new Set(companyIds.filter(Boolean)))
  if (uniqueIds.length === 0) return new Map()

  const statuses = await getCompaniesComplianceStatus(uniqueIds, orgId).catch(() => null)
  if (!statuses) return new Map()

  const warnings = new Map<string, string>()
  for (const companyId of uniqueIds) {
    const status = statuses[companyId]
    if (!status || status.is_compliant) continue
    const parts = [
      status.missing.length > 0 ? `${status.missing.length} missing` : null,
      status.expired.length > 0 ? `${status.expired.length} expired` : null,
      status.deficiencies.length > 0 ? `${status.deficiencies.length} below requirement` : null,
    ].filter(Boolean)
    warnings.set(
      companyId,
      parts.length > 0
        ? `Compliance not current — ${parts.join(", ")}.`
        : "Vendor compliance is not current.",
    )
  }
  return warnings
}
