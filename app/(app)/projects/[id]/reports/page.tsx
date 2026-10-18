import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { notFound } from "next/navigation"

import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { PageLayout } from "@/components/layout/page-layout"
import { ReportLibrary } from "@/components/reports/report-library"
import { reportSummary } from "@/lib/reports/registry"
import { listSavedReportConfigs } from "@/lib/services/report-configs"
import { catalogFor, resolveProjectReportScope } from "@/lib/services/report-catalog"
import { listReportRuns } from "@/lib/services/report-runs"


interface PageProps {
  params: Promise<{ id: string }>
}

async function ProjectReportsPageContent({ params }: PageProps) {
  await connection()
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()

  const resolution = await resolveProjectReportScope(project)
  const [groups, runs, saved] = await Promise.all([
    Promise.resolve(catalogFor(resolution)),
    listReportRuns({ projectId: project.id, limit: 50 }),
    listSavedReportConfigs(),
  ])

  return (
    <PageLayout
      title="Reports"
      breadcrumbs={[{ label: project.name, href: `/projects/${project.id}` }, { label: "Reports" }]}
      fullBleed
    >
      <ReportLibrary projectId={project.id} reports={groups.flatMap(g => g.reports.map(r => ({ slug: r.slug, title: r.title, summary: reportSummary(r, resolution.context.posture), group: r.group, href: `/projects/${project.id}/reports/${r.slug}` })))} saved={saved} runs={runs} />
    </PageLayout>
  )
}

export default function ProjectReportsPage(props: Parameters<typeof ProjectReportsPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Reports" fullBleed>
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <ProjectReportsPageContent {...props} />
    </Suspense>
  )
}
