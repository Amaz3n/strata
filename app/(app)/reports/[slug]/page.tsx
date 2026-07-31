import { notFound } from "next/navigation"

import { parseReportParams } from "@/lib/reports/params"
import { getReportDefinition } from "@/lib/reports/registry"
import { PageLayout } from "@/components/layout/page-layout"
import { ReportView } from "@/components/reports/report-view"
import { canRunReport, resolveOrgReportScope } from "@/lib/services/report-catalog"
import { getReportRun, listReportRuns } from "@/lib/services/report-runs"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function OrgReportPage({ params, searchParams }: PageProps) {
  const [{ slug }, search] = await Promise.all([params, searchParams])
  const definition = getReportDefinition(slug)
  if (!definition || !definition.scopes.includes("org")) notFound()

  const resolution = await resolveOrgReportScope()
  if (!canRunReport(resolution, definition)) notFound()

  const reportParams = parseReportParams(definition, search)
  const context = { ...resolution.context, params: reportParams }

  // `?run=<id>` replays a snapshot instead of re-querying, so the numbers a
  // lender received months ago are reproducible after the live data has drifted.
  const runId = typeof search.run === "string" ? search.run : undefined
  const snapshot = runId ? await getReportRun(runId) : null
  if (runId && (!snapshot || snapshot.slug !== definition.slug)) notFound()

  const [result, runs] = await Promise.all([
    snapshot ? Promise.resolve(snapshot.snapshot) : definition.run(context),
    listReportRuns({ slug: definition.slug, limit: 25 }).catch(() => []),
  ])

  return (
    <PageLayout title={definition.title} breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: definition.title }]} fullBleed>
      <div className="desk-rise mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <ReportView
          definition={definition}
          context={context}
          params={snapshot ? (snapshot.params as typeof reportParams) : reportParams}
          result={result}
          runs={runs.filter((run) => run.scope === "org")}
          snapshot={snapshot ?? undefined}
        />
      </div>
    </PageLayout>
  )
}
