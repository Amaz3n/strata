import { notFound, redirect } from "next/navigation"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { ReviewQueueTable } from "@/components/cost-inbox/review-queue-table"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { QboImportLauncher } from "@/components/integrations/qbo-import-launcher"
import { getProjectAction, getProjectContractAction } from "@/app/(app)/projects/[id]/actions"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import { loadFinancialsReviewQueueData } from "@/lib/services/financials-review-queue"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"

export const dynamic = "force-dynamic"

interface ProjectFinancialsPageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ tab?: string }>
}

const legacyTabRoutes: Record<string, string> = {
  budget: "budget",
  receivables: "receivables",
  payables: "payables",
}

export default async function ProjectFinancialsInboxPage({ params, searchParams }: ProjectFinancialsPageProps) {
  const { id } = await params
  const { tab } = (await searchParams) ?? {}

  if (tab && legacyTabRoutes[tab]) {
    redirect(`/projects/${id}/financials/${legacyTabRoutes[tab]}`)
  }
  if (tab === "cost-plus") {
    redirect(`/projects/${id}/financials`)
  }

  return (
    <Suspense fallback={<InboxSkeleton />}>
      <InboxContent id={id} />
    </Suspense>
  )
}

async function InboxContent({ id }: { id: string }) {
  const [project, contract] = await Promise.all([
    getProjectAction(id),
    getProjectContractAction(id),
  ])
  if (!project) notFound()

  const featureConfig = getProjectFinancialFeatureConfig(project, contract)
  if (featureConfig.landingPage !== "inbox") {
    redirect(`/projects/${project.id}/financials/${featureConfig.landingPage}`)
  }

  const [reviewQueue, setupStatus] = await Promise.all([
    loadFinancialsReviewQueueData(id),
    getProjectFinancialSetupStatusForProject(id),
  ])

  return (
    <PageLayout
      title="Inbox"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials` },
        { label: "Inbox" },
      ]}
      fullBleed
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <div className="flex items-center justify-end border-b bg-muted/20 px-4 py-2 sm:px-6 lg:px-8">
        <QboImportLauncher projectId={project.id} projectName={project.name} />
      </div>
      <ReviewQueueTable
        projectId={project.id}
        timeEntries={reviewQueue.timeEntries}
        expenses={reviewQueue.expenses}
        vendorBills={reviewQueue.vendorBills}
        openCosts={reviewQueue.openCosts}
        billingPeriods={reviewQueue.billingPeriods}
        costCodes={reviewQueue.costCodes as any}
        costCodesEnabled={reviewQueue.costCodesEnabled}
        loadErrors={reviewQueue.errors}
      />
    </PageLayout>
  )
}

function InboxSkeleton() {
  return (
    <PageLayout title="Inbox" breadcrumbs={[{ label: "Project" }, { label: "Financials" }, { label: "Inbox" }]} fullBleed>
      <div className="space-y-3 px-4 pt-4 sm:px-6 lg:px-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    </PageLayout>
  )
}
