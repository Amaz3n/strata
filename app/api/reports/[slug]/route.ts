import { NextRequest, NextResponse } from "next/server"

import { renderReportPdf } from "@/lib/pdfs/report"
import { csvFilename, reportToCsv } from "@/lib/reports/export-csv"
import { ambientScopeLabel, describeParams, parseReportParams } from "@/lib/reports/params"
import { getReportDefinition, supportsFormat } from "@/lib/reports/registry"
import type { ReportFormat } from "@/lib/reports/types"
import { getOrgBilling } from "@/lib/services/orgs"
import { canRunReport, resolveOrgReportScope, resolveProjectReportScopeById } from "@/lib/services/report-catalog"
import { recordReportRun } from "@/lib/services/report-runs"

export const runtime = "nodejs"

/**
 * The single export path for the whole catalog. Because it runs the same
 * definition the page runs and serialises the same result the page rendered,
 * an exported file can never disagree with the screen.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const search = request.nextUrl.searchParams
  const requestedFormat = search.get("format") ?? "csv"
  const projectId = search.get("projectId")?.trim() || undefined

  const definition = getReportDefinition(slug)
  if (!definition) {
    return NextResponse.json({ error: `Unknown report "${slug}".` }, { status: 404 })
  }
  if (!supportsFormat(definition, requestedFormat)) {
    return NextResponse.json({ error: `Report "${slug}" cannot be exported as ${requestedFormat}.` }, { status: 400 })
  }
  const format = requestedFormat as ReportFormat

  try {
    const scope = projectId ? "project" : "org"
    if (!definition.scopes.includes(scope)) {
      return NextResponse.json({ error: `Report "${slug}" is not available at ${scope} scope.` }, { status: 400 })
    }

    const resolution = projectId ? await resolveProjectReportScopeById(projectId) : await resolveOrgReportScope()
    if (!resolution) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 })
    }

    if (!canRunReport(resolution, definition)) {
      return NextResponse.json({ error: "You do not have access to this report." }, { status: 403 })
    }

    const rawParams: Record<string, string> = {}
    search.forEach((value, key) => {
      rawParams[key] = value
    })
    const reportParams = parseReportParams(definition, rawParams)
    const context = { ...resolution.context, params: reportParams }
    const result = await definition.run(context)

    // Every file that leaves the building is snapshotted. A failure to record
    // must not swallow the export — the user still gets their file.
    await recordReportRun({ slug: definition.slug, context, title: definition.title, result, format }).catch(() => null)

    if (format === "json") {
      return NextResponse.json({ slug: definition.slug, title: definition.title, params: reportParams, result })
    }

    // Same provenance rule as the viewer: name only the lens the report honours,
    // and never repeat what the report already worked into its own subtitle.
    const lens =
      resolution.context.scope === "project"
        ? resolution.context.scopeLabel
        : ambientScopeLabel(resolution.context, definition.ambientScope)
    const provenance = [
      result.subtitle,
      lens,
      ...describeParams(definition, reportParams).filter((part) => !result.subtitle?.includes(part)),
    ]
      .filter(Boolean)
      .join(" · ")

    if (format === "pdf") {
      const billing = await getOrgBilling().catch(() => null)
      const pdf = await renderReportPdf({
        title: definition.title,
        provenance,
        result,
        branding: {
          org_name: (billing?.org?.name as string | undefined) ?? null,
          org_logo_url: (billing?.org?.logo_url as string | undefined) ?? null,
        },
      })
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${csvFilename(definition.slug, result.subtitle).replace(/\.csv$/, ".pdf")}"`,
          "Cache-Control": "no-store",
        },
      })
    }

    return new NextResponse(reportToCsv(result), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(definition.slug, result.subtitle)}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to build report." }, { status: 400 })
  }
}
