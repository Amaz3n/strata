"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { listCompletionInspections } from "@/lib/services/po-completions"
import { listCommitmentChangeOrders, updateCommitmentChangeOrder } from "@/lib/services/commitment-change-orders"
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

/** Adds files to the evidence a variance order already carries; the files must be this home's own. */
export async function attachVpoEvidenceAction(projectId: string, commitmentChangeOrderId: string, commitmentId: string, fileIds: string[]) {
  return await run(async () => {
    const ids = z.array(z.string().uuid()).min(1).max(20).parse(fileIds)
    const orders = await listCommitmentChangeOrders({ commitmentId: z.string().uuid().parse(commitmentId) })
    const order = orders.find((row) => row.id === z.string().uuid().parse(commitmentChangeOrderId))
    if (!order) throw new Error("Variance order not found.")
    return await updateCommitmentChangeOrder({
      commitmentChangeOrderId: order.id,
      input: { evidence_file_ids: [...new Set([...order.evidence_file_ids, ...ids])].slice(0, 20) },
    })
  }, z.string().uuid().parse(projectId))
}

export async function listCompletionInspectionsAction(completionId: string) {
  return await run(() => listCompletionInspections(z.string().uuid().parse(completionId)))
}
