import { Suspense } from "react"
import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { ReportLibrary } from "@/components/reports/report-library"
import { catalogFor, resolveOrgReportScope } from "@/lib/services/report-catalog"
import { listReportRuns } from "@/lib/services/report-runs"
import { listSavedReportConfigs } from "@/lib/services/report-configs"
import { reportSummary } from "@/lib/reports/registry"
async function ReportsPageContent() {
  await connection()
  const resolution = await resolveOrgReportScope()
  const [runs, saved] = await Promise.all([listReportRuns({ limit: 50 }), listSavedReportConfigs()])
  const reports = catalogFor(resolution).flatMap(g => g.reports.map(r => ({ slug: r.slug, title: r.title, summary: reportSummary(r, resolution.context.posture), group: r.group, href: `/reports/${r.slug}` })))
  return <PageLayout title="Reports" fullBleed><ReportLibrary reports={reports} saved={saved} runs={runs} /></PageLayout>
}
export default function ReportsPage() { return <Suspense fallback={<PageLayout title="Reports" fullBleed><PageLoadingSkeleton /></PageLayout>}><ReportsPageContent /></Suspense> }
