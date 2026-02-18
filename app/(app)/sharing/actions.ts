"use server"

import {
  createPortalAccessToken,
  listPortalTokens,
  revokePortalToken,
  pausePortalToken,
  resumePortalToken,
  setPortalTokenRequireAccount,
  setPortalTokenPin,
  removePortalTokenPin,
} from "@/lib/services/portal-access"
import {
  listProjectExternalPortalAccounts,
  setExternalPortalAccountStatus,
} from "@/lib/services/external-portal-auth"
import { listProjectVendors } from "@/lib/services/project-vendors"
import {
  createPortalTokenInputSchema,
  revokePortalTokenInputSchema,
  pausePortalTokenInputSchema,
  resumePortalTokenInputSchema,
  setPortalTokenRequireAccountSchema,
  setPortalTokenPinSchema,
  removePortalTokenPinSchema,
} from "@/lib/validation/portal-access"
import { setExternalPortalAccountStatusSchema } from "@/lib/validation/external-portal-auth"

export async function loadSharingDataAction(projectId: string) {
  return listPortalTokens(projectId)
}

export async function loadProjectExternalPortalAccountsAction(projectId: string) {
  return listProjectExternalPortalAccounts(projectId)
}

export async function loadProjectVendorsAction(projectId: string) {
  return listProjectVendors(projectId)
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

  if (parsed.pin) {
    await setPortalTokenPin({ tokenId: token.id, pin: parsed.pin })
    token.pin_required = true
  }

  return token
}

export async function revokePortalTokenAction(input: unknown) {
  const parsed = revokePortalTokenInputSchema.parse(input)
  await revokePortalToken(parsed.token_id)
  return { success: true }
}

export async function pausePortalTokenAction(input: unknown) {
  const parsed = pausePortalTokenInputSchema.parse(input)
  await pausePortalToken(parsed.token_id)
  return { success: true }
}

export async function resumePortalTokenAction(input: unknown) {
  const parsed = resumePortalTokenInputSchema.parse(input)
  await resumePortalToken(parsed.token_id)
  return { success: true }
}

export async function setPortalTokenRequireAccountAction(input: unknown) {
  const parsed = setPortalTokenRequireAccountSchema.parse(input)
  await setPortalTokenRequireAccount({
    tokenId: parsed.token_id,
    requireAccount: parsed.require_account,
  })
  return { success: true }
}

export async function setPortalTokenPinAction(input: unknown) {
  const parsed = setPortalTokenPinSchema.parse(input)
  await setPortalTokenPin({ tokenId: parsed.token_id, pin: parsed.pin })
  return { success: true }
}

export async function removePortalTokenPinAction(input: unknown) {
  const parsed = removePortalTokenPinSchema.parse(input)
  await removePortalTokenPin({ tokenId: parsed.token_id })
  return { success: true }
}

export async function setExternalPortalAccountStatusAction(input: unknown) {
  const parsed = setExternalPortalAccountStatusSchema.parse(input)
  await setExternalPortalAccountStatus({
    accountId: parsed.account_id,
    status: parsed.status,
  })
  return { success: true }
}



