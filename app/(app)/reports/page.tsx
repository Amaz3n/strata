import { PageLayout } from "@/components/layout/page-layout"
import { ReportCatalog } from "@/components/reports/report-catalog"
import { catalogFor, resolveOrgReportScope } from "@/lib/services/report-catalog"
import { listReportRuns } from "@/lib/services/report-runs"
import { listSavedReportConfigs } from "@/lib/services/report-configs"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

export default async function ReportsPage() {
  const resolution = await resolveOrgReportScope()
  const [groups, runs, saved] = await Promise.all([
    Promise.resolve(catalogFor(resolution)),
    listReportRuns({ limit: 5 }).catch(() => []),
    listSavedReportConfigs().catch(() => []),
  ])

  return (
    <PageLayout title="Reports" fullBleed>
      <div className="desk-rise mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        {saved.length > 0 && <section className="space-y-2"><h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Saved reports</h2><ul className="divide-y border">{saved.map((config: any) => <li key={config.id}><Link className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/40" href={`${config.scope === "project" ? `/projects/${config.project_id}` : ""}/reports/${config.slug}?${new URLSearchParams(config.params ?? {}).toString()}`}><div><p className="text-sm font-medium">{config.name}</p><p className="text-xs text-muted-foreground">{config.slug}</p></div><div className="flex items-center gap-2"><Badge variant="outline">{config.format.toUpperCase()}</Badge>{config.schedules?.some((item: any) => item.is_active) && <Badge>Scheduled</Badge>}</div></Link></li>)}</ul></section>}
        <ReportCatalog
          groups={groups}
          scope="org"
          posture={resolution.context.posture}
          recentRuns={runs.filter((run) => run.scope === "org")}
        />
      </div>
    </PageLayout>
  )
}
