import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import type { ComplianceRequirementTemplateItem, ComplianceRules } from "@/lib/types"
import { complianceRequirementInputSchema } from "@/lib/validation/compliance-documents"

const defaultRules: ComplianceRules = {
  require_license: false,
  require_lien_waiver: false,
  block_payment_on_missing_docs: true,
}

function mergeRules(raw?: Partial<ComplianceRules> | null): ComplianceRules {
  return { ...defaultRules, ...(raw ?? {}) }
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
  await requireAnyPermission(["org.admin", "billing.manage", "org.member"], { supabase, orgId: resolvedOrgId, userId })

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

  return mergeRules((data?.compliance_rules ?? {}) as ComplianceRules)
}

function normalizeDefaults(
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

  return normalizeDefaults((data as any)?.default_compliance_requirements)
}

export async function updateDefaultComplianceRequirements({
  requirements,
  orgId,
}: {
  requirements: ComplianceRequirementTemplateItem[]
  orgId?: string
}): Promise<ComplianceRequirementTemplateItem[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.admin", "billing.manage", "org.member"], { supabase, orgId: resolvedOrgId, userId })

  const payload = normalizeDefaults(requirements)
  const { data, error } = await supabase
    .from("orgs")
    .update({ default_compliance_requirements: payload })
    .eq("id", resolvedOrgId)
    .select("default_compliance_requirements")
    .single()

  if (error) {
    throw new Error(`Failed to update compliance defaults: ${error.message}`)
  }

  return normalizeDefaults((data as any)?.default_compliance_requirements)
}
