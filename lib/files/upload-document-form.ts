"use client"

import { uploadFileAction as uploadOrgFileAction } from "@/app/(app)/documents/actions"
import type { FileWithUrls } from "@/app/(app)/documents/types"
import { actionError, type ActionResult } from "@/lib/action-result"
import { fileCategorySchema } from "@/lib/validation/files"
import { getActiveDocumentTransferQueue } from "./active-transfer-queue"

function formString(form: FormData, key: string): string | undefined {
  const value = form.get(key)
  return typeof value === "string" && value.length > 0 ? value : undefined
}
function formBoolean(form: FormData, key: string): boolean | undefined {
  const value = form.get(key)
  return typeof value === "string" ? value === "true" : undefined
}

/** Preserve the existing form contract while project uploads use the shared resumable queue. */
export async function uploadDocumentForm(form: FormData): Promise<ActionResult<FileWithUrls>> {
  try {
    const file = form.get("file")
    if (!(file instanceof File)) throw new Error("No file provided")
    const projectId = formString(form, "projectId")
    // Organization-owned assets (plan catalogs, unassigned bills) have no project queue scope.
    if (!projectId) return await uploadOrgFileAction(form)
    const category = formString(form, "category")
    const folder = form.get("folderPath")
    const tags = formString(form, "tags")
    const result = await getActiveDocumentTransferQueue().enqueue(file, {
      projectId,
      category: category ? fileCategorySchema.parse(category) : undefined,
      folderPath: form.has("folderPath") ? typeof folder === "string" ? folder : null : undefined,
      visibility: formString(form, "visibility") === "private" ? "private" : "public",
      description: formString(form, "description"),
      tags: tags ? tags.split(",").map(tag => tag.trim()).filter(Boolean) : [],
      shareWithClients: formBoolean(form, "shareWithClients"),
      shareWithSubs: formBoolean(form, "shareWithSubs"),
    })
    if ("file_id" in result) throw new Error("Upload returned a version instead of a document")
    return { success: true, data: result }
  } catch (error) {
    return actionError(error, "Could not upload file")
  }
}
