"use server"

import {
  getComplianceRules,
  getDefaultComplianceRequirements,
  updateComplianceRules,
  updateDefaultComplianceRequirements,
} from "@/lib/services/compliance"
import type { ComplianceRequirementTemplateItem, ComplianceRules } from "@/lib/types"

export async function getComplianceRulesAction() {
  return getComplianceRules()
}

export async function updateComplianceRulesAction(rules: ComplianceRules) {
  return updateComplianceRules({ rules })
}

export async function getDefaultComplianceRequirementsAction() {
  return getDefaultComplianceRequirements()
}

export async function updateDefaultComplianceRequirementsAction(requirements: ComplianceRequirementTemplateItem[]) {
  return updateDefaultComplianceRequirements({ requirements })
}
