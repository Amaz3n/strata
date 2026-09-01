import { notFound, redirect } from "next/navigation"
import { Suspense } from "react"

import { getProjectAction, getProjectContractAction } from "@/app/(app)/projects/[id]/actions"
import { CostInboxTable } from "@/components/cost-inbox/cost-inbox-table"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import { loadCostInboxData } from "@/lib/services/cost-inbox"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"

import { unwrapAction } from "@/lib/action-result"


interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsCostInboxPage({ params }: PageProps) {
  const { id } = await params

  return (
    <Suspense fallback={<CostInboxSkeleton />}>
      <CostInboxContent id={id} />
    </Suspense>
  )
}

async function CostInboxContent({ id }: { id: string }) {
  const [project, contract] = await Promise.all([
    getProjectAction(id),
    getProjectContractAction(id),
  ])
  if (!project) notFound()

  const featureConfig = getProjectFinancialFeatureConfig(project, contract)
  if (!featureConfig.showInbox) {
    redirect(`/projects/${project.id}/financials/billing`)
  }

  const [reviewQueue, setupStatus] = await Promise.all([
    loadCostInboxData(id),
    getProjectFinancialSetupStatusForProject(id),
  ])

  return (
    <PageLayout
      title="Cost Inbox"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials/billing` },
        { label: "Cost Inbox" },
      ]}
      fullBleed
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <CostInboxTable
        projectId={project.id}
        timeEntries={reviewQueue.timeEntries}
        expenses={reviewQueue.expenses}
        vendorBills={reviewQueue.vendorBills}
        openCosts={reviewQueue.openCosts}
        billingPeriods={reviewQueue.billingPeriods}
        costCodes={reviewQueue.costCodes as any}
        costCodesEnabled={reviewQueue.costCodesEnabled}
        feeSummary={reviewQueue.feeSummary}
        loadErrors={reviewQueue.errors}
      />
    </PageLayout>
  )
}

function CostInboxSkeleton() {
  return (
    <PageLayout title="Cost Inbox" breadcrumbs={[{ label: "Project" }, { label: "Financials" }, { label: "Cost Inbox" }]} fullBleed>
      <div className="space-y-3 px-4 pt-4 sm:px-6 lg:px-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    </PageLayout>
  )
}
