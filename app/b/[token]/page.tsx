import { notFound } from "next/navigation"

import {
  loadBidPortalData,
  recordBidPortalAccess,
  validateBidPortalToken,
} from "@/lib/services/bid-portal"
import { BidPortalClient } from "@/components/bid-portal/bid-portal-client"

interface BidPortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function BidPortalPage({ params }: BidPortalPageProps) {
  const { token } = await params

  const access = await validateBidPortalToken(token)
  if (!access) {
    notFound()
  }

  const data = await loadBidPortalData(access)
  await recordBidPortalAccess(access.id, access.bid_invite_id, access.org_id)

  return <BidPortalClient token={token} access={access} data={data} pinRequired={access.pin_required} />
}
