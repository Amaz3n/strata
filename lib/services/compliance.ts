import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import type { ComplianceRules } from "@/lib/types"

const defaultRules: ComplianceRules = {
  require_w9: true,
  require_insurance: true,
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
  await requirePermission("org.admin", { supabase, orgId: resolvedOrgId, userId })

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
