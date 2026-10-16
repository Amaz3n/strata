import { NextRequest, NextResponse } from "next/server"

import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { getVarianceAnalysis, varianceAnalysisCsv } from "@/lib/services/reports/variance-analysis"

/** The Variance tab's export: the same rows the desk shows for the same period and division lens. */
export async function GET(request: NextRequest) {
  const from = request.nextUrl.searchParams.get("from") ?? ""
  const to = request.nextUrl.searchParams.get("to") ?? ""
  try {
    const ambient = await getAmbientDeskContext()
    const report = await getVarianceAnalysis({ startDate: from, endDate: to, divisionId: ambient.divisionId })
    const division = ambient.divisions.find((row) => row.id === ambient.divisionId)
    const csv = varianceAnalysisCsv(report.rows, { startDate: from, endDate: to, scopeLabel: division?.name ?? "All divisions" })
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="variance-analysis-${from}-to-${to}.csv"`,
        "cache-control": "no-store",
      },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to export variance analysis" }, { status: 400 })
  }
}
