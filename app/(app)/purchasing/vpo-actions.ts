"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { listCompletionInspections, reportUnclaimedVariancePoCompletion } from "@/lib/services/po-completions"
import { attachVarianceOrderEvidence } from "@/lib/services/commitment-change-orders"
import { getProjectPoPositions } from "@/lib/services/po-positions"
import { listVarianceReasonCodes } from "@/lib/services/purchasing-settings"

async function run<T>(operation: () => Promise<T>, projectId?: string): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/purchasing")
    if (projectId) revalidatePath(`/projects/${projectId}/financials`)
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function listVarianceReasonsAction() {
  return await run(() => listVarianceReasonCodes())
}

export async function getProjectPoPositionsAction(projectId: string) {
  return await run(() => getProjectPoPositions(z.string().uuid().parse(projectId)))
}

/** Adds files to the evidence a pending variance order carries; the files must be this home's own. */
export async function attachVpoEvidenceAction(projectId: string, commitmentChangeOrderId: string, fileIds: string[]) {
  return await run(() => attachVarianceOrderEvidence({ commitmentChangeOrderId: z.string().uuid().parse(commitmentChangeOrderId), fileIds }), z.string().uuid().parse(projectId))
}

export async function listCompletionInspectionsAction(completionId: string) {
  return await run(() => listCompletionInspections(z.string().uuid().parse(completionId)))
}

export async function reportVariancePoCompletionAction(projectId: string, commitmentId: string) {
  return await run(() => reportUnclaimedVariancePoCompletion(z.string().uuid().parse(commitmentId)), z.string().uuid().parse(projectId))
}
