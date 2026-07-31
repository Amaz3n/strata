import { notFound } from "next/navigation"

import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { PageLayout } from "@/components/layout/page-layout"
import { ReportCatalog } from "@/components/reports/report-catalog"
import { catalogFor, resolveProjectReportScope } from "@/lib/services/report-catalog"
import { listReportRuns } from "@/lib/services/report-runs"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectReportsPage({ params }: PageProps) {
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()

  const resolution = await resolveProjectReportScope(project)
  const [groups, runs] = await Promise.all([
    Promise.resolve(catalogFor(resolution)),
    listReportRuns({ projectId: project.id, limit: 5 }).catch(() => []),
  ])

  return (
    <PageLayout
      title="Reports"
      breadcrumbs={[{ label: project.name, href: `/projects/${project.id}` }, { label: "Reports" }]}
      fullBleed
    >
      <div className="desk-rise mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <ReportCatalog
          groups={groups}
          scope="project"
          projectId={project.id}
          posture={resolution.context.posture}
          recentRuns={runs}
        />
      </div>
    </PageLayout>
  )
}
