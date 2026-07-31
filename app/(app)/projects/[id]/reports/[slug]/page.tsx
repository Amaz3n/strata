import { notFound } from "next/navigation"

import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { parseReportParams } from "@/lib/reports/params"
import { getReportDefinition } from "@/lib/reports/registry"
import { PageLayout } from "@/components/layout/page-layout"
import { ReportView } from "@/components/reports/report-view"
import { canRunReport, resolveProjectReportScope } from "@/lib/services/report-catalog"
import { getReportRun, listReportRuns } from "@/lib/services/report-runs"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string; slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function ProjectReportPage({ params, searchParams }: PageProps) {
  const [{ id, slug }, search] = await Promise.all([params, searchParams])
  const definition = getReportDefinition(slug)
  if (!definition || !definition.scopes.includes("project")) notFound()

  const project = await getProjectAction(id)
  if (!project) notFound()

  const resolution = await resolveProjectReportScope(project)
  if (!canRunReport(resolution, definition)) notFound()

  const reportParams = parseReportParams(definition, search)
  const context = { ...resolution.context, params: reportParams }

  const runId = typeof search.run === "string" ? search.run : undefined
  const snapshot = runId ? await getReportRun(runId) : null
  if (runId && (!snapshot || snapshot.slug !== definition.slug || snapshot.projectId !== project.id)) notFound()

  const [result, runs] = await Promise.all([
    snapshot ? Promise.resolve(snapshot.snapshot) : definition.run(context),
    listReportRuns({ slug: definition.slug, projectId: project.id, limit: 25 }).catch(() => []),
  ])

  return (
    <PageLayout
      title={definition.title}
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Reports", href: `/projects/${project.id}/reports` },
        { label: definition.title },
      ]}
      fullBleed
    >
      <div className="desk-rise mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <ReportView
          definition={definition}
          context={context}
          params={snapshot ? (snapshot.params as typeof reportParams) : reportParams}
          result={result}
          runs={runs}
          snapshot={snapshot ?? undefined}
        />
      </div>
    </PageLayout>
  )
}
