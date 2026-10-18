import { evaluateReport } from "@/lib/services/report-workspace"
import { getSavedReportConfig } from "@/lib/services/report-configs"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { connection } from "next/server"

import { parseReportParams } from "@/lib/reports/params"
import { getReportDefinition } from "@/lib/reports/registry"
import { PageLayout } from "@/components/layout/page-layout"
import { ReportView } from "@/components/reports/report-view"
import { canRunReport, resolveOrgReportScope } from "@/lib/services/report-catalog"
import { getReportRun } from "@/lib/services/report-runs"


interface PageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

async function OrgReportPageContent({ params, searchParams }: PageProps) {
  await connection()
  const [{ slug }, search] = await Promise.all([params, searchParams])
  const definition = getReportDefinition(slug)
  if (!definition || !definition.scopes.includes("org")) notFound()

  const resolution = await resolveOrgReportScope()
  if (!search.run && !search.config && !canRunReport(resolution, definition)) notFound()

  const runId = typeof search.run === "string" ? search.run : undefined
  const [saved, snapshot] = await Promise.all([
    typeof search.config === "string" ? getSavedReportConfig(search.config) : undefined,
    runId ? getReportRun(runId) : null,
  ])
  if (saved && (saved.slug !== slug || saved.project_id !== (resolution.context.projectId ?? null))) notFound()
  const reportParams = parseReportParams(definition, saved ? { ...saved.params, _division: saved.division_id ?? "", _community: saved.community_id ?? "" } : search)
  const context = { ...resolution.context, params: reportParams }

  // `?run=<id>` replays a snapshot instead of re-querying, so the numbers a
  // lender received months ago are reproducible after the live data has drifted.
  if (runId && (!snapshot || snapshot.slug !== definition.slug || snapshot.scope !== "org")) notFound()

  const result = snapshot ? { base: snapshot.snapshot, context } : await evaluateReport(definition, context)

  return (
    <PageLayout fullBleed>
      <div className="desk-rise mx-auto w-full max-w-[1800px] px-4 py-6 sm:px-6 lg:px-8">
        <ReportView
          definition={definition}
          context={result.context}
          params={snapshot ? (snapshot.params as typeof reportParams) : result.context.params}
          result={result.base}
          saved={saved}
          snapshot={snapshot ?? undefined}
        />
      </div>
    </PageLayout>
  )
}

export default function OrgReportPage(props: Parameters<typeof OrgReportPageContent>[0]) {
  return (
    <Suspense fallback={<PageLayout title="Report" breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: "Report" }]} fullBleed><PageLoadingSkeleton /></PageLayout>}>
      <OrgReportPageContent {...props} />
    </Suspense>
  )
}
