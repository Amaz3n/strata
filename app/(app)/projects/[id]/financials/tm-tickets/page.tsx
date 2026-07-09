import { notFound, redirect } from "next/navigation"
import { Suspense } from "react"

import { getProjectAction, getProjectContractAction } from "@/app/(app)/projects/[id]/actions"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { TmTicketWorkflow } from "@/components/financials/tm-ticket-workflow"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import { loadFinancialsReviewQueueData } from "@/lib/services/financials-review-queue"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import { listProjectTmTickets } from "@/lib/services/tm-tickets"

import { unwrapAction } from "@/lib/action-result"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function TimeAndMaterialsTicketsPage({ params }: PageProps) {
  const { id } = await params

  return (
    <Suspense fallback={<TmTicketsSkeleton />}>
      <TmTicketsContent id={id} />
    </Suspense>
  )
}

async function TmTicketsContent({ id }: { id: string }) {
  const [project, contract] = await Promise.all([
    getProjectAction(id),
    getProjectContractAction(id),
  ])
  if (!project) notFound()

  const featureConfig = getProjectFinancialFeatureConfig(project, contract)
  if (featureConfig.billingModel !== "time_and_materials") {
    redirect(`/projects/${project.id}/financials/receivables`)
  }

  const [reviewQueue, setupStatus, tickets] = await Promise.all([
    loadFinancialsReviewQueueData(id),
    getProjectFinancialSetupStatusForProject(id),
    listProjectTmTickets(id),
  ])
  const activeTicketedCostIds = new Set(
    tickets
      .filter((ticket) => ticket.status !== "voided")
      .flatMap((ticket) => ticket.items.map((item) => item.billable_cost_id).filter(Boolean) as string[]),
  )
  const openCosts = reviewQueue.openCosts.filter(
    (cost: any) =>
      cost.status === "open" &&
      cost.queue_state !== "blocked" &&
      ["time_entry", "project_expense", "project_expense_line"].includes(cost.source_type) &&
      !activeTicketedCostIds.has(cost.id),
  )

  return (
    <PageLayout
      title="T&M Tickets"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials/receivables` },
        { label: "T&M Tickets" },
      ]}
      fullBleed
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <TmTicketWorkflow projectId={project.id} tickets={tickets} openCosts={openCosts} />
    </PageLayout>
  )
}

function TmTicketsSkeleton() {
  return (
    <PageLayout title="T&M Tickets" breadcrumbs={[{ label: "Project" }, { label: "Financials" }, { label: "T&M Tickets" }]} fullBleed>
      <div className="space-y-3 px-4 pt-4 sm:px-6 lg:px-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    </PageLayout>
  )
}
