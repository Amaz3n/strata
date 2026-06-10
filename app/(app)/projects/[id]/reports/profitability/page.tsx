import { notFound } from "next/navigation"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { ProjectProfitabilityReportView } from "@/components/reports/project-profitability-report"
import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { getProjectProfitabilityReport } from "@/lib/services/reports/project-profitability"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectProfitabilityPage({ params }: PageProps) {
  const { id } = await params
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <ProfitabilityContent id={id} />
    </Suspense>
  )
}

async function ProfitabilityContent({ id }: { id: string }) {
  const [project, report] = await Promise.all([
    getProjectAction(id),
    getProjectProfitabilityReport({ projectId: id, basis: "accrual" }),
  ])
  if (!project) notFound()

  return (
    <PageLayout
      title="Project Profitability"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Reports", href: `/projects/${project.id}/reports` },
        { label: "Project Profitability" },
      ]}
      fullBleed
    >
      <ProjectProfitabilityReportView projectId={project.id} initialReport={report} />
    </PageLayout>
  )
}

function ReportSkeleton() {
  return (
    <PageLayout
      title="Project Profitability"
      breadcrumbs={[{ label: "Project" }, { label: "Reports" }, { label: "Project Profitability" }]}
      fullBleed
    >
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    </PageLayout>
  )
}
