import { Suspense } from "react"
import { notFound } from "next/navigation"

import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { TrustCenterTab } from "@/components/financials/trust-center-tab"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import { getProjectTrustCenterData } from "@/lib/services/trust-center"

import { unwrapAction } from "@/lib/action-result"

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
  const [project, setupStatus, trustCenterData] = await Promise.all([
    getProjectAction(id),
    getProjectFinancialSetupStatusForProject(id),
    getProjectTrustCenterData(id),
  ])
  if (!project) notFound()

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
      <div className="w-full">
        <div className="grid border-b sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="border-r border-b p-4 last:border-r-0">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-8 w-32" />
            </div>
          ))}
        </div>
        <div className="p-4 sm:p-6 lg:p-8">
          <Skeleton className="h-80 w-full rounded-md" />
        </div>
      </div>
    </PageLayout>
  )
}
