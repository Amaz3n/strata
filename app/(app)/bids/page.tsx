import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { listOrgBidPackages } from "@/lib/services/bids"
import { getBidPackageStage } from "@/lib/bids/stage"

import { BidsDeskClient } from "./bids-desk-client"


async function BidsDeskPageContent() {
  await connection()
  const rows = await listOrgBidPackages()
  // Stage is derived (past-due packages are "leveling" even if never closed) —
  // compute it once on the server so the client can band + filter on it.
  const packages = rows.map((pkg) => ({ ...pkg, stage: getBidPackageStage(pkg) }))

  const tradeOptions = [
    ...new Set(
      packages
        .map((pkg) => pkg.trade?.trim())
        .filter((trade): trade is string => Boolean(trade)),
    ),
  ].sort((a, b) => a.localeCompare(b))

  return (
    <PageLayout title="Bids" fullBleed>
      <BidsDeskClient packages={packages} tradeOptions={tradeOptions} />
    </PageLayout>
  )
}

export default function BidsDeskPage() {
  return (
    <Suspense fallback={<PageLayout title="Bids" fullBleed><PageLoadingSkeleton /></PageLayout>}>
      <BidsDeskPageContent />
    </Suspense>
  )
}
