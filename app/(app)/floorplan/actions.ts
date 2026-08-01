"use server"

/**
 * Floorplan-model mutations — one home for both postures.
 *
 * The plan workbench and the project drawings page are two surfaces onto the
 * same capability, so they share these actions rather than each growing their
 * own copy. Which anchor a call carries is the caller's business; everything
 * below treats a plan version and a project identically.
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import type { FloorplanEdit } from "@/lib/drawings/floorplan-model"
import {
  applyFloorplanCorrections,
  getFloorplanModelWithSheets,
  getPublishedFloorplanModelForPlan,
  interpretAllActivePlans,
  publishFloorplanModel,
  requestFloorplanInterpretation,
  unpublishFloorplanModel,
  type FloorplanTarget,
} from "@/lib/services/floorplan-models"
import { floorplanEditsSchema, floorplanTargetSchema } from "@/lib/validation/floorplan"

async function run<T>(operation: () => Promise<T>, paths: string[]): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    for (const path of paths) revalidatePath(path)
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * Which pages a change to this model invalidates.
 *
 * Derived from the anchor rather than passed in, so a caller cannot forget the
 * surface its own edit is visible on.
 */
function pathsFor(target: FloorplanTarget, planId?: string | null): string[] {
  if (target.kind === "project") return [`/projects/${target.projectId}/drawings`]
  return planId ? ["/plans", `/plans/${planId}`] : ["/plans"]
}

export async function loadFloorplanModelAction(target: unknown) {
  try {
    const parsed = floorplanTargetSchema.parse(target) as FloorplanTarget
    return { success: true as const, data: await getFloorplanModelWithSheets(parsed) }
  } catch (error) {
    return actionError(error)
  }
}

export async function interpretFloorplanAction(target: unknown, force = false, planId?: string) {
  const parsed = floorplanTargetSchema.parse(target) as FloorplanTarget
  return run(
    () => requestFloorplanInterpretation({ target: parsed, force: z.boolean().parse(force) }),
    pathsFor(parsed, planId),
  )
}

export async function correctFloorplanAction(target: unknown, edits: unknown, planId?: string) {
  const parsed = floorplanTargetSchema.parse(target) as FloorplanTarget
  return run(
    () =>
      applyFloorplanCorrections({
        target: parsed,
        edits: floorplanEditsSchema.parse(edits) as FloorplanEdit[],
      }),
    pathsFor(parsed, planId),
  )
}

export async function publishFloorplanAction(target: unknown, planId?: string) {
  const parsed = floorplanTargetSchema.parse(target) as FloorplanTarget
  return run(() => publishFloorplanModel({ target: parsed }), pathsFor(parsed, planId))
}

export async function unpublishFloorplanAction(target: unknown, planId?: string) {
  const parsed = floorplanTargetSchema.parse(target) as FloorplanTarget
  return run(() => unpublishFloorplanModel({ target: parsed }), pathsFor(parsed, planId))
}

export async function interpretAllActivePlansAction() {
  return run(() => interpretAllActivePlans(), ["/plans"])
}

/** The published model for a plan — what the offering page's 3D button opens. */
export async function loadPublishedFloorplanModelAction(planId: string) {
  try {
    const record = await getPublishedFloorplanModelForPlan(z.string().uuid().parse(planId))
    return { success: true as const, data: record?.model ?? null }
  } catch (error) {
    return actionError(error)
  }
}
