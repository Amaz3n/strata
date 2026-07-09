import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getOrgCompaniesAction, getProjectAction } from "../actions"
import { getProjectBuyoutSummaryAction, listBidPackagesAction } from "./actions"
import { BidPackagesClient } from "@/components/bids/bid-packages-client"
import { listCostCodes } from "@/lib/services/cost-codes"
import { Skeleton } from "@/components/ui/skeleton"

import { unwrapAction } from "@/lib/action-result"

interface ProjectBidsPageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function numberParam(value: string | string[] | undefined) {
  const raw = firstParam(value)
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export default async function ProjectBidsPage({ params, searchParams }: ProjectBidsPageProps) {
  const { id } = await params
  const query = (await searchParams) ?? {}
  const initialDraft = {
    title: firstParam(query.title) ?? null,
    scope: firstParam(query.scope) ?? null,
    cost_code_id: firstParam(query.cost_code_id) ?? null,
    budget_line_id: firstParam(query.budget_line_id) ?? null,
    amount_cents: numberParam(query.amount_cents),
  }
  const hasInitialDraft = Boolean(
    initialDraft.title ||
      initialDraft.scope ||
      initialDraft.cost_code_id ||
      initialDraft.budget_line_id ||
      initialDraft.amount_cents,
  )

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
        <ProjectBidsData id={id} initialDraft={hasInitialDraft ? initialDraft : null} />
      </Suspense>
    </>
  )
}

async function ProjectBidsData({
  id,
  initialDraft,
}: {
  id: string
  initialDraft: {
    title?: string | null
    scope?: string | null
    cost_code_id?: string | null
    budget_line_id?: string | null
    amount_cents?: number | null
  } | null
}) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const [packages, companies, costCodes, buyoutRows] = await Promise.all([
    listBidPackagesAction(id),
    getOrgCompaniesAction(),
    listCostCodes().catch(() => []),
    getProjectBuyoutSummaryAction(id).catch(() => []),
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
      initialDraft={initialDraft}
      buyoutRows={buyoutRows}
    />
  )
}
