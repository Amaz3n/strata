import { notFound } from "next/navigation"

import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { PageLayout } from "@/components/layout/page-layout"
import { WipOverUnderReportView } from "@/components/reports/wip-over-under-report"
import { getProjectWipOverUnderReport } from "@/lib/services/reports/wip-over-under"

import { unwrapAction } from "@/lib/action-result"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectWipReportPage({ params }: PageProps) {
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()

  const report = await getProjectWipOverUnderReport({ projectId: project.id })

  return (
    <PageLayout
      title="WIP / Over-Under"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Reports", href: `/projects/${project.id}/reports` },
        { label: "WIP" },
      ]}
      fullBleed
    >
      <div className="mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <WipOverUnderReportView
          report={report}
          csvHref={`/api/projects/${project.id}/reports/wip?format=csv`}
        />
      </div>
    </PageLayout>
  )
}
