import { Suspense } from "react"

import { fetchPayablesTabDataAction } from "@/app/(app)/projects/[id]/financials/actions"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { PayablesTab } from "@/components/financials/payables-tab"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import { loadFinancialsOverviewData } from "../page-data"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsPayablesPage({ params }: PageProps) {
  const { id } = await params

  return (
    <Suspense fallback={<FinancialsChildSkeleton title="Payables" />}>
      <FinancialsPayablesData id={id} />
    </Suspense>
  )
}

async function FinancialsPayablesData({ id }: { id: string }) {
  const [{ project }, data, setupStatus] = await Promise.all([
    loadFinancialsOverviewData(id),
    fetchPayablesTabDataAction(id),
    getProjectFinancialSetupStatusForProject(id),
  ])

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
        costCodes={data.costCodes}
        costCodesEnabled={setupStatus.settings?.cost_codes_enabled ?? true}
        complianceRules={data.complianceRules}
        complianceStatusByCompanyId={data.complianceStatusByCompanyId}
        loadErrors={data.errors}
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
