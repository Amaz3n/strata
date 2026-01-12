import { NextRequest, NextResponse } from "next/server"

import { getApAgingReport, type APAgingRow } from "@/lib/services/reports/ap-aging"
import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const format = request.nextUrl.searchParams.get("format") ?? "json"

  try {
    const report = await getApAgingReport({ projectId })

    if (format === "csv") {
      const columns: CsvColumn<APAgingRow>[] = [
        { key: "bill_id", header: "bill_id" },
        { key: "project_id", header: "project_id" },
        { key: "project_name", header: "project_name" },
        { key: "bill_number", header: "bill_number" },
        { key: "status", header: "status" },
        { key: "bill_date", header: "bill_date" },
        { key: "due_date", header: "due_date" },
        { key: "commitment_id", header: "commitment_id" },
        { key: "commitment_title", header: "commitment_title" },
        { key: "total_cents", header: "total_cents" },
        { key: "open_balance_cents", header: "open_balance_cents" },
        { key: "days_past_due", header: "days_past_due" },
        { key: "bucket", header: "bucket" },
      ]

      const csv = toCsv(report.rows, columns)
      const filename = `ap-aging-${projectId}-${report.as_of}.csv`
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

