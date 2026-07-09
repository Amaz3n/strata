"use server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createWarrantyRequestFromPortal } from "@/lib/services/warranty"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { uploadPortalFile } from "@/lib/services/portal-uploads"
import { warrantyRequestInputSchema } from "@/lib/validation/warranty"

export async function createWarrantyRequestPortalAction(token: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, {
    portalType: "client",
    permission: "can_view_warranty",
  })

  const parsed = warrantyRequestInputSchema.parse({
    project_id: access.project_id,
    title: String(formData.get("title") || ""),
    description: String(formData.get("description") || "") || null,
    priority: String(formData.get("priority") || "normal"),
  })

  const request = await createWarrantyRequestFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    contactId: access.contact_id,
    input: parsed,
  })

  const photo = formData.get("photo") as File | null
  if (photo && photo.size > 0) {
    const fileId = await uploadPortalFile({
      file: photo,
      orgId: access.org_id,
      projectId: access.project_id,
      category: "warranty",
      folderPath: "/warranty",
      metadata: { warranty_request_id: request.id },
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
  }

  return request
}
