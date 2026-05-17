import { Suspense } from "react"

import { fetchBudgetTabDataAction } from "@/app/(app)/projects/[id]/financials/actions"
import { BudgetTab } from "@/components/financials/budget-tab"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { loadFinancialsOverviewData } from "../page-data"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsBudgetPage({ params }: PageProps) {
  const { id } = await params

  return (
    <Suspense fallback={<FinancialsChildSkeleton title="Budget" />}>
      <FinancialsBudgetData id={id} />
    </Suspense>
  )
}

async function FinancialsBudgetData({ id }: { id: string }) {
  const [{ project }, data] = await Promise.all([
    loadFinancialsOverviewData(id),
    fetchBudgetTabDataAction(id),
  ])

  return (
    <PageLayout
      title="Budget"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials` },
        { label: "Budget" },
      ]}
    >
      <BudgetTab
        projectId={project.id}
        project={project}
        budgetData={data.budgetData}
        costCodes={data.costCodes}
        varianceAlerts={data.varianceAlerts}
        commitments={data.commitments}
        companies={data.companies}
        budgetBucketCompanies={data.budgetBucketCompanies}
        loadErrors={data.errors}
      />
    </PageLayout>
  )
}

function FinancialsChildSkeleton({ title }: { title: string }) {
  return (
    <PageLayout title={title} breadcrumbs={[{ label: "Project" }, { label: "Financials" }, { label: title }]}>
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-72 w-full rounded-md" />
      </div>
    </PageLayout>
  )
}
