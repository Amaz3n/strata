import { NextRequest, NextResponse } from "next/server"

import { getDrawStatusReport, type DrawStatusRow } from "@/lib/services/reports/draw-status"
import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const format = request.nextUrl.searchParams.get("format") ?? "json"

  try {
    const report = await getDrawStatusReport({ projectId })

    if (format === "csv") {
      const columns: CsvColumn<DrawStatusRow>[] = [
        { key: "draw_id", header: "draw_id" },
        { key: "project_id", header: "project_id" },
        { key: "project_name", header: "project_name" },
        { key: "draw_number", header: "draw_number" },
        { key: "title", header: "title" },
        { key: "status", header: "status" },
        { key: "due_date", header: "due_date" },
        { key: "amount_cents", header: "amount_cents" },
        { key: "invoice_id", header: "invoice_id" },
        { key: "invoice_number", header: "invoice_number" },
        { key: "invoiced_at", header: "invoiced_at" },
        { key: "paid_at", header: "paid_at" },
      ]

      const csv = toCsv(report.rows, columns)
      const filename = `draw-status-${projectId}-${report.as_of}.csv`
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
      { as_of: null, project_id: projectId, rows: [], error: error?.message ?? "Failed to build report" },
      { status: 200 },
    )
  }
}

