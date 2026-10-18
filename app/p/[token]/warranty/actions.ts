"use server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { actionError, type ActionResult } from "@/lib/action-result"
import { confirmWarrantyVisitByBuyer, createWarrantyRequestFromPortal, requestWarrantyVisitRescheduleByBuyer, signOffWarrantyVisitFromPortal, type WarrantyServiceVisitDTO } from "@/lib/services/warranty"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { uploadPortalFile } from "@/lib/services/portal-uploads"
import { warrantyRequestInputSchema } from "@/lib/validation/warranty"

export async function createWarrantyRequestPortalAction(token: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, {
    portalType: "client",
    requireProject: true,
    permission: "can_view_warranty",
  })

  const photo = formData.get("photo") as File | null
  const fileId = photo && photo.size > 0 ? await uploadPortalFile({
    file: photo,
    orgId: access.org_id,
    projectId: access.project_id,
    category: "warranty",
    folderPath: "/warranty",
    metadata: { source: "buyer_portal" },
  }) : null

  const parsed = warrantyRequestInputSchema.parse({
    project_id: access.project_id,
    title: String(formData.get("title") || ""),
    description: String(formData.get("description") || "") || null,
    priority: String(formData.get("priority") || "normal"),
    severity: String(formData.get("severity") || "routine_30"),
    category: String(formData.get("category") || "") || null,
    coverage_term_key: String(formData.get("coverage_term_key") || "") || null,
    photo_file_ids: fileId ? [fileId] : [],
  })

  const request = await createWarrantyRequestFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    contactId: access.contact_id,
    input: parsed,
  })

  if (fileId) {
      await attachFileWithServiceRole({
        orgId: access.org_id,
        fileId,
        projectId: access.project_id,
        entityType: "warranty_request",
        entityId: request.id,
        linkRole: "photo",
        createdBy: null,
      })
  }

  return request
}

export async function signOffWarrantyVisitPortalAction(token: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, { portalType: "client", requireProject: true, permission: "can_view_warranty" })
  const visitId = String(formData.get("visit_id") || "")
  const name = String(formData.get("name") || "").trim()
  if (!visitId || !name) throw new Error("Visit and sign-off name are required")
  return signOffWarrantyVisitFromPortal({ orgId: access.org_id, projectId: access.project_id, visitId, name })
}

/** The homeowner confirms the appointment from the link in the email. */
export async function confirmWarrantyVisitPortalAction(token: string, visitId: string): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const access = await assertPortalActionAccess(token, { portalType: "client", requireProject: true, permission: "can_view_warranty" })
    const visit = await confirmWarrantyVisitByBuyer({ orgId: access.org_id, projectId: access.project_id, contactId: access.contact_id ?? null, visitId })
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}

/** The homeowner can't make it; the office sees the ask and moves the visit. */
export async function requestWarrantyVisitRescheduleAction(token: string, visitId: string, note: string): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const access = await assertPortalActionAccess(token, { portalType: "client", requireProject: true, permission: "can_view_warranty" })
    const visit = await requestWarrantyVisitRescheduleByBuyer({ orgId: access.org_id, projectId: access.project_id, contactId: access.contact_id ?? null, visitId, note })
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}
