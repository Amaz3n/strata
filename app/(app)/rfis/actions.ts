"use server"

import { revalidatePath } from "next/cache"

import {
  createRfi,
  listRfis,
  listRfiResponses,
  addRfiResponse,
  decideRfi,
  sendRfi,
  closeRfi,
  reopenRfi,
  convertRfiToChangeOrder,
  getRfiLinkedChangeOrder,
  type RfiLinkedChangeOrder,
} from "@/lib/services/rfis"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { actionError, type ActionResult } from "@/lib/action-result"
import { createRfiRequestSchema, rfiResponseInputSchema, rfiDecisionSchema } from "@/lib/validation/rfis"
import type { ChangeOrder, Rfi } from "@/lib/types"

export async function listRfisAction(projectId?: string) {
  return listRfis(undefined, projectId)
}

export async function listRfiResponsesAction(rfiId: string) {
  const { orgId, userId, supabase } = await requireOrgContext()
  await requirePermission("rfi.read", { supabase, orgId, userId })
  return listRfiResponses({ orgId, rfiId })
}

export async function getRfiLinkedChangeOrderAction(rfiId: string): Promise<ActionResult<RfiLinkedChangeOrder | null>> {
  try {
    return { success: true, data: await getRfiLinkedChangeOrder({ rfiId }) }
  } catch (error) {
    return actionError(error)
  }
}

export async function createRfiAction(input: unknown): Promise<ActionResult<Rfi>> {
  try {
    const parsed = createRfiRequestSchema.parse(input)
    const rfi = await createRfi({ input: parsed, sendNow: parsed.send_now })
    revalidatePath("/rfis")
    revalidatePath(`/projects/${rfi.project_id}/rfis`)
    return { success: true, data: rfi }
  } catch (error) {
    return actionError(error)
  }
}

export async function sendRfiAction(rfiId: string): Promise<ActionResult<Rfi>> {
  try {
    const rfi = await sendRfi({ rfiId })
    revalidatePath("/rfis")
    revalidatePath(`/projects/${rfi.project_id}/rfis`)
    return { success: true, data: rfi }
  } catch (error) {
    return actionError(error)
  }
}

export async function addRfiResponseAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const parsed = rfiResponseInputSchema.parse(input)
    await addRfiResponse({ orgId: undefined, input: parsed })
    revalidatePath("/rfis")
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}

export async function decideRfiAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const parsed = rfiDecisionSchema.parse(input)
    await decideRfi({ orgId: undefined, input: parsed })
    revalidatePath("/rfis")
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}

export async function closeRfiAction(rfiId: string): Promise<ActionResult<Rfi>> {
  try {
    const rfi = await closeRfi({ rfiId })
    revalidatePath("/rfis")
    revalidatePath(`/projects/${rfi.project_id}/rfis`)
    return { success: true, data: rfi }
  } catch (error) {
    return actionError(error)
  }
}

export async function reopenRfiAction(rfiId: string): Promise<ActionResult<Rfi>> {
  try {
    const rfi = await reopenRfi({ rfiId })
    revalidatePath("/rfis")
    revalidatePath(`/projects/${rfi.project_id}/rfis`)
    return { success: true, data: rfi }
  } catch (error) {
    return actionError(error)
  }
}

export async function convertRfiToChangeOrderAction(rfiId: string): Promise<ActionResult<ChangeOrder>> {
  try {
    const changeOrder = await convertRfiToChangeOrder({ rfiId })
    revalidatePath("/rfis")
    revalidatePath(`/projects/${changeOrder.project_id}/change-orders`)
    return { success: true, data: changeOrder }
  } catch (error) {
    return actionError(error)
  }
}
