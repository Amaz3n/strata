"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import { acknowledgePoFromPortal } from "@/lib/services/po-acknowledgments"
import { reportPoCompletionFromPortal } from "@/lib/services/po-completions"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { uploadPortalFile } from "@/lib/services/portal-uploads"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function reportPurchaseOrderCompleteAction(token: string, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, requireProject: true, permission: "can_report_po_completion" })
    const commitmentId = String(formData.get("commitment_id") ?? "")
    const lineIds = formData.getAll("commitment_line_id").map(String).filter(Boolean)
    const changeOrderIds = formData.getAll("change_order_id").map(String).filter(Boolean)
    if (lineIds.length === 0 && changeOrderIds.length === 0 && formData.get("scope_listed") === "true") throw new Error("Choose what is complete.")
    const files = formData.getAll("photos").filter((value): value is File => value instanceof File && value.size > 0)
    if (files.length === 0) throw new Error("Attach at least one completion photo.")
    if (files.length > 20) throw new Error("Attach no more than 20 photos.")
    const photoFileIds = await Promise.all(files.map((file) => uploadPortalFile({
      file, orgId: access.org_id, projectId: access.project_id, category: "photos",
      folderPath: "Purchase Orders/Completion Photos", metadata: { source: "po_completion", commitment_id: commitmentId },
    })))
    const result = await reportPoCompletionFromPortal(token, {
      commitment_id: commitmentId,
      // Variance orders alone are reported against no PO line (an empty list), never as the whole order.
      commitment_line_ids: lineIds.length ? lineIds : changeOrderIds.length ? [] : undefined,
      change_order_ids: changeOrderIds.length ? changeOrderIds : undefined,
      notes: String(formData.get("notes") ?? "").trim() || null,
      photo_file_ids: photoFileIds.filter((id): id is string => Boolean(id)),
    })
    revalidatePath(`/s/${token}/purchase-orders`)
    return { success: true, data: { id: result.id } }
  } catch (error) {
    return actionError(error)
  }
}

export async function acknowledgePurchaseOrderAction(token: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, permission: "can_acknowledge_purchase_orders" })
    if (!access.company_id) throw new Error("This link is missing your company")
    const { data: company } = await createServiceSupabaseClient().from("companies")
      .select("name").eq("org_id", access.org_id).eq("id", access.company_id).maybeSingle()
    const result = await acknowledgePoFromPortal(access, input, company?.name ?? "A vendor")
    revalidatePath(`/s/${token}/purchase-orders`)
    return { success: true, data: result }
  } catch (error) {
    return actionError(error)
  }
}
