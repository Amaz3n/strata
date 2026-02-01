"use server"

import { revalidatePath } from "next/cache"

import {
  createOpportunity,
  updateOpportunity,
  getOpportunity,
  startEstimating,
} from "@/lib/services/opportunities"
import {
  createOpportunityInputSchema,
  updateOpportunityInputSchema,
} from "@/lib/validation/opportunities"

function revalidateOpportunityPaths(opportunityId?: string) {
  revalidatePath("/pipeline")
  if (opportunityId) {
    revalidatePath(`/pipeline?opportunity=${opportunityId}`)
  }
}

export async function createOpportunityAction(input: unknown) {
  const parsed = createOpportunityInputSchema.parse(input)
  const opportunity = await createOpportunity({ input: parsed })
  revalidateOpportunityPaths(opportunity.id)
  return opportunity
}

export async function updateOpportunityAction(opportunityId: string, input: unknown) {
  const parsed = updateOpportunityInputSchema.parse(input)
  const opportunity = await updateOpportunity({ opportunityId, input: parsed })
  revalidateOpportunityPaths(opportunity.id)
  return opportunity
}

export async function getOpportunityAction(opportunityId: string) {
  return getOpportunity(opportunityId)
}

export async function startEstimatingAction(opportunityId: string) {
  const result = await startEstimating({ opportunityId })
  revalidatePath("/pipeline")
  revalidatePath("/projects")
  revalidatePath("/estimates")
  return result
}
