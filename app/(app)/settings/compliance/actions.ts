"use server"

import {
  getComplianceRules,
  getDefaultComplianceRequirements,
  updateComplianceRules,
  updateDefaultComplianceRequirements,
} from "@/lib/services/compliance"
import type { ComplianceRequirementTemplateItem, ComplianceRules } from "@/lib/types"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function getComplianceRulesAction() {
      return getComplianceRules()
}

export async function updateComplianceRulesAction(rules: ComplianceRules) {
  return run(async () => {
      return updateComplianceRules({ rules })
  })
}

export async function getDefaultComplianceRequirementsAction() {
      return getDefaultComplianceRequirements()
}

export async function updateDefaultComplianceRequirementsAction(requirements: ComplianceRequirementTemplateItem[]) {
  return run(async () => {
      return updateDefaultComplianceRequirements({ requirements })
  })
}
