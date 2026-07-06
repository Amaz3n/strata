import { notFound, redirect } from "next/navigation"
import { Suspense } from "react"

import { getProjectAction, getProjectContractAction } from "@/app/(app)/projects/[id]/actions"
import { ReviewQueueTable } from "@/components/cost-inbox/review-queue-table"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import { loadFinancialsReviewQueueData } from "@/lib/services/financials-review-queue"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsReviewPage({ params }: PageProps) {
  const { id } = await params

  return (
    <Suspense fallback={<ReviewSkeleton />}>
      <ReviewContent id={id} />
    </Suspense>
  )
}

async function ReviewContent({ id }: { id: string }) {
  const [project, contract] = await Promise.all([
    getProjectAction(id),
    getProjectContractAction(id),
  ])
  if (!project) notFound()

  const featureConfig = getProjectFinancialFeatureConfig(project, contract)
  if (!featureConfig.showInbox) {
    redirect(`/projects/${project.id}/financials/receivables`)
  }

  const [reviewQueue, setupStatus] = await Promise.all([
    loadFinancialsReviewQueueData(id),
    getProjectFinancialSetupStatusForProject(id),
  ])

  return (
    <PageLayout
      title="Review"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials/receivables` },
        { label: "Review" },
      ]}
      fullBleed
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <ReviewQueueTable
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

function ReviewSkeleton() {
  return (
    <PageLayout title="Review" breadcrumbs={[{ label: "Project" }, { label: "Financials" }, { label: "Review" }]} fullBleed>
      <div className="space-y-3 px-4 pt-4 sm:px-6 lg:px-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    </PageLayout>
  )
}
