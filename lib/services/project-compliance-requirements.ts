import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import type { ComplianceRequirement } from "@/lib/types"
import {
  projectComplianceRequirementInputSchema,
  type ProjectComplianceRequirementInput,
} from "@/lib/validation/compliance-documents"

/**
 * Per-project compliance requirements — the overlay layer.
 *
 * Requirements used to be org-wide or per-vendor and nothing else, which is a
 * poor fit for the way insurance is actually contracted: an owner mandates a $5M
 * umbrella on one job, and the only way to honour that was to raise the bar for
 * that vendor on every job they touch. An overlay states this project's terms
 * and nothing else.
 *
 * A row with no `company_id` is the project's rule for every vendor on it; a row
 * naming a company narrows it to that vendor's work on that job and wins.
 * `resolveEffectiveRequirements` merges these on top of the org default and the
 * vendor override — a layer may raise terms, never drop them.
 */

function mapProjectRequirement(row: any): ComplianceRequirement {
  return {
    id: row.id,
    org_id: row.org_id,
    company_id: row.company_id ?? "",
    document_type_id: row.document_type_id,
    document_type: row.compliance_document_types
      ? {
          id: row.compliance_document_types.id,
          org_id: row.compliance_document_types.org_id,
          name: row.compliance_document_types.name,
          code: row.compliance_document_types.code,
          kind: row.compliance_document_types.kind ?? "other",
          description: row.compliance_document_types.description ?? undefined,
          has_expiry: row.compliance_document_types.has_expiry,
          expiry_warning_days: row.compliance_document_types.expiry_warning_days,
          is_system: row.compliance_document_types.is_system,
          is_active: row.compliance_document_types.is_active,
          created_at: row.compliance_document_types.created_at,
        }
      : undefined,
    source: "project_overlay",
    waiver: null,
    is_required: row.is_required,
    min_coverage_cents: row.min_coverage_cents ?? undefined,
    requires_additional_insured: row.requires_additional_insured ?? false,
    requires_primary_noncontributory: row.requires_primary_noncontributory ?? false,
    requires_waiver_of_subrogation: row.requires_waiver_of_subrogation ?? false,
    notes: row.notes ?? undefined,
    created_at: row.created_at,
    created_by: row.created_by ?? undefined,
    project_id: row.project_id,
    project_name: row.projects?.name ?? undefined,
  }
}

export async function listProjectComplianceRequirements(
  projectId: string,
  orgId?: string,
): Promise<ComplianceRequirement[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["compliance.read", "org.member"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const { data, error } = await supabase
    .from("project_compliance_requirements")
    .select(
      `
      *,
      compliance_document_types (*),
      companies (id, name),
      projects (name)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`Failed to load project compliance requirements: ${error.message}`)
  }

  return (data ?? []).map(mapProjectRequirement)
}

/**
 * Replace a project's overlay set, as a diff.
 *
 * Deliberately not delete-then-insert: the same shape on the company table
 * emptied a vendor's requirements first, which reads as "compliant" for as long
 * as the gap lasts and releases every held payable in it.
 */
export async function setProjectComplianceRequirements({
  projectId,
  requirements,
  orgId,
}: {
  projectId: string
  requirements: ProjectComplianceRequirementInput[]
  orgId?: string
}): Promise<ComplianceRequirement[]> {
  const parsed = requirements.map((requirement) =>
    projectComplianceRequirementInputSchema.parse(requirement),
  )
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .maybeSingle()
  if (!project) throw new Error("Project not found")

  const { data: existingRows, error: existingError } = await supabase
    .from("project_compliance_requirements")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
  if (existingError) {
    throw new Error(`Failed to load project compliance requirements: ${existingError.message}`)
  }

  // A project's rules are keyed by document type AND the vendor they narrow to,
  // so "GL for everyone" and "GL for this sub" are two distinct rows.
  const scopeKey = (documentTypeId: string, companyId: string | null | undefined) =>
    `${documentTypeId}:${companyId ?? ""}`

  const existingByScope = new Map(
    (existingRows ?? []).map((row: any) => [scopeKey(row.document_type_id, row.company_id), row]),
  )
  const desiredScopes = new Set(
    parsed.map((requirement) =>
      scopeKey(requirement.document_type_id, requirement.company_id ?? null),
    ),
  )

  const toFields = (requirement: ProjectComplianceRequirementInput) => ({
    is_required: requirement.is_required,
    min_coverage_cents: requirement.min_coverage_cents ?? null,
    requires_additional_insured: requirement.requires_additional_insured ?? false,
    requires_primary_noncontributory: requirement.requires_primary_noncontributory ?? false,
    requires_waiver_of_subrogation: requirement.requires_waiver_of_subrogation ?? false,
    notes: requirement.notes ?? null,
  })

  const inserts = parsed
    .filter(
      (requirement) =>
        !existingByScope.has(scopeKey(requirement.document_type_id, requirement.company_id ?? null)),
    )
    .map((requirement) => ({
      org_id: resolvedOrgId,
      project_id: projectId,
      company_id: requirement.company_id ?? null,
      document_type_id: requirement.document_type_id,
      created_by: userId,
      ...toFields(requirement),
    }))

  const updates = parsed
    .filter((requirement) =>
      existingByScope.has(scopeKey(requirement.document_type_id, requirement.company_id ?? null)),
    )
    .map((requirement) => ({
      id: existingByScope.get(scopeKey(requirement.document_type_id, requirement.company_id ?? null))
        .id as string,
      fields: toFields(requirement),
    }))

  const removedIds = (existingRows ?? [])
    .filter((row: any) => !desiredScopes.has(scopeKey(row.document_type_id, row.company_id)))
    .map((row: any) => row.id as string)

  if (inserts.length > 0) {
    const { error } = await supabase.from("project_compliance_requirements").insert(inserts)
    if (error) throw new Error(`Failed to add project requirements: ${error.message}`)
  }

  for (const update of updates) {
    const { error } = await supabase
      .from("project_compliance_requirements")
      .update(update.fields)
      .eq("org_id", resolvedOrgId)
      .eq("id", update.id)
    if (error) throw new Error(`Failed to update project requirements: ${error.message}`)
  }

  if (removedIds.length > 0) {
    const { error } = await supabase
      .from("project_compliance_requirements")
      .delete()
      .eq("org_id", resolvedOrgId)
      .in("id", removedIds)
    if (error) throw new Error(`Failed to remove project requirements: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "project_compliance_requirements",
    entityId: projectId,
    before: { requirements: existingRows ?? [] },
    after: { requirements: parsed },
    source: "project.compliance",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "project_compliance_requirements_updated",
    entityType: "project",
    entityId: projectId,
    payload: {
      requirement_count: parsed.length,
      added: inserts.length,
      updated: updates.length,
      removed: removedIds.length,
    },
  })

  return listProjectComplianceRequirements(projectId, resolvedOrgId)
}
