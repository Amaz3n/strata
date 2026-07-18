import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getOrgCompaniesAction, getProjectAction } from "../actions"
import { listBidPackagesAction } from "@/app/(app)/bids/actions"
import { BidPackagesClient } from "@/components/bids/bid-packages-client"
import { tradeOptionsFromCompanies } from "@/components/bids/trade-options"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listProjectBudgetLines } from "@/lib/services/budgets"
import { Skeleton } from "@/components/ui/skeleton"

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
      <PageLayout title="Bids" breadcrumbs={[{ label: "Project" }, { label: "Bids" }]} />
      <Suspense
        fallback={
          <div className="space-y-4 p-6">
            <Skeleton className="mb-6 h-8 w-48" />
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-md" />
              ))}
            </div>
          </div>
        }
      >
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

  const [packages, companies, costCodes, budgetLines] = await Promise.all([
    listBidPackagesAction(id),
    getOrgCompaniesAction(),
    listCostCodes().catch(() => []),
    listProjectBudgetLines(id).catch(() => []),
  ])

  return (
    <div className="p-6 pt-0">
      <BidPackagesClient
        projectId={project.id}
        packages={packages}
        tradeOptions={tradeOptionsFromCompanies(companies)}
        costCodes={costCodes}
        budgetLines={budgetLines}
        initialDraft={initialDraft}
      />
    </div>
  )
}
