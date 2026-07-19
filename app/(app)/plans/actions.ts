"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  createHousePlan,
  createPlanVersion,
  releasePlanVersion,
  replaceTakeoffLines,
  setCommunityAvailability,
  updateHousePlan,
  updatePlanVersion,
  upsertElevation,
} from "@/lib/services/house-plans"
import {
  availabilityInputSchema,
  elevationInputSchema,
  housePlanInputSchema,
  housePlanUpdateSchema,
  planVersionInputSchema,
  takeoffLineInputSchema,
} from "@/lib/validation/house-plans"

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

export async function setCommunityAvailabilityAction(planId: string, input: unknown) {
  const entries = z.array(availabilityInputSchema).max(2000).parse(input)
  return run(() => setCommunityAvailability(entries), ["/plans", `/plans/${planId}`])
}
