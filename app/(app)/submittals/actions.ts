"use server"

import { revalidatePath } from "next/cache"

import {
  addSubmittalItem,
  createSubmittal,
  decideSubmittal,
  listSubmittalItems,
  listSubmittalRevisions,
  listSubmittals,
  resubmitSubmittal,
  updateSubmittal,
} from "@/lib/services/submittals"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { actionError, type ActionResult } from "@/lib/action-result"
import {
  submittalDecisionSchema,
  submittalInputSchema,
  submittalItemInputSchema,
  submittalUpdateSchema,
} from "@/lib/validation/submittals"
import type { Submittal, SubmittalItem } from "@/lib/types"

function revalidateSubmittalPaths(projectId: string) {
  revalidatePath("/submittals")
  revalidatePath(`/projects/${projectId}/submittals`)
}

export async function listSubmittalsAction(projectId?: string) {
  return listSubmittals(undefined, projectId)
}

export async function listSubmittalItemsAction(submittalId: string): Promise<SubmittalItem[]> {
  const { orgId, userId, supabase } = await requireOrgContext()
  await requirePermission("submittal.read", { supabase, orgId, userId })
  return listSubmittalItems({ orgId, submittalId })
}

export async function listSubmittalRevisionsAction(
  projectId: string,
  submittalNumber: number,
): Promise<Submittal[]> {
  const { orgId, userId, supabase } = await requireOrgContext()
  await requirePermission("submittal.read", { supabase, orgId, userId })
  return listSubmittalRevisions({ orgId, projectId, submittalNumber })
}

export async function createSubmittalAction(input: unknown): Promise<ActionResult<Submittal>> {
  try {
    const parsed = submittalInputSchema.parse(input)
    const submittal = await createSubmittal({ input: parsed })
    revalidateSubmittalPaths(submittal.project_id)
    return { success: true, data: submittal }
  } catch (error) {
    return actionError(error)
  }
}

export async function updateSubmittalAction(input: unknown): Promise<ActionResult<Submittal>> {
  try {
    const parsed = submittalUpdateSchema.parse(input)
    const submittal = await updateSubmittal({ input: parsed })
    revalidateSubmittalPaths(submittal.project_id)
    return { success: true, data: submittal }
  } catch (error) {
    return actionError(error)
  }
}

export async function decideSubmittalAction(input: unknown): Promise<ActionResult<Submittal>> {
  try {
    const parsed = submittalDecisionSchema.parse(input)
    const submittal = await decideSubmittal({ input: parsed })
    revalidateSubmittalPaths(submittal.project_id)
    return { success: true, data: submittal }
  } catch (error) {
    return actionError(error)
  }
}

export async function resubmitSubmittalAction(submittalId: string): Promise<ActionResult<Submittal>> {
  try {
    const submittal = await resubmitSubmittal({ submittalId })
    revalidateSubmittalPaths(submittal.project_id)
    return { success: true, data: submittal }
  } catch (error) {
    return actionError(error)
  }
}

export async function addSubmittalItemAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const { orgId, userId, supabase } = await requireOrgContext()
    await requirePermission("submittal.write", { supabase, orgId, userId })
    const parsed = submittalItemInputSchema.parse(input)
    await addSubmittalItem({
      orgId,
      input: { ...parsed, responder_user_id: userId, created_via_portal: false, portal_token_id: null },
    })
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}
