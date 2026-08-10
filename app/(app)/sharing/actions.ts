"use server"

import {
  createPortalAccessToken,
  listKnownExternalContacts,
  listOrgExternalAccess,
  listProjectAccessRoster,
  revokeOrgExternalPersonAccess,
  revokePortalToken,
  pausePortalToken,
  resumePortalToken,
  setPortalTokenRequireAccount,
  setPortalTokenPin,
  removePortalTokenPin,
} from "@/lib/services/portal-access"
import { listProjectVendors } from "@/lib/services/project-vendors"
import {
  createPortalTokenInputSchema,
  revokePortalTokenInputSchema,
  pausePortalTokenInputSchema,
  resumePortalTokenInputSchema,
  setPortalTokenRequireAccountSchema,
  setPortalTokenPinSchema,
  removePortalTokenPinSchema,
  revokeOrgExternalPersonSchema,
} from "@/lib/validation/portal-access"
import { REVIEWER_DEFAULT_PERMISSIONS } from "@/lib/types"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function loadProjectAccessRosterAction(projectId: string) {
      return listProjectAccessRoster(projectId)
}

export async function loadKnownExternalContactsAction() {
      return listKnownExternalContacts()
}

export async function loadOrgExternalAccessAction() {
      return listOrgExternalAccess()
}

export async function revokeOrgExternalPersonAction(input: unknown) {
  return run(async () => {
      const parsed = revokeOrgExternalPersonSchema.parse(input)
      return revokeOrgExternalPersonAccess({ tokenIds: parsed.token_ids })
  })
}

export async function loadProjectVendorsAction(projectId: string) {
      return listProjectVendors(projectId)
}

export async function createPortalTokenAction(input: unknown) {
  return run(async () => {
      const parsed = createPortalTokenInputSchema.parse(input)
      // Reviewer seats never inherit the client/sub permission defaults —
      // start from the least-privilege reviewer set, then apply overrides.
      const permissions =
        parsed.portal_type === "reviewer"
          ? { ...REVIEWER_DEFAULT_PERMISSIONS, ...(parsed.permissions ?? {}) }
          : parsed.permissions
      const token = await createPortalAccessToken({
        projectId: parsed.project_id,
        portalType: parsed.portal_type,
        contactId: parsed.contact_id,
        companyId: parsed.company_id,
        reviewerRole: parsed.portal_type === "reviewer" ? (parsed.reviewer_role ?? "other") : null,
        permissions,
        expiresAt: parsed.expires_at,
      })

      if (parsed.pin) {
        await setPortalTokenPin({ tokenId: token.id, pin: parsed.pin })
        token.pin_required = true
      }

      return token
  })
}

export async function revokePortalTokenAction(input: unknown) {
  return run(async () => {
      const parsed = revokePortalTokenInputSchema.parse(input)
      await revokePortalToken(parsed.token_id)
      return { success: true }
  })
}

export async function pausePortalTokenAction(input: unknown) {
  return run(async () => {
      const parsed = pausePortalTokenInputSchema.parse(input)
      await pausePortalToken(parsed.token_id)
      return { success: true }
  })
}

export async function resumePortalTokenAction(input: unknown) {
  return run(async () => {
      const parsed = resumePortalTokenInputSchema.parse(input)
      await resumePortalToken(parsed.token_id)
      return { success: true }
  })
}

export async function setPortalTokenRequireAccountAction(input: unknown) {
  return run(async () => {
      const parsed = setPortalTokenRequireAccountSchema.parse(input)
      await setPortalTokenRequireAccount({
        tokenId: parsed.token_id,
        requireAccount: parsed.require_account,
      })
      return { success: true }
  })
}

export async function setPortalTokenPinAction(input: unknown) {
  return run(async () => {
      const parsed = setPortalTokenPinSchema.parse(input)
      await setPortalTokenPin({ tokenId: parsed.token_id, pin: parsed.pin })
      return { success: true }
  })
}

export async function removePortalTokenPinAction(input: unknown) {
  return run(async () => {
      const parsed = removePortalTokenPinSchema.parse(input)
      await removePortalTokenPin({ tokenId: parsed.token_id })
      return { success: true }
  })
}




