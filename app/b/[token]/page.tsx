import { notFound } from "next/navigation"

import {
  loadBidPortalData,
  recordBidPortalAccess,
  validateBidPortalToken,
} from "@/lib/services/bid-portal"
import { hasExternalPortalGrantForToken } from "@/lib/services/external-portal-auth"
import { BidPortalClientNew } from "@/components/bid-portal/bid-portal-client-new"
import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { createHmac } from "crypto"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

interface BidPortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function BidPortalPage({ params }: BidPortalPageProps) {
  const { token } = await params

  const access = await validateBidPortalToken(token)
  if (!access) {
    const secret = process.env.BID_PORTAL_SECRET
    const tokenHashPrefix = secret
      ? createHmac("sha256", secret).update(token).digest("hex").slice(0, 10)
      : undefined
    let tokenRowFound = false
    let inviteFound = false
    let tokenHash: string | undefined
    try {
      if (secret) {
        tokenHash = createHmac("sha256", secret).update(token).digest("hex")
        const supabase = createServiceSupabaseClient()
        const { data: tokenRow, error: tokenError } = await supabase
          .from("bid_access_tokens")
          .select("id, bid_invite_id")
          .eq("token_hash", tokenHash)
          .maybeSingle()
        tokenRowFound = !!tokenRow
        if (tokenRow?.bid_invite_id) {
          const { data: inviteRow } = await supabase
            .from("bid_invites")
            .select("id")
            .eq("id", tokenRow.bid_invite_id)
            .maybeSingle()
          inviteFound = !!inviteRow
        }
        if (tokenError) {
          console.warn("Bid portal token debug query error", tokenError.message)
        }
      }
    } catch (debugError) {
      console.warn("Bid portal debug lookup failed", { error: (debugError as Error)?.message })
    }
    console.warn("Bid portal access not found", {
      tokenPrefix: token.slice(0, 6),
      tokenHashPrefix,
      hasSecret: !!process.env.BID_PORTAL_SECRET,
      tokenRowFound,
      inviteFound,
      supabaseHost: process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/^https?:\/\//, ""),
    })
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <Card className="max-w-md">
          <CardContent className="p-8 space-y-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Bid Portal</p>
            <h1 className="text-2xl font-semibold">Link not found</h1>
            <p className="text-sm text-muted-foreground">
              This bid link is invalid or expired. Ask the builder to generate a new link.
            </p>
            {process.env.NODE_ENV === "development" && (
              <p className="text-xs text-muted-foreground">
                Debug: secret configured = {process.env.BID_PORTAL_SECRET ? "yes" : "no"}
              </p>
            )}
            <Button asChild>
              <a href="mailto:">Contact builder</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (access.require_account) {
    const hasAccountAccess = await hasExternalPortalGrantForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "bid",
    })
    if (!hasAccountAccess) {
      return (
        <PortalAccountGate
          token={token}
          tokenType="bid"
          orgName={access.org.name}
          projectName={access.project.name}
        />
      )
    }
  }

  const data = await loadBidPortalData(access)
  await recordBidPortalAccess(access.id, access.bid_invite_id, access.org_id)

  return <BidPortalClientNew token={token} access={access} data={data} pinRequired={access.pin_required} />
}
