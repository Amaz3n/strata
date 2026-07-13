"use server"

import { revalidatePath } from "next/cache"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { uploadPortalFile } from "@/lib/services/portal-uploads"
import { uploadSubtierWaiverFromPortal } from "@/lib/services/lien-waivers"

export async function uploadSubtierWaiverAction(token: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_upload_subtier_waivers",
  })
  if (!access.company_id) throw new Error("Invalid portal access")
  const requirementId = String(formData.get("requirement_id") ?? "")
  const claimantCompanyName = String(formData.get("claimant_company_name") ?? "").trim()
  const amountDollars = Number(formData.get("amount_dollars") ?? 0)
  const waiverType = String(formData.get("waiver_type") ?? "conditional") as "conditional" | "unconditional" | "final"
  const throughDate = String(formData.get("through_date") ?? "")
  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) throw new Error("Attach the signed waiver document")
  if (!requirementId || !claimantCompanyName || !throughDate || !Number.isFinite(amountDollars) || amountDollars < 0) {
    throw new Error("Claimant, amount, through date, and request are required")
  }
  const fileId = await uploadPortalFile({
    file,
    orgId: access.org_id,
    projectId: access.project_id,
    category: "financials",
    folderPath: "Lien Waivers/Sub-tier",
    metadata: { source: "subtier_waiver", claimant: claimantCompanyName, requirement_id: requirementId },
  })
  if (!fileId) throw new Error("The waiver file could not be stored")
  await uploadSubtierWaiverFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    contactId: access.contact_id ?? null,
    portalTokenId: access.id,
    requirementId,
    claimantCompanyName,
    amountCents: Math.round(amountDollars * 100),
    waiverType,
    throughDate,
    fileId,
  })
  revalidatePath(`/s/${token}/subtier-waivers`)
}
