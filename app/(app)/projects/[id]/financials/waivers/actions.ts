"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import { createSubtierWaiverRequirement } from "@/lib/services/lien-waivers"

export interface CreateSubtierRequirementInput {
  projectId: string
  commitmentId: string
  throughCompanyId: string
  claimantCompanyName: string
  periodEnd: string
  amountCents: number
  waiverType: "conditional" | "unconditional" | "final"
}

export async function createSubtierRequirementAction(
  input: CreateSubtierRequirementInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const result = await createSubtierWaiverRequirement({
      project_id: input.projectId,
      commitment_id: input.commitmentId,
      through_company_id: input.throughCompanyId,
      claimant_company_name: input.claimantCompanyName,
      period_end: input.periodEnd,
      amount_cents: input.amountCents,
      waiver_type: input.waiverType,
    })
    revalidatePath(`/projects/${input.projectId}/financials/waivers`)
    return { success: true, data: { id: result.id } }
  } catch (error) {
    return actionError(error, "Could not add claimant")
  }
}
