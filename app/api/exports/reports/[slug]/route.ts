import { NextRequest, NextResponse } from "next/server"
import { reportToCsv, csvFilename } from "@/lib/reports/export-csv"
import { supportsFormat } from "@/lib/reports/registry"
import type { ReportFormat } from "@/lib/reports/types"
import { resolveReportExportToken, runTokenReport } from "@/lib/services/report-configs"

export const runtime = "nodejs"

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? request.nextUrl.searchParams.get("token")
  if (!bearer) return NextResponse.json({ error: "Missing report export token." }, { status: 401 })
  const access = await resolveReportExportToken(bearer)
  if (!access) return NextResponse.json({ error: "Invalid or expired report export token." }, { status: 401 })
  const { slug } = await params
  const format = (request.nextUrl.searchParams.get("format") ?? "json") as ReportFormat
  const definition = (await import("@/lib/reports/registry")).getReportDefinition(slug)
  if (!definition || !supportsFormat(definition, format) || format === "pdf") return NextResponse.json({ error: "This endpoint supports this report as CSV or JSON." }, { status: 400 })
  const raw: Record<string, string> = {}
  request.nextUrl.searchParams.forEach((value, key) => { if (!(["format", "token", "projectId"].includes(key))) raw[key] = value })
  try {
    const built = await runTokenReport({ ...access, slug, projectId: request.nextUrl.searchParams.get("projectId") ?? undefined, params: raw, format })
    if (format === "csv") return new NextResponse(reportToCsv(built.result), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${csvFilename(slug, built.result.subtitle)}"`, "Cache-Control": "no-store" } })
    return NextResponse.json({ slug, params: raw, result: built.result }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to export report." }, { status: 403 })
  }
}
