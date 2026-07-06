"use server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createWarrantyRequestFromPortal } from "@/lib/services/warranty"
import { warrantyRequestInputSchema } from "@/lib/validation/warranty"

export async function createWarrantyRequestPortalAction(token: string, input: unknown) {
  const access = await assertPortalActionAccess(token, {
    portalType: "client",
    permission: "can_view_warranty",
  })

  const parsed = warrantyRequestInputSchema.parse(input)
  return createWarrantyRequestFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    contactId: access.contact_id,
    input: parsed,
  })
}
