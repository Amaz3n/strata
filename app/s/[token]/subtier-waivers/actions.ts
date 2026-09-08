"use server"

import { z } from "zod"
import { WAIVER_KINDS } from "@/lib/lien-waivers/coverage"
import { revalidatePath } from "next/cache"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { uploadPortalFile } from "@/lib/services/portal-uploads"
import { uploadSubtierWaiverFromPortal } from "@/lib/services/lien-waivers"

export async function uploadSubtierWaiverAction(
  token: string,
  formData: FormData,
) {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireProject: true,
    requireCompany: true,
    permission: "can_upload_subtier_waivers",
  })
  if (!access.company_id) throw new Error("Invalid portal access")
  const requirementId = String(formData.get("requirement_id") ?? "")
  const claimantCompanyName = String(
    formData.get("claimant_company_name") ?? "",
  ).trim()
  const amountDollars = Number(formData.get("amount_dollars") ?? 0)
  const waiverType = z.enum(WAIVER_KINDS).parse(formData.get("waiver_type"))
  const throughDate = String(formData.get("through_date") ?? "")
  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0)
    throw new Error("Attach the signed waiver document")
  if (
    !requirementId ||
    !claimantCompanyName ||
    !throughDate ||
    !Number.isFinite(amountDollars) ||
    amountDollars < 0
  ) {
    throw new Error("Claimant, amount, through date, and request are required")
  }
  const signedDate = z.string().date().parse(formData.get("signed_date"))
  const signerName = z.string().trim().min(2).parse(formData.get("signer_name"))
  if (signedDate > new Date().toISOString().slice(0, 10))
    throw new Error("Signature date cannot be in the future")
  if (file.size > 15 * 1024 * 1024)
    throw new Error("Choose a PDF smaller than 15 MB")
  const { inspectWaiverPdf } =
    await import("@/lib/pdfs/invoice-waiver-document")
  await inspectWaiverPdf(Buffer.from(await file.arrayBuffer()))
  const fileId = await uploadPortalFile({
    file,
    orgId: access.org_id,
    projectId: access.project_id,
    category: "financials",
    folderPath: "Lien Waivers/Sub-tier",
    metadata: {
      source: "subtier_waiver",
      claimant: claimantCompanyName,
      requirement_id: requirementId,
    },
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
    signedDate,
    signerName,
  })
  revalidatePath(`/s/${token}/subtier-waivers`)
}
