import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getOrgCompaniesAction, getProjectAction } from "../actions"
import { listBidPackagesAction } from "./actions"
import { BidPackagesClient } from "@/components/bids/bid-packages-client"

interface ProjectBidsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectBidsPage({ params }: ProjectBidsPageProps) {
  const { id } = await params

  const [project, packages, companies] = await Promise.all([
    getProjectAction(id),
    listBidPackagesAction(id),
    getOrgCompaniesAction(),
  ])

  if (!project) {
    notFound()
  }

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
    <PageLayout
      title="Bids"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Bids" },
      ]}
    >
      <BidPackagesClient projectId={project.id} packages={packages} tradeOptions={tradeOptions} />
    </PageLayout>
  )
}
