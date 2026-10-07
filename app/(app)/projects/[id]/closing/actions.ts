"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { recoverClosingCompletion, markClearedToClose, removeClosingAdjustment, reverseClosing, scheduleClosing, settleClosing, updateClosingChecklistItem, upsertClosingAdjustment } from "@/lib/services/closings"
import { generateSettlementStatementPdf } from "@/lib/services/reports/settlement-statement"

async function run<T>(projectId: string, operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath(`/projects/${projectId}/closing`)
    revalidatePath("/sales")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function scheduleClosingAction(projectId: string, input: unknown) { return run(projectId, () => scheduleClosing(input)) }
export async function updateClosingChecklistItemAction(projectId: string, input: unknown) { return run(projectId, () => updateClosingChecklistItem(input)) }
export async function markClearedToCloseAction(projectId: string, closingId: string) { return run(projectId, () => markClearedToClose(z.string().uuid().parse(closingId))) }
export async function settleClosingAction(projectId: string, input: unknown) { return run(projectId, () => settleClosing(input)) }
export async function upsertClosingAdjustmentAction(projectId: string, input: unknown) { return run(projectId, () => upsertClosingAdjustment(input)) }
export async function removeClosingAdjustmentAction(projectId: string, closingId: string, adjustmentId: string) { return run(projectId, () => removeClosingAdjustment({ closingId: z.string().uuid().parse(closingId), adjustmentId: z.string().uuid().parse(adjustmentId) })) }

/** The statement the buyer signs at the table, downloadable before the closing settles as well as after. */
export async function downloadSettlementStatementAction(projectId: string) {
  return run(projectId, async () => {
    const { fileName, pdf } = await generateSettlementStatementPdf(z.string().uuid().parse(projectId))
    return { fileName, pdfBase64: pdf.toString("base64") }
  })
}

export async function reverseClosingAction(projectId: string, input: { closingId: string; reason: string; date: string }) {
  return run(projectId, () => reverseClosing(z.object({ closingId: z.string().uuid(), reason: z.string().trim().min(10).max(2000), date: z.string().date() }).parse(input)))
}
export async function recoverClosingCompletionAction(projectId: string, closingId: string) { return run(projectId, () => recoverClosingCompletion(z.string().uuid().parse(projectId), z.string().uuid().parse(closingId))) }
