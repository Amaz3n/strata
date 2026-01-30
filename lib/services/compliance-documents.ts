import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  ComplianceDocument,
  ComplianceDocumentType,
  ComplianceRequirement,
  ComplianceStatusSummary,
} from "@/lib/types"
import {
  complianceDocTypeInputSchema,
  complianceDocumentFiltersSchema,
  complianceDocumentUploadSchema,
  complianceRequirementInputSchema,
  complianceReviewDecisionSchema,
  type ComplianceDocTypeInput,
  type ComplianceDocumentFilters,
  type ComplianceDocumentUploadInput,
  type ComplianceRequirementInput,
  type ComplianceReviewDecision,
} from "@/lib/validation/compliance-documents"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"

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
    is_required: row.is_required,
    min_coverage_cents: row.min_coverage_cents ?? undefined,
    notes: row.notes ?? undefined,
    created_at: row.created_at,
    created_by: row.created_by ?? undefined,
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
  // Fetch requirements and documents in parallel
  const [requirementsResult, documentsResult] = await Promise.all([
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

  const requirements = (requirementsResult.data ?? []).map(mapRequirement)
  const documents = (documentsResult.data ?? []).map(mapDocument)

  // Calculate status
  const now = new Date()
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  const approvedDocs = documents.filter((d) => d.status === "approved")
  const pendingReview = documents.filter((d) => d.status === "pending_review")

  // Find expired docs
  const expired = approvedDocs.filter((d) => {
    if (!d.expiry_date) return false
    return new Date(d.expiry_date) < now
  })

  // Find docs expiring soon (within 30 days)
  const expiringSoon = approvedDocs.filter((d) => {
    if (!d.expiry_date) return false
    const expiryDate = new Date(d.expiry_date)
    return expiryDate >= now && expiryDate <= thirtyDaysFromNow
  })

  // Find missing required document types
  const approvedDocTypeIds = new Set(
    approvedDocs
      .filter((d) => !expired.some((e) => e.id === d.id))
      .map((d) => d.document_type_id)
  )

  const missing: ComplianceDocumentType[] = requirements
    .filter((r) => r.is_required && !approvedDocTypeIds.has(r.document_type_id))
    .map((r) => r.document_type)
    .filter((dt): dt is ComplianceDocumentType => dt !== undefined)

  // Is compliant if no missing required docs and no expired docs
  const isCompliant = missing.length === 0 && expired.length === 0

  return {
    company_id: companyId,
    requirements,
    documents,
    missing,
    expiring_soon: expiringSoon,
    expired,
    pending_review: pendingReview,
    is_compliant: isCompliant,
  }
}

export async function getCompaniesComplianceStatus(
  companyIds: string[],
  orgId?: string
): Promise<Record<string, ComplianceStatusSummary>> {
  const uniqueCompanyIds = Array.from(new Set(companyIds.filter(Boolean)))
  if (uniqueCompanyIds.length === 0) return {}

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const [requirementsResult, documentsResult] = await Promise.all([
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

  const requirements = (requirementsResult.data ?? []).map(mapRequirement)
  const documents = (documentsResult.data ?? []).map(mapDocument)

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

  const result: Record<string, ComplianceStatusSummary> = {}
  for (const companyId of uniqueCompanyIds) {
    const companyRequirements = requirementsByCompanyId.get(companyId) ?? []
    const companyDocuments = documentsByCompanyId.get(companyId) ?? []

    // Calculate status (same logic as getCompanyComplianceStatusWithClient)
    const now = new Date()
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

    const approvedDocs = companyDocuments.filter((d) => d.status === "approved")
    const pendingReview = companyDocuments.filter((d) => d.status === "pending_review")

    const expired = approvedDocs.filter((d) => {
      if (!d.expiry_date) return false
      return new Date(d.expiry_date) < now
    })

    const expiringSoon = approvedDocs.filter((d) => {
      if (!d.expiry_date) return false
      const expiryDate = new Date(d.expiry_date)
      return expiryDate >= now && expiryDate <= thirtyDaysFromNow
    })

    const approvedDocTypeIds = new Set(
      approvedDocs
        .filter((d) => !expired.some((e) => e.id === d.id))
        .map((d) => d.document_type_id)
    )

    const missing: ComplianceDocumentType[] = companyRequirements
      .filter((r) => r.is_required && !approvedDocTypeIds.has(r.document_type_id))
      .map((r) => r.document_type)
      .filter((dt): dt is ComplianceDocumentType => dt !== undefined)

    const isCompliant = missing.length === 0 && expired.length === 0

    result[companyId] = {
      company_id: companyId,
      requirements: companyRequirements,
      documents: companyDocuments,
      missing,
      expiring_soon: expiringSoon,
      expired,
      pending_review: pendingReview,
      is_compliant: isCompliant,
    }
  }

  return result
}
