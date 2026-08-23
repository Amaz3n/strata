"use server"

import { redirect } from "next/navigation"

import { signVendorBillWaiverFromPortal } from "@/lib/services/lien-waivers"
import { assertPortalActionAccess } from "@/lib/services/portal-access"

export async function signVendorBillWaiverPortalAction(token: string, billId: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireProject: true,
    requireCompany: true,
    permission: "can_view_bills",
  })
  if (!access.company_id) {
    throw new Error("Invalid portal access")
  }

  const requestedType = String(formData.get("waiver_type") ?? "conditional")
  const waiverType =
    requestedType === "final" || requestedType === "unconditional" ? requestedType : "conditional"

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
    waiverType,
  })

  // A payable with retainage needs a final waiver as well as the progress one,
  // so land back on the waiver page rather than the bills list until the set
  // this payable needs is complete.
  redirect(`/s/${token}/waivers/${billId}`)
}
