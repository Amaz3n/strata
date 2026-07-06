"use server"

import { redirect } from "next/navigation"

import { signVendorBillWaiverFromPortal } from "@/lib/services/lien-waivers"
import { assertPortalActionAccess } from "@/lib/services/portal-access"

export async function signVendorBillWaiverPortalAction(token: string, billId: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_view_bills",
  })
  if (!access.company_id) {
    throw new Error("Invalid portal access")
  }

  await signVendorBillWaiverFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    contactId: access.contact_id ?? null,
    portalTokenId: access.id,
    billId,
    signerName: String(formData.get("signer_name") ?? ""),
    signatureText: String(formData.get("signature_text") ?? ""),
    consentAccepted: formData.get("consent_accepted") === "on",
  })

  redirect(`/s/${token}/bills`)
}
