"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  archiveCatalogEntity,
  cloneOrgGroupsToCommunity,
  setCatalogPrice,
  upsertAppointment,
  upsertCategory,
  upsertOption,
  upsertPackage,
  upsertSelectionGroup,
} from "@/lib/services/option-catalog"
import { recomputeCommunityCutoffs, overrideGroupCutoff, revertCutoffToSchedule } from "@/lib/services/selection-cutoffs"
import { createPostCutoffSelectionChangeOrder } from "@/lib/services/selection-change-orders"
import { requireOrgContext } from "@/lib/services/context"

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/design-studio")
    revalidatePath("/selections")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function upsertCategoryAction(input: unknown) {
  return run(() => upsertCategory(input as Parameters<typeof upsertCategory>[0]))
}

export async function upsertOptionAction(input: unknown) {
  return run(() => upsertOption(input as Parameters<typeof upsertOption>[0]))
}

export async function upsertPackageAction(input: unknown) {
  return run(() => upsertPackage(input as Parameters<typeof upsertPackage>[0]))
}

export async function setCatalogPriceAction(input: unknown) {
  return run(() => setCatalogPrice(input as Parameters<typeof setCatalogPrice>[0]))
}

export async function upsertSelectionGroupAction(input: unknown) {
  return run(async () => {
    const saved = await upsertSelectionGroup(input as Parameters<typeof upsertSelectionGroup>[0])
    if (saved.community_id) {
      const { orgId } = await requireOrgContext()
      await recomputeCommunityCutoffs(saved.community_id, orgId)
    }
    return saved
  })
}

export async function upsertAppointmentAction(input: unknown) {
  return run(() => upsertAppointment(input as Parameters<typeof upsertAppointment>[0]))
}

export async function archiveCatalogEntityAction(input: unknown) {
  const schema = z.object({ type: z.enum(["category", "option", "package"]), id: z.string().uuid(), archived: z.boolean().optional() })
  return run(() => archiveCatalogEntity(schema.parse(input)))
}

export async function cloneOrgGroupsAction(communityId: string) {
  return run(() => cloneOrgGroupsToCommunity(z.string().uuid().parse(communityId)))
}

export async function overrideGroupCutoffAction(input: unknown) {
  return run(() => overrideGroupCutoff(input as Parameters<typeof overrideGroupCutoff>[0]))
}

export async function revertGroupCutoffAction(input: unknown) {
  const parsed = z.object({ projectId: z.string().uuid(), groupId: z.string().uuid() }).parse(input)
  return run(() => revertCutoffToSchedule(parsed))
}

export async function createPostCutoffChangeOrderAction(input: unknown) {
  return run(() => createPostCutoffSelectionChangeOrder(input as Parameters<typeof createPostCutoffSelectionChangeOrder>[0]))
}
