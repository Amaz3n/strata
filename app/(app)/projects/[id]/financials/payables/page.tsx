import { Suspense } from "react"

import { fetchPayablesTabDataAction } from "@/app/(app)/projects/[id]/financials/actions"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { PayablesTab } from "@/components/financials/payables-tab"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import { loadFinancialsOverviewData } from "../page-data"
import { evaluateHolds } from "@/lib/services/payment-holds"

import { unwrapAction } from "@/lib/action-result"
import { listSavedPayableViews } from "@/lib/services/payable-views"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ queue?: string; q?: string; page?: string; pageSize?: string }>
}

export default async function FinancialsPayablesPage({ params, searchParams }: PageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams])

  return (
    <Suspense fallback={<FinancialsChildSkeleton title="Payables" />}>
      <FinancialsPayablesData id={id} query={query} />
    </Suspense>
  )
}

async function FinancialsPayablesData({ id, query }: { id: string; query: { queue?: string; q?: string; page?: string; pageSize?: string } }) {
  const [{ project }, data, setupStatus, savedViews] = await Promise.all([
    loadFinancialsOverviewData(id),
    fetchPayablesTabDataAction(id, { queue: query.queue, search: query.q, page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 50 }),
    getProjectFinancialSetupStatusForProject(id),
    listSavedPayableViews(id).catch(() => []),
  ])
  const holdEntries = await Promise.all(data.vendorBills.map(async (bill) => [bill.id, await evaluateHolds(bill.id).catch(() => null)] as const))
  const holdEvaluations = Object.fromEntries(holdEntries.filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null))

  return (
    <PageLayout
      title="Payables"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials` },
        { label: "Payables" },
      ]}
      fullBleed
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <PayablesTab
        projectId={project.id}
        vendorBills={data.vendorBills}
        pagination={data.vendorBillsPage}
        initialQueue={query.queue ?? "needs_review"}
        initialSearch={query.q ?? ""}
        savedViews={savedViews}
        costCodes={data.costCodes}
        budgetLines={data.budgetLines}
        costCodesEnabled={setupStatus.costCodesEnabled}
        billingModel={setupStatus.billingModel}
        complianceRules={data.complianceRules}
        complianceStatusByCompanyId={data.complianceStatusByCompanyId}
        loadErrors={data.errors}
        holdEvaluations={holdEvaluations}
      />
    </PageLayout>
  )
}

function FinancialsChildSkeleton({ title }: { title: string }) {
  return (
    <PageLayout title={title} breadcrumbs={[{ label: "Project" }, { label: "Financials" }, { label: title }]} fullBleed>
      <div className="w-full">
        <div className="flex min-h-14 items-center border-b px-4 sm:px-6 lg:px-8">
          <Skeleton className="h-8 w-full max-w-3xl" />
        </div>
        <div className="p-4 sm:p-6 lg:p-8">
          <Skeleton className="h-80 w-full rounded-md" />
        </div>
      </div>
    </PageLayout>
  )
}
