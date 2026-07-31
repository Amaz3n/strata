"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { expandLotRange } from "@/lib/land/lot-range"
import {
  archiveCommunity,
  closeLotTakedown,
  createCommunity,
  createCommunityPhase,
  createLotTakedown,
  deleteCommunityPhase,
  updateCommunity,
  updateCommunityPhase,
  updateLotTakedown,
} from "@/lib/services/communities"
import {
  assignCommunityMember,
  removeCommunityAssignment,
} from "@/lib/services/community-assignments"
import { listCommunityInventoryLotIds } from "@/lib/services/community-inventory"
import { logCommunityTraffic } from "@/lib/services/community-traffic"
import {
  attachProjectToLot,
  bulkUpdateLots,
  createLots,
  deleteLot,
  detachProjectFromLot,
  setLotPlatPositions,
  setLotStatus,
  updateLot,
} from "@/lib/services/lots"
import {
  communityAssignmentInputSchema,
  communityInputSchema,
  communityTrafficInputSchema,
  communityUpdateSchema,
  phaseInputSchema,
  phaseUpdateSchema,
  takedownInputSchema,
  takedownUpdateSchema,
} from "@/lib/validation/communities"
import {
  bulkLotPatchSchema,
  createLotsInputSchema,
  lotRangeSchema,
  lotStatusSchema,
  lotStatusValueSchema,
  lotUpdateSchema,
} from "@/lib/validation/lots"

async function run<T>(operation: () => Promise<T>, paths: string[] = []): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    for (const path of paths) revalidatePath(path)
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function createCommunityAction(input: unknown) {
  return run(() => createCommunity(communityInputSchema.parse(input)), ["/communities"])
}

export async function updateCommunityAction(id: string, input: unknown) {
  return run(() => updateCommunity(z.string().uuid().parse(id), communityUpdateSchema.parse(input)), ["/communities", `/communities/${id}`])
}

export async function archiveCommunityAction(id: string) {
  return run(() => archiveCommunity(z.string().uuid().parse(id)), ["/communities", `/communities/${id}`])
}

export async function assignCommunityMemberAction(input: unknown) {
  const parsed = communityAssignmentInputSchema.parse(input)
  return run(() => assignCommunityMember(parsed), ["/communities", `/communities/${parsed.communityId}/team`])
}

export async function removeCommunityAssignmentAction(id: string) {
  return run(() => removeCommunityAssignment(z.string().uuid().parse(id)), ["/communities"])
}

export async function logCommunityTrafficAction(input: unknown) {
  const parsed = communityTrafficInputSchema.parse(input)
  return run(() => logCommunityTraffic(parsed), [
    "/communities",
    `/communities/${parsed.communityId}`,
    `/communities/${parsed.communityId}/offering`,
  ])
}

export async function createCommunityPhaseAction(communityId: string, input: unknown) {
  return run(() => createCommunityPhase(z.string().uuid().parse(communityId), phaseInputSchema.parse(input)), [`/communities/${communityId}`, `/communities/${communityId}/land`])
}

export async function updateCommunityPhaseAction(id: string, communityId: string, input: unknown) {
  return run(() => updateCommunityPhase(z.string().uuid().parse(id), phaseUpdateSchema.parse(input)), [`/communities/${communityId}`, `/communities/${communityId}/land`])
}

export async function deleteCommunityPhaseAction(id: string, communityId: string) {
  return run(() => deleteCommunityPhase(z.string().uuid().parse(id)), [`/communities/${communityId}`, `/communities/${communityId}/land`])
}

// The desk projects every community's runway off the takedown schedule, so the
// board is revalidated alongside the workbench whenever a takedown moves.
export async function createLotTakedownAction(communityId: string, input: unknown) {
  return run(() => createLotTakedown(z.string().uuid().parse(communityId), takedownInputSchema.parse(input)), ["/communities", `/communities/${communityId}`, `/communities/${communityId}/land`])
}

export async function updateLotTakedownAction(id: string, communityId: string, input: unknown) {
  return run(() => updateLotTakedown(z.string().uuid().parse(id), takedownUpdateSchema.parse(input)), ["/communities", `/communities/${communityId}`, `/communities/${communityId}/land`])
}

export async function closeLotTakedownAction(id: string, communityId: string, actualDate: string) {
  return run(() => closeLotTakedown(z.string().uuid().parse(id), { actualDate: z.string().date().parse(actualDate) }), ["/communities", `/communities/${communityId}`, `/communities/${communityId}/land`])
}

export async function createLotsAction(communityId: string, input: unknown) {
  return run(() => createLots(z.string().uuid().parse(communityId), createLotsInputSchema.parse(input)), [`/communities/${communityId}`])
}

export async function createLotRangeAction(communityId: string, input: unknown) {
  return run(() => {
    const parsed = lotRangeSchema.parse(input)
    // Swing and premium genuinely vary lot to lot, so they stay inspector edits
    // rather than a value applied to a whole range.
    const lots = expandLotRange(parsed).map((lot) => ({ ...lot, swing: "either" as const, premiumCents: 0 }))
    return createLots(z.string().uuid().parse(communityId), { lots })
  }, [`/communities/${communityId}`])
}

export async function updateLotAction(id: string, communityId: string, input: unknown) {
  return run(() => updateLot(z.string().uuid().parse(id), lotUpdateSchema.parse(input)), [`/communities/${communityId}`])
}

const inventorySelectionSchema = z.object({
  status: lotStatusValueSchema.optional(),
  phaseId: z.string().uuid().optional(),
  search: z.string().trim().max(60).optional(),
})

/**
 * The ids behind "select all matching". The inventory table pages, so without
 * this a bulk edit could only ever reach the hundred rows on screen — and
 * re-phasing a release tranche is exactly the edit that spans pages.
 */
export async function listMatchingLotIdsAction(communityId: string, input: unknown) {
  return run(() =>
    listCommunityInventoryLotIds(z.string().uuid().parse(communityId), inventorySelectionSchema.parse(input)),
  )
}

export async function bulkUpdateLotsAction(communityId: string, input: unknown) {
  return run(() => bulkUpdateLots(z.string().uuid().parse(communityId), bulkLotPatchSchema.parse(input)), [`/communities/${communityId}`])
}

export async function setLotStatusAction(id: string, communityId: string, input: unknown) {
  return run(() => { const parsed = lotStatusSchema.parse(input); return setLotStatus(z.string().uuid().parse(id), parsed.status, { force: parsed.force }) }, [`/communities/${communityId}`])
}

export async function attachProjectToLotAction(lotId: string, communityId: string, projectId: string) {
  return run(() => attachProjectToLot(z.string().uuid().parse(lotId), z.string().uuid().parse(projectId)), [`/communities/${communityId}`, `/projects/${projectId}`])
}

export async function detachProjectFromLotAction(lotId: string, communityId: string) {
  return run(() => detachProjectFromLot(z.string().uuid().parse(lotId)), [`/communities/${communityId}`])
}

export async function deleteLotAction(lotId: string, communityId: string) {
  return run(() => deleteLot(z.string().uuid().parse(lotId)), [`/communities/${communityId}`])
}

const platPositionsSchema = z
  .array(
    z.object({
      lotId: z.string().uuid(),
      platX: z.number().int().min(0).max(400),
      platY: z.number().int().min(0).max(400),
    }),
  )
  .max(1_000)

export async function setLotPlatPositionsAction(communityId: string, input: unknown) {
  return run(
    () => setLotPlatPositions(z.string().uuid().parse(communityId), platPositionsSchema.parse(input)),
    [`/communities/${communityId}`],
  )
}
