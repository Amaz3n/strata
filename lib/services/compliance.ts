import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import type { ComplianceRequirementTemplateItem, ComplianceRules } from "@/lib/types"
import { complianceRequirementInputSchema } from "@/lib/validation/compliance-documents"

const defaultRules: ComplianceRules = {
  require_lien_waiver: false,
  block_payment_on_missing_docs: true,
  warn_subcontract_execution_on_missing_docs: true,
  block_subcontract_execution_on_missing_docs: false,
  block_commitment_on_prequal: false,
  prequalification_validity_days: 365,
}

function normalizeBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw
  return fallback
}

function mergeRules(raw?: Partial<ComplianceRules> | null): ComplianceRules {
  const source = raw ?? {}
  // Only keep canonical keys so legacy payloads do not leak into runtime behavior.
  return {
    require_lien_waiver: normalizeBoolean(source.require_lien_waiver, defaultRules.require_lien_waiver ?? false),
    block_payment_on_missing_docs: normalizeBoolean(
      source.block_payment_on_missing_docs,
      defaultRules.block_payment_on_missing_docs ?? true
    ),
    warn_subcontract_execution_on_missing_docs: normalizeBoolean(
      source.warn_subcontract_execution_on_missing_docs,
      defaultRules.warn_subcontract_execution_on_missing_docs ?? true,
    ),
    block_subcontract_execution_on_missing_docs: normalizeBoolean(
      source.block_subcontract_execution_on_missing_docs,
      defaultRules.block_subcontract_execution_on_missing_docs ?? false,
    ),
    block_commitment_on_prequal: normalizeBoolean(
      source.block_commitment_on_prequal,
      defaultRules.block_commitment_on_prequal ?? false,
    ),
    prequalification_validity_days:
      typeof source.prequalification_validity_days === "number" && source.prequalification_validity_days >= 30 && source.prequalification_validity_days <= 1825
        ? Math.round(source.prequalification_validity_days)
        : defaultRules.prequalification_validity_days,
  }
}

export async function getComplianceRules(orgId?: string): Promise<ComplianceRules> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("orgs")
    .select("compliance_rules")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load compliance rules: ${error.message}`)
  }

  return mergeRules((data?.compliance_rules ?? {}) as ComplianceRules)
}

export async function updateComplianceRules({
  rules,
  orgId,
}: {
  rules: ComplianceRules
  orgId?: string
}): Promise<ComplianceRules> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.admin", "billing.manage"], { supabase, orgId: resolvedOrgId, userId })

  const { data: beforeRow } = await supabase
    .from("orgs")
    .select("compliance_rules")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  const payload = mergeRules(rules)
  const { data, error } = await supabase
    .from("orgs")
    .update({ compliance_rules: payload })
    .eq("id", resolvedOrgId)
    .select("compliance_rules")
    .single()

  if (error) {
    throw new Error(`Failed to update compliance rules: ${error.message}`)
  }

  const after = mergeRules((data?.compliance_rules ?? {}) as ComplianceRules)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "org_compliance_rules",
    entityId: resolvedOrgId,
    before: { compliance_rules: mergeRules((beforeRow?.compliance_rules ?? {}) as ComplianceRules) },
    after: { compliance_rules: after },
    source: "settings.compliance",
  })

  try {
    await recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "compliance_rules_updated",
      entityType: "org_compliance_rules",
      entityId: resolvedOrgId,
      channel: "activity",
    })
  } catch (eventError) {
    console.error("Failed to record compliance rules event", eventError)
  }

  return after
}

export function normalizeComplianceRequirementDefaults(
  raw?: unknown
): ComplianceRequirementTemplateItem[] {
  const list = Array.isArray(raw) ? raw : []
  const parsed = list
    .map((item) => {
      // Ensure default behavior matches per-company requirement editor.
      const withRequired = { ...(item as any), is_required: true }
      return complianceRequirementInputSchema.parse(withRequired)
    })
    // Enforce uniqueness by doc type (last one wins).
    .reduce<ComplianceRequirementTemplateItem[]>((acc, item) => {
      const existingIndex = acc.findIndex((x) => x.document_type_id === item.document_type_id)
      if (existingIndex >= 0) acc.splice(existingIndex, 1)
      acc.push(item)
      return acc
    }, [])

  return parsed
}

export async function getDefaultComplianceRequirements(orgId?: string): Promise<ComplianceRequirementTemplateItem[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("orgs")
    .select("default_compliance_requirements")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load compliance defaults: ${error.message}`)
  }

  return normalizeComplianceRequirementDefaults((data as any)?.default_compliance_requirements)
}

export async function updateDefaultComplianceRequirements({
  requirements,
  orgId,
}: {
  requirements: ComplianceRequirementTemplateItem[]
  orgId?: string
}): Promise<ComplianceRequirementTemplateItem[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.admin", "billing.manage"], { supabase, orgId: resolvedOrgId, userId })

  const { data: beforeRow } = await supabase
    .from("orgs")
    .select("default_compliance_requirements")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  const payload = normalizeComplianceRequirementDefaults(requirements)
  const { data, error } = await supabase
    .from("orgs")
    .update({ default_compliance_requirements: payload })
    .eq("id", resolvedOrgId)
    .select("default_compliance_requirements")
    .single()

  if (error) {
    throw new Error(`Failed to update compliance defaults: ${error.message}`)
  }

  const after = normalizeComplianceRequirementDefaults((data as any)?.default_compliance_requirements)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "org_compliance_defaults",
    entityId: resolvedOrgId,
    before: { default_compliance_requirements: normalizeComplianceRequirementDefaults((beforeRow as any)?.default_compliance_requirements) },
    after: { default_compliance_requirements: after },
    source: "settings.compliance",
  })

  try {
    await recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "compliance_defaults_updated",
      entityType: "org_compliance_defaults",
      entityId: resolvedOrgId,
      channel: "activity",
    })
  } catch (eventError) {
    console.error("Failed to record compliance defaults event", eventError)
  }

  return after
}
