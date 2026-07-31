import Link from "next/link"

import type { ProjectPosture } from "@/lib/product-tier"
import { reportHref, reportSummary, type ReportCatalogGroup } from "@/lib/reports/registry"
import type { ReportRunDTO } from "@/lib/services/report-runs"
import type { ReportScope } from "@/lib/reports/types"
import { ArrowRight, History } from "@/components/icons"

function formatRunTime(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/**
 * The library. Every report reachable at this scope, grouped by domain — a
 * report that is not here does not exist, which is what keeps the registry
 * honest about the twenty-odd report services that used to be invisible.
 * Group order and row copy come from the posture, so a production builder
 * reads the catalog in their own vocabulary and priority.
 */
export function ReportCatalog({
  groups,
  scope,
  projectId,
  posture,
  recentRuns,
}: {
  groups: ReportCatalogGroup[]
  scope: ReportScope
  projectId?: string
  posture: ProjectPosture
  recentRuns: ReportRunDTO[]
}) {
  if (groups.length === 0) {
    return (
      <div className="border px-6 py-16 text-center">
        <p className="text-sm font-medium">No reports available</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your role does not include access to any reports at this scope. Ask an admin about the report permissions.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {recentRuns.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recent runs</h2>
          <ul className="divide-y border">
            {recentRuns.map((run) => (
              <li key={run.id}>
                <Link
                  href={`${reportHref(scope, run.slug, projectId)}?run=${run.id}`}
                  className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/40"
                >
                  <History className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{run.title}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatRunTime(run.createdAt)}
                    {run.runByName ? ` · ${run.runByName}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {groups.map((group) => (
        <section key={group.group} className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h2>
            <span className="text-[11px] tabular-nums text-muted-foreground">{group.reports.length}</span>
          </div>
          <ul className="grid border-t border-l sm:grid-cols-2 sm:[&>li:last-child:nth-child(odd)]:col-span-2">
            {group.reports.map((report) => (
              <li key={report.slug} className="border-b border-r">
                <Link
                  href={reportHref(scope, report.slug, projectId)}
                  className="group flex h-full items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{report.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {reportSummary(report, posture)}
                    </p>
                  </div>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
