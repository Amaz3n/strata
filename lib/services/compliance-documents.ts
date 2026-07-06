import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  ComplianceDocument,
  ComplianceDocumentType,
  ComplianceRequirementDeficiency,
  ComplianceRequirement,
  ComplianceRequirementTemplateItem,
  ComplianceRequirementWaiver,
  ComplianceStatusSummary,
} from "@/lib/types"
import {
  complianceDocTypeInputSchema,
  complianceDocumentFiltersSchema,
  complianceDocumentUploadSchema,
  complianceRequirementInputSchema,
  complianceRequirementWaiverInputSchema,
  complianceRequirementWaiverRevokeSchema,
  complianceReviewDecisionSchema,
  type ComplianceDocTypeInput,
  type ComplianceDocumentFilters,
  type ComplianceDocumentUploadInput,
  type ComplianceRequirementInput,
  type ComplianceRequirementWaiverInput,
  type ComplianceRequirementWaiverRevokeInput,
  type ComplianceReviewDecision,
} from "@/lib/validation/compliance-documents"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { normalizeComplianceRequirementDefaults } from "@/lib/services/compliance"

// ============ Mappers ============

function mapDocumentType(row: any): ComplianceDocumentType {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    code: row.code,
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
    reviewed_by: row.reviewed_by ?? undefined,
    reviewed_at: row.reviewed_at ?? undefined,
    review_notes: row.review_notes ?? undefined,
    rejection_reason: row.rejection_reason ?? undefined,
    submitted_via_portal: row.submitted_via_portal,
    portal_token_id: row.portal_token_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
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
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  // Delete existing requirements
  const { error: deleteError } = await supabase
    .from("company_compliance_requirements")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)

  if (deleteError) {
    throw new Error(`Failed to update company requirements: ${deleteError.message}`)
  }

  if (parsedRequirements.length === 0) {
    return []
  }

  // Insert new requirements
  const { data, error } = await supabase
    .from("company_compliance_requirements")
    .insert(
      parsedRequirements.map((r) => ({
        org_id: resolvedOrgId,
        company_id: companyId,
        document_type_id: r.document_type_id,
        is_required: r.is_required,
        min_coverage_cents: r.min_coverage_cents ?? null,
        requires_additional_insured: r.requires_additional_insured ?? false,
        requires_primary_noncontributory: r.requires_primary_noncontributory ?? false,
        requires_waiver_of_subrogation: r.requires_waiver_of_subrogation ?? false,
        notes: r.notes ?? null,
        created_by: userId,
      }))
    )
    .select(
      `
      *,
      compliance_document_types (*)
    `
    )

  if (error) {
    throw new Error(`Failed to set company requirements: ${error.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "compliance_requirements_updated",
    entityType: "company",
    entityId: companyId,
    payload: { requirement_count: parsedRequirements.length },
  })

  return (data ?? []).map(mapRequirement)
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
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

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

  await recordEvent({
    orgId: resolvedOrgId,
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
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

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

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "compliance_requirement_waiver_revoked",
    entityType: "company",
    entityId: existing.company_id,
    payload: { document_type_id: existing.document_type_id },
  })

  return mapWaiver(data)
}

// ============ Documents ============

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
  orgId,
}: {
  companyId: string
  input: ComplianceDocumentUploadInput
  fileId: string
  orgId?: string
}): Promise<ComplianceDocument> {
  const parsed = complianceDocumentUploadSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

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
      file_id: fileId,
      status: "pending_review",
      effective_date: parsed.effective_date ?? null,
      expiry_date: parsed.expiry_date ?? null,
      policy_number: parsed.policy_number ?? null,
      coverage_amount_cents: parsed.coverage_amount_cents ?? null,
      carrier_name: parsed.carrier_name ?? null,
      additional_insured: parsed.additional_insured ?? false,
      primary_noncontributory: parsed.primary_noncontributory ?? false,
      waiver_of_subrogation: parsed.waiver_of_subrogation ?? false,
      submitted_via_portal: false,
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

  await recordEvent({
    orgId: resolvedOrgId,
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
}: {
  supabase: SupabaseClient
  orgId: string
  companyId: string
  input: ComplianceDocumentUploadInput
  fileId: string
  portalTokenId: string
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
      effective_date: parsed.effective_date ?? null,
      expiry_date: parsed.expiry_date ?? null,
      policy_number: parsed.policy_number ?? null,
      coverage_amount_cents: parsed.coverage_amount_cents ?? null,
      carrier_name: parsed.carrier_name ?? null,
      additional_insured: parsed.additional_insured ?? false,
      primary_noncontributory: parsed.primary_noncontributory ?? false,
      waiver_of_subrogation: parsed.waiver_of_subrogation ?? false,
      submitted_via_portal: true,
      portal_token_id: portalTokenId,
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
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

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
    throw new Error("Document has already been reviewed")
  }

  const { data, error } = await supabase
    .from("compliance_documents")
    .update({
      status: parsed.decision,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      review_notes: parsed.notes ?? null,
      rejection_reason: parsed.decision === "rejected" ? parsed.rejection_reason ?? null : null,
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
    throw new Error(`Failed to review compliance document: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
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

  return mapDocument(data)
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

function orgDefaultToRequirement({
  orgId,
  companyId,
  template,
  documentType,
}: {
  orgId: string
  companyId: string
  template: ComplianceRequirementTemplateItem
  documentType?: ComplianceDocumentType
}): ComplianceRequirement {
  return {
    id: `org-default:${companyId}:${template.document_type_id}`,
    org_id: orgId,
    company_id: companyId,
    document_type_id: template.document_type_id,
    document_type: documentType,
    source: "org_default",
    waiver: null,
    is_required: true,
    min_coverage_cents: template.min_coverage_cents ?? undefined,
    requires_additional_insured: template.requires_additional_insured ?? false,
    requires_primary_noncontributory: template.requires_primary_noncontributory ?? false,
    requires_waiver_of_subrogation: template.requires_waiver_of_subrogation ?? false,
    notes: template.notes ?? undefined,
    created_at: "",
    created_by: null,
  }
}

function resolveEffectiveRequirements({
  orgId,
  companyId,
  defaultRequirements,
  companyRequirements,
  documentTypes,
  waivers,
}: {
  orgId: string
  companyId: string
  defaultRequirements: ComplianceRequirementTemplateItem[]
  companyRequirements: ComplianceRequirement[]
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

  for (const template of defaultRequirements) {
    byTypeId.set(
      template.document_type_id,
      orgDefaultToRequirement({
        orgId,
        companyId,
        template,
        documentType: documentTypesById.get(template.document_type_id),
      })
    )
  }

  for (const requirement of companyRequirements) {
    if (!requirement.is_required) continue
    byTypeId.set(requirement.document_type_id, {
      ...requirement,
      document_type: requirement.document_type ?? documentTypesById.get(requirement.document_type_id),
      source: "company_override",
    })
  }

  return Array.from(byTypeId.values()).map((requirement) => ({
    ...requirement,
    waiver: activeWaiversByTypeId.get(requirement.document_type_id) ?? null,
  }))
}

async function getOrgDefaultRequirementTemplatesWithClient(
  supabase: SupabaseClient,
  orgId: string
): Promise<ComplianceRequirementTemplateItem[]> {
  const { data, error } = await supabase
    .from("orgs")
    .select("default_compliance_requirements")
    .eq("id", orgId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load compliance defaults: ${error.message}`)
  }

  return normalizeComplianceRequirementDefaults((data as any)?.default_compliance_requirements)
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
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  const approvedDocs = documents.filter((d) => d.status === "approved")
  const pendingReview = documents.filter((d) => d.status === "pending_review")

  const expired = approvedDocs.filter((d) => isExpiredDocument(d, now))
  const expiringSoon = approvedDocs.filter((d) => {
    if (!d.expiry_date) return false
    const expiryDate = new Date(d.expiry_date)
    return expiryDate >= now && expiryDate <= thirtyDaysFromNow
  })

  const missing: ComplianceDocumentType[] = []
  const waived: ComplianceRequirement[] = []
  const deficiencies: ComplianceRequirementDeficiency[] = []

  for (const requirement of requirements) {
    if (!requirement.is_required) continue
    if (requirement.waiver && isActiveWaiver(requirement.waiver, now)) {
      waived.push(requirement)
      continue
    }

    const approvedForType = approvedDocs.filter(
      (document) => document.document_type_id === requirement.document_type_id
    )
    const nonExpiredApproved = approvedForType.filter((document) => !isExpiredDocument(document, now))

    if (nonExpiredApproved.length === 0) {
      if (requirement.document_type) {
        missing.push(requirement.document_type)
      }
      continue
    }

    const bestDocument = getMostRecentDocument(nonExpiredApproved)
    if (!bestDocument) continue

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

    if (codes.length > 0) {
      deficiencies.push({
        requirement_id: requirement.id,
        document_type_id: requirement.document_type_id,
        document_type_name: requirement.document_type?.name ?? bestDocument.document_type?.name ?? undefined,
        document_id: bestDocument.id,
        codes,
        message: deficiencyMessage(codes, requirement),
      })
    }
  }

  const isCompliant = missing.length === 0 && expired.length === 0 && deficiencies.length === 0

  return {
    company_id: companyId,
    requirements,
    documents,
    missing,
    waived,
    deficiencies,
    expiring_soon: expiringSoon,
    expired,
    pending_review: pendingReview,
    is_compliant: isCompliant,
  }
}

export async function getCompanyComplianceStatus(
  companyId: string,
  orgId?: string
): Promise<ComplianceStatusSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  return getCompanyComplianceStatusWithClient(supabase, resolvedOrgId, companyId)
}

export async function getCompanyComplianceStatusWithClient(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string
): Promise<ComplianceStatusSummary> {
  const [
    requirementsResult,
    documentsResult,
    defaults,
    documentTypesResult,
    waiversResult,
  ] = await Promise.all([
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
    getOrgDefaultRequirementTemplatesWithClient(supabase, orgId),
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

  const companyRequirements = (requirementsResult.data ?? []).map(mapRequirement)
  const documents = (documentsResult.data ?? []).map(mapDocument)
  const documentTypes = (documentTypesResult.data ?? []).map(mapDocumentType)
  const waivers = (waiversResult.data ?? []).map(mapWaiver)
  const requirements = resolveEffectiveRequirements({
    orgId,
    companyId,
    defaultRequirements: defaults,
    companyRequirements,
    documentTypes,
    waivers,
  })

  return buildComplianceStatus({
    companyId,
    requirements,
    documents,
  })
}

export async function getCompaniesComplianceStatus(
  companyIds: string[],
  orgId?: string
): Promise<Record<string, ComplianceStatusSummary>> {
  const uniqueCompanyIds = Array.from(new Set(companyIds.filter(Boolean)))
  if (uniqueCompanyIds.length === 0) return {}

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(
    ["org.member", "org.read", "directory.read", "directory.write"],
    { supabase, orgId: resolvedOrgId, userId },
  )

  const [
    requirementsResult,
    documentsResult,
    defaults,
    documentTypesResult,
    waiversResult,
  ] = await Promise.all([
    supabase
      .from("company_compliance_requirements")
      .select(
        `
        *,
        compliance_document_types (*)
      `
      )
      .eq("org_id", resolvedOrgId)
      .in("company_id", uniqueCompanyIds),
    supabase
      .from("compliance_documents")
      .select(
        `
        *,
        compliance_document_types (*)
      `
      )
      .eq("org_id", resolvedOrgId)
      .in("company_id", uniqueCompanyIds)
      .order("created_at", { ascending: false }),
    getOrgDefaultRequirementTemplatesWithClient(supabase, resolvedOrgId),
    supabase
      .from("compliance_document_types")
      .select("*")
      .eq("org_id", resolvedOrgId)
      .eq("is_active", true),
    supabase
      .from("company_compliance_requirement_waivers")
      .select("*")
      .eq("org_id", resolvedOrgId)
      .in("company_id", uniqueCompanyIds),
  ])

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

  const requirements = (requirementsResult.data ?? []).map(mapRequirement)
  const documents = (documentsResult.data ?? []).map(mapDocument)
  const documentTypes = (documentTypesResult.data ?? []).map(mapDocumentType)
  const waivers = (waiversResult.data ?? []).map(mapWaiver)

  const requirementsByCompanyId = new Map<string, ComplianceRequirement[]>()
  for (const req of requirements) {
    const list = requirementsByCompanyId.get(req.company_id) ?? []
    list.push(req)
    requirementsByCompanyId.set(req.company_id, list)
  }

  const documentsByCompanyId = new Map<string, ComplianceDocument[]>()
  for (const doc of documents) {
    const list = documentsByCompanyId.get(doc.company_id) ?? []
    list.push(doc)
    documentsByCompanyId.set(doc.company_id, list)
  }

  const waiversByCompanyId = new Map<string, ComplianceRequirementWaiver[]>()
  for (const waiver of waivers) {
    const list = waiversByCompanyId.get(waiver.company_id) ?? []
    list.push(waiver)
    waiversByCompanyId.set(waiver.company_id, list)
  }

  const result: Record<string, ComplianceStatusSummary> = {}
  for (const companyId of uniqueCompanyIds) {
    const companyRequirements = resolveEffectiveRequirements({
      orgId: resolvedOrgId,
      companyId,
      defaultRequirements: defaults,
      companyRequirements: requirementsByCompanyId.get(companyId) ?? [],
      documentTypes,
      waivers: waiversByCompanyId.get(companyId) ?? [],
    })
    const companyDocuments = documentsByCompanyId.get(companyId) ?? []

    result[companyId] = buildComplianceStatus({
      companyId,
      requirements: companyRequirements,
      documents: companyDocuments,
    })
  }

  return result
}
