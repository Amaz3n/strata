"use server"

import { revalidatePath } from "next/cache"

import { requirePermissionGuard } from "@/lib/auth/guards"
import { requireOrgContext } from "@/lib/services/context"
import { createMarkupRule, deleteMarkupRule, listMarkupRules } from "@/lib/services/cost-plus"
import { listCostCodes } from "@/lib/services/cost-codes"

export async function listMarkupRulesAction() {
  await requirePermissionGuard("org.member")
  return listMarkupRules()
}

export async function listMarkupRuleOptionsAction() {
  await requirePermissionGuard("org.member")
  const { supabase, orgId } = await requireOrgContext()
  const [costCodes, contractsResult] = await Promise.all([
    listCostCodes(undefined, false),
    supabase
      .from("contracts")
      .select("id, title, number, project:projects(name)")
      .eq("org_id", orgId)
      .in("contract_type", ["cost_plus", "time_materials"])
      .order("created_at", { ascending: false }),
  ])

  if (contractsResult.error) {
    throw new Error(`Failed to load contracts: ${contractsResult.error.message}`)
  }

  return {
    costCodes,
    contracts: contractsResult.data ?? [],
  }
}

export async function createMarkupRuleFormAction(formData: FormData) {
  await requirePermissionGuard("org.admin")
  const scope = String(formData.get("scope") || "org") as "org" | "contract" | "cost_code"
  await createMarkupRule({
    scope,
    contractId: String(formData.get("contract_id") || "") || null,
    costCodeId: String(formData.get("cost_code_id") || "") || null,
    markupPercent: Number(formData.get("markup_percent") || 0),
    appliesToCategory: String(formData.get("applies_to_category") || "") || null,
    effectiveFrom: String(formData.get("effective_from") || "") ? new Date(String(formData.get("effective_from"))) : null,
    effectiveTo: String(formData.get("effective_to") || "") ? new Date(String(formData.get("effective_to"))) : null,
  })
  revalidatePath("/settings/markup-rules")
}

export async function deleteMarkupRuleFormAction(ruleId: string) {
  await requirePermissionGuard("org.admin")
  await deleteMarkupRule(ruleId)
  revalidatePath("/settings/markup-rules")
}
