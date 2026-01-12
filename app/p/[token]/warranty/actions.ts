"use server"

import { validatePortalToken } from "@/lib/services/portal-access"
import { createWarrantyRequestFromPortal } from "@/lib/services/warranty"
import { warrantyRequestInputSchema } from "@/lib/validation/warranty"

export async function createWarrantyRequestPortalAction(token: string, input: unknown) {
  const access = await validatePortalToken(token)
  if (!access) throw new Error("Invalid portal token")
  if (access.portal_type !== "client") throw new Error("Access denied")

  const parsed = warrantyRequestInputSchema.parse(input)
  return createWarrantyRequestFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    contactId: access.contact_id,
    input: parsed,
  })
}
