import type { ReactNode } from "react"

import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { isPortalPinVerified, validatePortalToken } from "@/lib/services/portal-access"
import {
  getExternalPortalGateContext,
  getExternalPortalWorkspaceContext,
  hasExternalPortalGrantForToken,
} from "@/lib/services/external-portal-auth"
import type {
  ExternalPortalWorkspaceContext,
  PortalAccessToken,
  PortalType,
} from "@/lib/types"

export type PortalGateResult =
  | {
      status: "ok"
      access: PortalAccessToken
      workspace: ExternalPortalWorkspaceContext | null
      /** Invite details for the claim-account prompt; null once they have a workspace. */
      claim: { email: string; fullName: string } | null
    }
  | { status: "invalid" }
  | { status: "wrong-portal"; access: PortalAccessToken }
  | { status: "blocked"; element: ReactNode }

/**
 * The single entry sequence for every token portal: validate the token, then
 * the account gate, then the PIN gate, then stamp access. Previously each
 * portal page re-implemented this and they had drifted — one skipped the
 * workspace lookup, another recorded access before the PIN check.
 *
 * Returns a discriminated result rather than rendering, so the caller decides
 * between `notFound()` and a setup screen for a misconfigured token.
 */
export async function resolvePortalGate({
  token,
  portalType,
  requireCompany = false,
  fallbackLabel,
}: {
  token: string
  portalType: PortalType
  requireCompany?: boolean
  /** Shown on the PIN screen before portal data has loaded. */
  fallbackLabel: string
}): Promise<PortalGateResult> {
  const access = await validatePortalToken(token)
  if (!access) {
    return { status: "invalid" }
  }

  if (access.portal_type !== portalType || (requireCompany && !access.company_id)) {
    return { status: "wrong-portal", access }
  }

  const workspace = await getExternalPortalWorkspaceContext({ orgId: access.org_id })

  if (access.require_account) {
    const hasAccountAccess = await hasExternalPortalGrantForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "portal",
    })
    if (!hasAccountAccess) {
      const context = await getExternalPortalGateContext({ token, tokenType: "portal" })
      return {
        status: "blocked",
        element: (
          <PortalAccountGate
            token={token}
            tokenType="portal"
            orgName={context?.orgName ?? "the builder"}
            projectName={context?.projectName ?? fallbackLabel}
            initialEmail={context?.expectedEmail ?? ""}
            suggestedFullName={context?.suggestedFullName ?? ""}
            emailLocked={context?.emailLocked}
          />
        ),
      }
    }
  }

  if (access.pin_required && !(await isPortalPinVerified(token))) {
    const context = await getExternalPortalGateContext({ token, tokenType: "portal" })
    return {
      status: "blocked",
      element: (
        <PortalPinGate
          token={token}
          projectName={context?.projectName ?? fallbackLabel}
          orgName={context?.orgName ?? "Arc"}
        />
      ),
    }
  }

  // Access is deliberately NOT recorded here. `max_access_count` is a usage
  // limit on the link, and this gate runs for every page under the portal —
  // counting here would let a deep link from an email burn the budget several
  // times over. The portal root records one access per entry, as it always has.
  const claim = workspace
    ? null
    : await getExternalPortalGateContext({ token, tokenType: "portal" }).then((context) => ({
        email: context?.expectedEmail ?? "",
        fullName: context?.suggestedFullName ?? "",
      }))

  return { status: "ok", access, workspace, claim }
}
