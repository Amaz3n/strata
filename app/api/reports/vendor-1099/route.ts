import { NextRequest, NextResponse } from "next/server"

import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"
import { getVendor1099Report, type Vendor1099Row } from "@/lib/services/reports/vendor-1099"

const columns: CsvColumn<Vendor1099Row>[] = [
  { key: "company_id", header: "company_id" },
  { key: "vendor_name", header: "vendor" },
  { key: "tax_id_last4", header: "tin_last4" },
  { key: "tax_entity_type", header: "entity_type" },
  { key: "w9_on_file", header: "w9_on_file" },
  { key: "total_paid_cents", header: "total_paid_cents" },
  { key: "meets_threshold", header: "meets_600_threshold" },
]

export async function GET(request: NextRequest) {
  try {
    const yearValue = request.nextUrl.searchParams.get("year")
    const year = yearValue ? Number(yearValue) : undefined
    const report = await getVendor1099Report({ year })
    if (request.nextUrl.searchParams.get("format") === "csv") {
      return new NextResponse(toCsv(report.rows, columns), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="vendor-1099-${report.tax_year}.csv"`, "Cache-Control": "no-store" } })
    }
    return NextResponse.json(report)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to build 1099 report" }, { status: 400 })
  }
}
