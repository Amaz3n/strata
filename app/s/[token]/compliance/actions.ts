"use server"

import { actionError, type ActionResult } from "@/lib/action-result"
import { shareComplianceDocumentToOrg } from "@/lib/services/compliance-portability"
import {
  getCurrentExternalPortalSession,
  hasExternalPortalGrantForToken,
} from "@/lib/services/external-portal-auth"
import { assertPortalActionAccess } from "@/lib/services/portal-access"

/**
 * The vendor consenting to carry one document they already gave another builder
 * into this builder's org.
 *
 * Authorization is deliberately stricter than the rest of the portal. A bearer
 * token alone is not enough here, because the token's bound contact email is a
 * field the *builder* controls — typing a competitor's subcontractor into their
 * own directory would otherwise expose that sub's certificates from the other
 * builder's org. So this requires a signed-in external identity that holds a
 * live grant on this very link, and matches documents on that identity's own
 * verified email rather than on anything the builder wrote down.
 */
export async function shareComplianceDocumentAction(
  token: string,
  sourceDocumentId: string,
): Promise<ActionResult<{ documentId: string }>> {
  try {
    const access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_upload_compliance_docs",
    })
    if (!access.company_id) throw new Error("Invalid portal access")

    const session = await getCurrentExternalPortalSession()
    if (!session) {
      throw new Error("Sign in to your Arc vendor account to reuse a document from another builder")
    }

    const holdsGrant = await hasExternalPortalGrantForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "portal",
    })
    if (!holdsGrant) {
      throw new Error("This link is not connected to your Arc vendor account")
    }

    return {
      success: true,
      data: await shareComplianceDocumentToOrg({
        sourceDocumentId,
        targetOrgId: access.org_id,
        targetCompanyId: access.company_id,
        identityEmail: session.identity.email,
        externalIdentityId: session.identity.id,
        portalTokenId: access.id,
      }),
    }
  } catch (error) {
    return actionError(error)
  }
}
