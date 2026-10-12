"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  createHousePlan,
  createPlanVersion,
  releasePlanVersion,
  replaceTakeoffLines,
  updateHousePlan,
  updatePlanVersion,
  upsertElevation,
} from "@/lib/services/house-plans"
import { listProductDefinitionHistory } from "@/lib/services/home-product-revisions"
import {
  createPlanChangeProposal,
  decidePlanChangeHome,
  submitPlanChangeProposal,
  withdrawPlanChangeProposal,
} from "@/lib/services/plan-change-proposals"
import {
  elevationInputSchema,
  housePlanInputSchema,
  housePlanUpdateSchema,
  planVersionInputSchema,
  takeoffLineInputSchema,
} from "@/lib/validation/house-plans"
import { createPlanChangeProposalSchema, decidePlanChangeHomeSchema } from "@/lib/validation/plan-change-proposals"

async function run<T>(operation: () => Promise<T>, paths: string[]): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    for (const path of paths) revalidatePath(path)
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function createHousePlanAction(input: unknown) {
  return run(() => createHousePlan(housePlanInputSchema.parse(input)), ["/plans"])
}

export async function updateHousePlanAction(planId: string, input: unknown) {
  return run(() => updateHousePlan(z.string().uuid().parse(planId), housePlanUpdateSchema.parse(input)), ["/plans", `/plans/${planId}`])
}

export async function upsertElevationAction(planId: string, input: unknown) {
  return run(() => upsertElevation(z.string().uuid().parse(planId), elevationInputSchema.parse(input)), [`/plans/${planId}`])
}

export async function listElevationRevisionsAction(elevationId: string) {
  return run(() => listProductDefinitionHistory({ entityType: "house_plan_elevation", entityId: z.string().uuid().parse(elevationId) }), [])
}

export async function createPlanVersionAction(planId: string, input: unknown) {
  const parsed = z.object({ copyFromVersionId: z.string().uuid().optional().nullable(), label: z.string().trim().max(160).optional().nullable() }).parse(input)
  return run(() => createPlanVersion(z.string().uuid().parse(planId), parsed), [`/plans/${planId}`])
}

export async function updatePlanVersionAction(planId: string, versionId: string, input: unknown) {
  return run(() => updatePlanVersion(z.string().uuid().parse(versionId), planVersionInputSchema.parse(input)), [`/plans/${planId}`])
}

export async function replaceTakeoffLinesAction(planId: string, versionId: string, input: unknown) {
  const lines = z.array(takeoffLineInputSchema).max(2000).parse(input)
  return run(() => replaceTakeoffLines(z.string().uuid().parse(versionId), lines), [`/plans/${planId}`])
}

export async function releasePlanVersionAction(planId: string, versionId: string) {
  return run(() => releasePlanVersion(z.string().uuid().parse(versionId)), ["/plans", `/plans/${planId}`])
}


export async function createPlanChangeProposalAction(planId: string, input: unknown) {
  return run(() => createPlanChangeProposal(createPlanChangeProposalSchema.parse({ ...z.object({}).passthrough().parse(input), planId })), [`/plans/${planId}`])
}

export async function submitPlanChangeProposalAction(planId: string, proposalId: string) {
  return run(() => submitPlanChangeProposal(z.string().uuid().parse(proposalId)), [`/plans/${planId}`])
}

export async function withdrawPlanChangeProposalAction(planId: string, proposalId: string) {
  return run(() => withdrawPlanChangeProposal(z.string().uuid().parse(proposalId)), [`/plans/${planId}`])
}

export async function decidePlanChangeHomeAction(planId: string, input: unknown) {
  return run(() => decidePlanChangeHome(decidePlanChangeHomeSchema.parse(input)), [`/plans/${planId}`])
}
