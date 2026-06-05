import { Suspense } from "react"

import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { TrustCenterTab } from "@/components/financials/trust-center-tab"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import { getProjectTrustCenterData } from "@/lib/services/trust-center"
import { loadFinancialsOverviewData } from "../page-data"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsTrustCenterPage({ params }: PageProps) {
  const { id } = await params

  return (
    <Suspense fallback={<FinancialsTrustCenterSkeleton />}>
      <FinancialsTrustCenterData id={id} />
    </Suspense>
  )
}

async function FinancialsTrustCenterData({ id }: { id: string }) {
  const [{ project }, trustCenterData, setupStatus] = await Promise.all([
    loadFinancialsOverviewData(id),
    getProjectTrustCenterData(id),
    getProjectFinancialSetupStatusForProject(id),
  ])

  return (
    <PageLayout
      title="Trust Center"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials` },
        { label: "Trust Center" },
      ]}
      fullBleed
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <TrustCenterTab projectId={project.id} data={trustCenterData} />
    </PageLayout>
  )
}

function FinancialsTrustCenterSkeleton() {
  return (
    <PageLayout
      title="Trust Center"
      breadcrumbs={[{ label: "Project" }, { label: "Financials" }, { label: "Trust Center" }]}
      fullBleed
    >
      <div className="space-y-3 px-4 pt-4 sm:px-6 lg:px-8">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </PageLayout>
  )
}
