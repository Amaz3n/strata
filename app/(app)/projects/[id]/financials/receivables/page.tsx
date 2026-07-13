import { Suspense } from "react"

import { fetchReceivablesTabDataAction } from "@/app/(app)/projects/[id]/financials/actions"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { ReceivablesTab } from "@/components/financials/receivables-tab"
import { OurComplianceCard } from "@/components/financials/our-compliance-card"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { loadFinancialsReceivablesData } from "../page-data"

import { unwrapAction } from "@/lib/action-result"
import { listComplianceDocumentTypes } from "@/lib/services/compliance-documents"
import { listProjectOwnComplianceDocuments } from "@/lib/services/project-own-compliance"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ period?: string }>
}

export default async function FinancialsReceivablesPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const { period } = (await searchParams) ?? {}

  return (
    <Suspense fallback={<FinancialsChildSkeleton title="Receivables" />}>
      <FinancialsReceivablesData id={id} periodId={period ?? null} />
    </Suspense>
  )
}

async function FinancialsReceivablesData({ id, periodId }: { id: string; periodId: string | null }) {
  const [financialsData, receivablesData, ownCompliance, complianceTypes] = await Promise.all([
    loadFinancialsReceivablesData(id, periodId),
    fetchReceivablesTabDataAction(id),
    listProjectOwnComplianceDocuments(id),
    listComplianceDocumentTypes(),
  ])
  const { project, scheduleItems, contract, draws, retainage, builderInfo, featureConfig, setupStatus } = financialsData

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
      <OurComplianceCard
        projectId={project.id}
        documents={ownCompliance}
        documentTypes={complianceTypes.map((type) => ({ id: type.id, name: type.name, has_expiry: type.has_expiry }))}
      />
      <ReceivablesTab
        projectId={project.id}
        project={project}
        billingModel={featureConfig.billingModel}
        showDraws={featureConfig.showDraws}
        showRetainage={financialsData.showRetainage}
        sovState={financialsData.sovState}
        payApplications={financialsData.payApplications}
        closeWorkflow={
          financialsData.costDriven
            ? {
                periods: financialsData.billingPeriods,
                selectedPeriod: financialsData.selectedPeriod,
                summary: financialsData.closeSummary,
                feeSummary: financialsData.feeSummary,
                gmpSummary: financialsData.gmpSummary,
                autopilot: financialsData.autopilot,
                loadErrors: financialsData.loadErrors,
              }
            : null
        }
        invoices={receivablesData.invoices}
        draws={draws}
        retainage={retainage}
        contacts={receivablesData.contacts}
        costCodes={receivablesData.costCodes}
        costCodesEnabled={setupStatus.settings?.cost_codes_enabled ?? true}
        ownerBillingPackages={receivablesData.ownerBillingPackages}
        feeSummary={receivablesData.feeSummary}
        arSummary={receivablesData.arSummary}
        contract={contract}
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
