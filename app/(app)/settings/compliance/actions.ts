"use server"

import { getComplianceRules, updateComplianceRules } from "@/lib/services/compliance"
import type { ComplianceRules } from "@/lib/types"

export async function getComplianceRulesAction() {
  return getComplianceRules()
}

export async function updateComplianceRulesAction(rules: ComplianceRules) {
  return updateComplianceRules({ rules })
}
