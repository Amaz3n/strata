import { NextRequest, NextResponse } from "next/server"

import {
  getOrgWipOverUnderReport,
  type WipOverUnderRow,
} from "@/lib/services/reports/wip-over-under"
import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"

const columns: CsvColumn<WipOverUnderRow>[] = [
  { key: "project_id", header: "project_id" },
  { key: "project_name", header: "project_name" },
  { key: "project_status", header: "project_status" },
  { key: "billing_model", header: "billing_model" },
  { key: "original_contract_cents", header: "original_contract_cents" },
  { key: "approved_change_orders_cents", header: "approved_change_orders_cents" },
  { key: "revised_contract_cents", header: "revised_contract_cents" },
  { key: "actual_cost_cents", header: "actual_cost_cents" },
  { key: "eac_cents", header: "eac_cents" },
  { key: "cost_to_complete_cents", header: "cost_to_complete_cents" },
  { key: "percent_complete", header: "percent_complete" },
  { key: "earned_revenue_cents", header: "earned_revenue_cents" },
  { key: "billed_to_date_cents", header: "billed_to_date_cents" },
  { key: "over_under_billing_cents", header: "over_under_billing_cents" },
  { key: "over_billed_cents", header: "over_billed_cents" },
  { key: "under_billed_cents", header: "under_billed_cents" },
  { key: "forecast_gross_profit_cents", header: "forecast_gross_profit_cents" },
  { key: "forecast_gross_margin_percent", header: "forecast_gross_margin_percent" },
  { key: "balance_status", header: "balance_status" },
  { key: "issues", header: "issues", format: (value) => (Array.isArray(value) ? value.join("; ") : "") },
]

export async function GET(request: NextRequest) {
  const format = request.nextUrl.searchParams.get("format") ?? "json"
  const includeInactive = request.nextUrl.searchParams.get("includeInactive") === "1"
  const asOf = request.nextUrl.searchParams.get("asOf")?.trim() || undefined

  try {
    const report = await getOrgWipOverUnderReport({ asOf, includeInactive })

    if (format === "csv") {
      const csv = toCsv(report.rows, columns)
      const filename = `wip-over-under-${report.as_of}.csv`
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
    return NextResponse.json({ error: error?.message ?? "Failed to build WIP report" }, { status: 400 })
  }
}
