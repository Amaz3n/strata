import { NextRequest, NextResponse } from "next/server"

import { getForecastReport, type ForecastRow } from "@/lib/services/reports/forecast-ctc"
import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const format = request.nextUrl.searchParams.get("format") ?? "json"

  try {
    const report = await getForecastReport({ projectId })

    if (format === "csv") {
      const columns: CsvColumn<ForecastRow>[] = [
        { key: "cost_code_id", header: "cost_code_id" },
        { key: "cost_code_code", header: "cost_code_code" },
        { key: "cost_code_name", header: "cost_code_name" },
        { key: "budget_cents", header: "budget_cents" },
        { key: "co_adjustment_cents", header: "co_adjustment_cents" },
        { key: "adjusted_budget_cents", header: "adjusted_budget_cents" },
        { key: "committed_cents", header: "committed_cents" },
        { key: "actual_cents", header: "actual_cents" },
        { key: "projected_committed_or_actual_cents", header: "projected_committed_or_actual_cents" },
        { key: "estimate_remaining_cents", header: "estimate_remaining_cents" },
        { key: "projected_final_cents", header: "projected_final_cents" },
        { key: "variance_at_completion_cents", header: "variance_at_completion_cents" },
      ]

      const csv = toCsv(report.rows, columns)
      const filename = `forecast-${projectId}-${report.as_of}.csv`
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      })
    }

    return NextResponse.json(report)
  } catch (error: any) {
    return NextResponse.json(
      { as_of: null, project_id: projectId, budget_id: null, budget_version: null, rows: [], error: error?.message ?? "Failed to build report" },
      { status: 200 },
    )
  }
}

