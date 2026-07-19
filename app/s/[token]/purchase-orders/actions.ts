"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import { reportPoCompletionFromPortal } from "@/lib/services/po-completions"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { uploadPortalFile } from "@/lib/services/portal-uploads"

export async function reportPurchaseOrderCompleteAction(token: string, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, permission: "can_report_po_completion" })
    const commitmentId = String(formData.get("commitment_id") ?? "")
    const lineIds = formData.getAll("commitment_line_id").map(String).filter(Boolean)
    const files = formData.getAll("photos").filter((value): value is File => value instanceof File && value.size > 0)
    if (files.length === 0) throw new Error("Attach at least one completion photo.")
    if (files.length > 20) throw new Error("Attach no more than 20 photos.")
    const photoFileIds = await Promise.all(files.map((file) => uploadPortalFile({
      file, orgId: access.org_id, projectId: access.project_id, category: "photos",
      folderPath: "Purchase Orders/Completion Photos", metadata: { source: "po_completion", commitment_id: commitmentId },
    })))
    const result = await reportPoCompletionFromPortal(token, {
      commitment_id: commitmentId,
      commitment_line_ids: lineIds.length ? lineIds : undefined,
      notes: String(formData.get("notes") ?? "").trim() || null,
      photo_file_ids: photoFileIds.filter((id): id is string => Boolean(id)),
    })
    revalidatePath(`/s/${token}/purchase-orders`)
    return { success: true, data: { id: result.id } }
  } catch (error) {
    return actionError(error)
  }
}
