import { Suspense } from "react"
import { notFound } from "next/navigation"

import { BidPackagesClient } from "@/components/bids/bid-packages-client"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listCompanies } from "@/lib/services/companies"
import { getProspect } from "@/lib/services/prospects"

import { listProspectBidPackagesAction } from "./actions"

import { unwrapAction } from "@/lib/action-result"

interface ProspectBidsPageProps {
  params: Promise<{ prospectId: string }>
}

export default async function ProspectBidsPage({ params }: ProspectBidsPageProps) {
  const { prospectId } = await params

  return (
    <>
      <PageLayout
        title="Prospect Bids"
        breadcrumbs={[
          { label: "Pipeline", href: "/pipeline" },
          { label: "Bids" },
        ]}
      />
      <Suspense
        fallback={
          <div className="space-y-4 p-6">
            <Skeleton className="mb-6 h-8 w-48" />
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-md" />
              ))}
            </div>
          </div>
        }
      >
        <ProspectBidsData prospectId={prospectId} />
      </Suspense>
    </>
  )
}

async function ProspectBidsData({ prospectId }: { prospectId: string }) {
  let prospect
  try {
    prospect = await getProspect(prospectId)
  } catch {
    notFound()
  }

  const [packages, companies, costCodes] = await Promise.all([
    listProspectBidPackagesAction(prospect.id),
    listCompanies(),
    listCostCodes().catch(() => []),
  ])

  const tradeMap = new Map<string, string>()
  for (const company of companies) {
    const trimmedTrade = company.trade?.trim()
    if (!trimmedTrade) continue
    const normalizedTrade = trimmedTrade.toLowerCase()
    if (!tradeMap.has(normalizedTrade)) {
      tradeMap.set(normalizedTrade, trimmedTrade)
    }
  }
  const tradeOptions = Array.from(tradeMap.values()).sort((a, b) => a.localeCompare(b))

  return (
    <div className="space-y-4 p-6 pt-0">
      <div>
        <h2 className="text-lg font-semibold">{prospect.name}</h2>
        <p className="text-sm text-muted-foreground">Invite vendors and collect bids before this becomes a project.</p>
      </div>
      <BidPackagesClient
        prospectId={prospect.id}
        packages={packages}
        tradeOptions={tradeOptions}
        costCodes={costCodes}
        detailBasePath={`/pipeline/prospects/${prospect.id}/bids`}
        createDescription="Create an invite-to-bid package for this prospect."
      />
    </div>
  )
}
