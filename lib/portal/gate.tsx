import type { ReactNode } from "react"

import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { isPortalPinVerified, validatePortalToken } from "@/lib/services/portal-access"
import {
  ensureExternalPortalAccessForToken,
  getExternalPortalGateContext,
  getExternalPortalWorkspaceContext,
  isExternalAccessClaimed,
} from "@/lib/services/external-portal-auth"
import type {
  ExternalPortalWorkspaceContext,
  PortalAccessToken,
  PortalType,
  ProjectScopedPortalAccess,
} from "@/lib/types"

export type PortalGateResult<TAccess extends PortalAccessToken = PortalAccessToken> =
  | {
      status: "ok"
      access: TAccess
      workspace: ExternalPortalWorkspaceContext | null
      /** Invite details for the claim-account prompt; null once they have a workspace. */
      claim: { email: string; fullName: string } | null
    }
  | { status: "invalid" }
  | { status: "wrong-portal"; access: PortalAccessToken }
  | { status: "blocked"; element: ReactNode }

interface PortalGateOptions {
  token: string
  portalType: PortalType
  requireCompany?: boolean
  /**
   * Reject an access record with no job behind it — a bid-scoped record whose
   * package has no project yet, or a company-scoped vendor account record. A
   * portal whose every section reads one project's data sets this; `/s` does
   * not, because a vendor account link is a real shape there.
   */
  requireProject?: boolean
  /** Shown on the PIN screen before portal data has loaded. */
  fallbackLabel: string
}

/**
 * The single entry sequence for every token portal: validate the token, then
 * the account gate, then the PIN gate, then stamp access. Previously each
 * portal page re-implemented this and they had drifted — one skipped the
 * workspace lookup, another recorded access before the PIN check.
 *
 * Returns a discriminated result rather than rendering, so the caller decides
 * between `notFound()` and a setup screen for a misconfigured token.
 */
export async function resolvePortalGate(
  options: PortalGateOptions & { requireProject: true },
): Promise<PortalGateResult<ProjectScopedPortalAccess>>
export async function resolvePortalGate(
  options: PortalGateOptions,
): Promise<PortalGateResult>
export async function resolvePortalGate({
  token,
  portalType,
  requireCompany = false,
  requireProject = false,
  fallbackLabel,
}: PortalGateOptions): Promise<PortalGateResult> {
  const access = await validatePortalToken(token)
  if (!access) {
    return { status: "invalid" }
  }

  // A link that addresses no job cannot address a project-scoped portal at all,
  // so it is not a misconfigured link the builder can repair — it is the wrong
  // link. Failing here keeps every page below free of the null.
  if (requireProject && access.project_id === null) {
    return { status: "invalid" }
  }

  if (access.portal_type !== portalType || (requireCompany && !access.company_id)) {
    return { status: "wrong-portal", access }
  }

  // Once someone has an Arc account, the link stops being a credential and
  // becomes a pointer to a sign-in. `require_account` remains the builder's
  // independent override for people who have not claimed one.
  const [workspace, claimed] = await Promise.all([
    getExternalPortalWorkspaceContext({ orgId: access.org_id }),
    access.require_account
      ? Promise.resolve(true)
      : isExternalAccessClaimed({ token, tokenType: "portal" }),
  ])

  let identityVerified = false

  if (access.require_account || claimed) {
    identityVerified = await ensureExternalPortalAccessForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "portal",
      token,
    })

    if (!identityVerified) {
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
            hasExistingAccount={claimed}
          />
        ),
      }
    }
  }

  // A verified identity is strictly stronger proof than a shared PIN, so the PIN
  // only guards the link-only path. Asking for both was friction, not security.
  if (!identityVerified && access.pin_required && !(await isPortalPinVerified(token))) {
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
