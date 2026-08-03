import {
  isBidPortalPinVerified,
  loadBidPortalData,
  recordBidPortalAccess,
  validateBidPortalToken,
} from "@/lib/services/bid-portal"
import {
  ensureExternalPortalAccessForToken,
  getExternalPortalGateContext,
  getExternalPortalWorkspaceContext,
  isExternalAccessClaimed,
} from "@/lib/services/external-portal-auth"
import { BidPortalClient } from "@/components/bid-portal/bid-portal-client"
import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

interface BidPortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0
export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

const EMPTY_BID_PORTAL_DATA = {
  packageFiles: [],
  addenda: [],
  submissions: [],
  currentSubmission: undefined,
  rfis: [],
  scopeItems: [],
  draft: null,
}

export default async function BidPortalPage({ params }: BidPortalPageProps) {
  const { token } = await params

  const access = await validateBidPortalToken(token)
  if (!access) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <Card className="max-w-md">
          <CardContent className="p-8 space-y-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Bid Portal</p>
            <h1 className="text-2xl font-semibold">Link not found</h1>
            <p className="text-sm text-muted-foreground">
              This bid link is invalid or expired. Reply to the invitation email and the builder
              can send you a fresh link.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Same rule as every other portal: once the invited person has an Arc account
  // the link is a pointer to a sign-in, not a credential. Phase 6 folds bid access
  // into `portal_access_tokens` and this page becomes a redirect — until then the
  // shared services are applied here so `/b` cannot drift from the others again.
  const claimed = access.require_account || (await isExternalAccessClaimed({ token, tokenType: "bid" }))
  let identityVerified = false

  if (claimed) {
    identityVerified = await ensureExternalPortalAccessForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "bid",
      token,
    })

    if (!identityVerified) {
      const gateContext = await getExternalPortalGateContext({ token, tokenType: "bid" })
      return (
        <PortalAccountGate
          token={token}
          tokenType="bid"
          orgName={gateContext?.orgName ?? access.org.name}
          projectName={gateContext?.projectName ?? access.project.name}
          initialEmail={gateContext?.expectedEmail ?? ""}
          suggestedFullName={gateContext?.suggestedFullName ?? ""}
          emailLocked={gateContext?.emailLocked}
          hasExistingAccount={claimed}
        />
      )
    }
  }

  const hasPinAccess = !access.pin_required || identityVerified || (await isBidPortalPinVerified(token))
  if (!hasPinAccess) {
    const workspace = await getExternalPortalWorkspaceContext({ orgId: access.org_id })
    return <BidPortalClient token={token} access={access} data={EMPTY_BID_PORTAL_DATA} pinRequired workspace={workspace} />
  }

  const data = await loadBidPortalData(access, token)
  await recordBidPortalAccess(access.id, access.bid_invite_id, access.org_id)
  const workspace = await getExternalPortalWorkspaceContext({ orgId: access.org_id })

  return <BidPortalClient token={token} access={access} data={data} pinRequired={false} workspace={workspace} />
}
