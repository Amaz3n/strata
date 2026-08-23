import { Suspense } from "react"

import { fetchBudgetTabDataAction } from "@/app/(app)/projects/[id]/financials/actions"
import { BudgetTab } from "@/components/financials/budget/budget-tab"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import { hasPermission } from "@/lib/services/permissions"
import { loadFinancialsOverviewData } from "../page-data"
import { listBudgetSnapshots } from "@/lib/services/budgets"
import { getProjectPocPosition } from "@/lib/services/poc"
import { BudgetSnapshotComparison } from "@/components/financials/budget-snapshot-comparison"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsBudgetPage({ params }: PageProps) {
  const { id } = await params

  return (
    <Suspense fallback={<FinancialsBudgetSkeleton />}>
      <FinancialsBudgetData id={id} />
    </Suspense>
  )
}

async function FinancialsBudgetData({ id }: { id: string }) {
  const [{ project, contract }, data, setupStatus, snapshots, poc, canWrite] = await Promise.all([
    loadFinancialsOverviewData(id),
    fetchBudgetTabDataAction(id),
    getProjectFinancialSetupStatusForProject(id),
    listBudgetSnapshots(id).catch(() => []),
    // The WIP band needs both revenue sides. A viewer who may see the budget but
    // not invoices simply loses the band rather than the page.
    getProjectPocPosition(id).catch(() => null),
    hasPermission("budget.write"),
  ])

  const featureConfig = getProjectFinancialFeatureConfig(project, contract)

  return (
    <PageLayout
      title="Budget"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials` },
        { label: "Budget" },
      ]}
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <BudgetTab
        projectId={project.id}
        project={project}
        contractValueCents={contract?.total_cents ?? 0}
        poc={poc}
        budgetData={data.budgetData}
        costCodes={data.costCodes}
        costCodesEnabled={setupStatus.costCodesEnabled}
        varianceAlerts={data.varianceAlerts}
        budgetBucketCompanies={data.budgetBucketCompanies}
        buyoutStatus={data.buyoutStatus}
        feeSummary={data.feeSummary}
        gmpSummary={data.gmpSummary}
        loadErrors={data.errors}
        budgetTransfers={data.budgetTransfers}
        canWrite={canWrite}
        lockAfterBaseline={featureConfig.lockBudgetLinesAfterBaseline}
      />
      <BudgetSnapshotComparison projectId={project.id} snapshots={snapshots} />
    </PageLayout>
  )
}

/** Skeleton mirroring the real layout: KPI strip, controls bar, table rows. */
function FinancialsBudgetSkeleton() {
  return (
    <PageLayout title="Budget" breadcrumbs={[{ label: "Project" }, { label: "Financials" }, { label: "Budget" }]}>
      <div className="-mx-4 -mt-6 flex flex-col bg-card">
        <div className="grid grid-cols-1 border-b sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className="flex flex-col gap-2.5 border-b px-6 py-6 last:border-b-0 sm:px-8 lg:border-b-0 lg:border-r lg:last:border-r-0"
            >
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-32" />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="ml-auto h-9 w-24" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="flex h-[60px] items-center gap-4 px-4">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="ml-auto h-4 w-24" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </PageLayout>
  )
}
