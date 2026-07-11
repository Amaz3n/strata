"use server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import {
  completePunchItemFromPortal,
  listPunchItemsForCompanyPortal,
} from "@/lib/services/punch-lists"
import { uploadPortalFile } from "@/lib/services/portal-uploads"
import type { PunchItem } from "@/lib/types"

export async function listSubPortalPunchItemsAction(token: string): Promise<PunchItem[]> {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_view_punch_items",
  })
  if (!access.company_id) throw new Error("Access denied")

  return listPunchItemsForCompanyPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
  })
}

export async function completeSubPortalPunchItemAction(
  token: string,
  formData: FormData,
): Promise<PunchItem> {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_view_punch_items",
  })
  if (!access.company_id) throw new Error("Access denied")

  const punchItemId = String(formData.get("punch_item_id") || "")
  if (!punchItemId) throw new Error("Punch item is required")

  const photoFileId = await uploadPortalFile({
    file: formData.get("photo") as File | null,
    orgId: access.org_id,
    projectId: access.project_id,
    category: "photos",
    folderPath: "/photos",
    metadata: { company_id: access.company_id, punch_item_id: punchItemId },
  })

  return completePunchItemFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    punchItemId,
    photoFileId,
    portalTokenId: access.id,
  })
}
