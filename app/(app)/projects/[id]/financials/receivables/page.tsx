import { Suspense } from "react"

import { fetchReceivablesTabDataAction } from "@/app/(app)/projects/[id]/financials/actions"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { ReceivablesTab } from "@/components/financials/receivables-tab"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import { loadFinancialsReceivablesData } from "../page-data"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsReceivablesPage({ params }: PageProps) {
  const { id } = await params

  return (
    <Suspense fallback={<FinancialsChildSkeleton title="Receivables" />}>
      <FinancialsReceivablesData id={id} />
    </Suspense>
  )
}

async function FinancialsReceivablesData({ id }: { id: string }) {
  const [financialsData, receivablesData, setupStatus] = await Promise.all([
    loadFinancialsReceivablesData(id),
    fetchReceivablesTabDataAction(id),
    getProjectFinancialSetupStatusForProject(id),
  ])
  const { project, scheduleItems, contract, draws, retainage, approvedChangeOrdersTotalCents, builderInfo } = financialsData

  return (
    <PageLayout
      title="Receivables"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials` },
        { label: "Receivables" },
      ]}
      fullBleed
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <ReceivablesTab
        projectId={project.id}
        project={project}
        invoices={receivablesData.invoices}
        draws={draws}
        retainage={retainage}
        contacts={receivablesData.contacts}
        costCodes={receivablesData.costCodes}
        costCodesEnabled={setupStatus.settings?.cost_codes_enabled ?? true}
        ownerBillingPackages={receivablesData.ownerBillingPackages}
        feeSummary={receivablesData.feeSummary}
        gmpSummary={receivablesData.gmpSummary}
        contract={contract}
        approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
        scheduleItems={scheduleItems}
        builderInfo={builderInfo}
        loadErrors={receivablesData.errors}
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
