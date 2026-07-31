import Link from "next/link"

import { ambientScopeLabel, describeParams } from "@/lib/reports/params"
import { reportCatalogHref, reportFormats } from "@/lib/reports/registry"
import type { ReportDefinition, ReportParams, ReportResult, ReportScopeContext } from "@/lib/reports/types"
import type { ReportRunDTO } from "@/lib/services/report-runs"
import { ReportBody } from "@/components/reports/report-body"
import { ReportExportMenu } from "@/components/reports/report-export-menu"
import { ReportParamBar } from "@/components/reports/report-param-bar"
import { ReportRunsSheet } from "@/components/reports/report-runs-sheet"
import { ArrowLeft, History } from "@/components/icons"

function formatRunTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/**
 * The viewer shell every report shares: provenance header, parameter bar,
 * exports, run history. The body underneath is the same `ReportResult` the
 * export route serialises.
 */
export function ReportView({
  definition,
  context,
  params,
  result,
  runs,
  snapshot,
}: {
  definition: ReportDefinition
  context: ReportScopeContext
  params: ReportParams
  result: ReportResult
  runs: ReportRunDTO[]
  /** Set when viewing a historical run instead of live data. */
  snapshot?: ReportRunDTO
}) {
  const catalogHref = reportCatalogHref(context.scope, context.projectId)
  // Name the lens only where the report actually applies it, and drop parameter
  // descriptions the report already worked into its own subtitle.
  const lens = context.scope === "project" ? context.scopeLabel : ambientScopeLabel(context, definition.ambientScope)
  const subtitle = result.subtitle
  const paramParts = describeParams(definition, params).filter(
    (part) => !subtitle || !subtitle.includes(part),
  )
  const provenance = [subtitle, lens, ...paramParts].filter(Boolean)

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={catalogHref}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          All reports
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{definition.title}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{provenance.join(" · ")}</p>
        </div>
        {snapshot ? null : (
          <div className="flex shrink-0 items-center gap-2">
            <ReportRunsSheet runs={runs} runHrefBase={`${catalogHref}/${definition.slug}`} />
            <ReportExportMenu
              slug={definition.slug}
              projectId={context.projectId}
              formats={reportFormats(definition)}
            />
          </div>
        )}
      </div>

      {snapshot ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <History className="size-4 shrink-0" />
            Snapshot from {formatRunTime(snapshot.createdAt)}
            {snapshot.runByName ? ` by ${snapshot.runByName}` : ""} — not live data.
          </span>
          <Link
            href={`${catalogHref}/${definition.slug}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            View live
          </Link>
        </div>
      ) : (
        <ReportParamBar specs={definition.params ?? []} values={params} />
      )}

      <ReportBody result={result} />
    </div>
  )
}
