"use server"

import { revalidatePath } from "next/cache"
import { createSubtierWaiverRequirement } from "@/lib/services/lien-waivers"

export async function createSubtierRequirementAction(projectId: string, formData: FormData) {
  const commitmentId = String(formData.get("commitment_id") ?? "")
  const throughCompanyId = String(formData.get("through_company_id") ?? "")
  const claimantCompanyName = String(formData.get("claimant_company_name") ?? "")
  const periodEnd = String(formData.get("period_end") ?? "")
  const amount = Number(formData.get("amount_dollars") ?? 0)
  const waiverType = String(formData.get("waiver_type") ?? "conditional") as "conditional" | "unconditional" | "final"
  const result = await createSubtierWaiverRequirement({ project_id: projectId, commitment_id: commitmentId, through_company_id: throughCompanyId, claimant_company_name: claimantCompanyName, period_end: periodEnd, amount_cents: Math.round(amount * 100), waiver_type: waiverType })
  revalidatePath(`/projects/${projectId}/financials/waivers`)
  return result
}
