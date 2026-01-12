import { NextRequest, NextResponse } from "next/server"

import { getChangeOrderLogReport, type ChangeOrderLogRow } from "@/lib/services/reports/change-order-log"
import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const format = request.nextUrl.searchParams.get("format") ?? "json"

  try {
    const report = await getChangeOrderLogReport({ projectId })

    if (format === "csv") {
      const columns: CsvColumn<ChangeOrderLogRow>[] = [
        { key: "change_order_id", header: "change_order_id" },
        { key: "project_id", header: "project_id" },
        { key: "project_name", header: "project_name" },
        { key: "title", header: "title" },
        { key: "status", header: "status" },
        { key: "total_cents", header: "total_cents" },
        { key: "approved_at", header: "approved_at" },
        { key: "days_impact", header: "days_impact" },
        { key: "created_at", header: "created_at" },
      ]

      const csv = toCsv(report.rows, columns)
      const filename = `change-order-log-${projectId}-${report.as_of}.csv`
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
      { as_of: null, project_id: projectId, rows: [], totals: null, error: error?.message ?? "Failed to build report" },
      { status: 200 },
    )
  }
}

