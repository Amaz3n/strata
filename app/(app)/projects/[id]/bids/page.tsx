import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getOrgCompaniesAction, getProjectAction } from "../actions"
import { listBidPackagesAction } from "./actions"
import { BidPackagesClient } from "@/components/bids/bid-packages-client"
import { listCostCodes } from "@/lib/services/cost-codes"
import { Skeleton } from "@/components/ui/skeleton"

interface ProjectBidsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectBidsPage({ params }: ProjectBidsPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout
        title="Bids"
        breadcrumbs={[
          { label: "Project" },
          { label: "Bids" },
        ]}
      />
      <Suspense fallback={
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        </div>
      }>
        <ProjectBidsData id={id} />
      </Suspense>
    </>
  )
}

async function ProjectBidsData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const [packages, companies, costCodes] = await Promise.all([
    listBidPackagesAction(id),
    getOrgCompaniesAction(),
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
    <BidPackagesClient
      projectId={project.id}
      packages={packages}
      tradeOptions={tradeOptions}
      costCodes={costCodes}
    />
  )
}
