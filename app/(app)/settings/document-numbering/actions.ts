"use server"
import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import { updateDocumentNumbering } from "@/lib/services/document-numbering"
import { documentNumberingSchema } from "@/lib/validation/document-numbering"

export async function updateDocumentNumberingAction(input: unknown): Promise<ActionResult<Awaited<ReturnType<typeof updateDocumentNumbering>>>> {
  try {
    const result = await updateDocumentNumbering(documentNumberingSchema.parse(input))
    revalidatePath("/settings/document-numbering")
    return { success: true, data: result }
  } catch (error) { return actionError(error) }
}

