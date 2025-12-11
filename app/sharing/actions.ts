"use server"

import { revalidatePath } from "next/cache"
import { createPortalAccessToken, listPortalTokens, revokePortalToken } from "@/lib/services/portal-access"
import { createPortalTokenInputSchema, revokePortalTokenInputSchema } from "@/lib/validation/portal-access"

export async function loadSharingDataAction(projectId: string) {
  return listPortalTokens(projectId)
}

export async function createPortalTokenAction(input: unknown) {
  const parsed = createPortalTokenInputSchema.parse(input)
  const token = await createPortalAccessToken({
    projectId: parsed.project_id,
    portalType: parsed.portal_type,
    contactId: parsed.contact_id,
    companyId: parsed.company_id,
    permissions: parsed.permissions,
    expiresAt: parsed.expires_at,
  })

  revalidatePath("/sharing")
  return token
}

export async function revokePortalTokenAction(input: unknown) {
  const parsed = revokePortalTokenInputSchema.parse(input)
  await revokePortalToken(parsed.token_id)
  revalidatePath("/sharing")
  return { success: true }
}




