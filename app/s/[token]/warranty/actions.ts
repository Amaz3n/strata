"use server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import {
  completeWarrantyVisitFromPortal,
  confirmWarrantyVisitFromPortal,
  getWarrantyVisitProjectForCompanyPortal,
} from "@/lib/services/warranty"
import { uploadPortalFile } from "@/lib/services/portal-uploads"

export async function confirmSubPortalWarrantyVisitAction(token: string, visitId: string) {
  const access = await assertPortalActionAccess(token, { portalType: "sub", permission: "can_view_punch_items" })
  if (!access.company_id) throw new Error("Trade company is required")
  return confirmWarrantyVisitFromPortal({ orgId: access.org_id, companyId: access.company_id, visitId })
}

export async function completeSubPortalWarrantyVisitAction(token: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, { portalType: "sub", permission: "can_view_punch_items" })
  if (!access.company_id) throw new Error("Trade company is required")
  const visitId = String(formData.get("visit_id") || "")
  const note = String(formData.get("note") || "").trim()
  const outcome = String(formData.get("outcome") || "")
  if (!visitId || !note) throw new Error("Visit and completion note are required")
  const photo = formData.get("photo") as File | null
  const fileId = photo && photo.size > 0 ? await uploadPortalFile({
    file: photo, orgId: access.org_id,
    // The visit names the job, not the link — a vendor account link carries no
    // project and a project-scoped one can only reach its own visits anyway.
    projectId: await getWarrantyVisitProjectForCompanyPortal({
      orgId: access.org_id, companyId: access.company_id, visitId,
    }),
    category: "warranty", folderPath: "/warranty/visits",
    metadata: { warranty_visit_id: visitId, company_id: access.company_id },
  }) : null
  return completeWarrantyVisitFromPortal({
    orgId: access.org_id, companyId: access.company_id, visitId, outcome,
    outcomeNote: note, photoFileIds: fileId ? [fileId] : [], portalTokenId: access.id,
  })
}
