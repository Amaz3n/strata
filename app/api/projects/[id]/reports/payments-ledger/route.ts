import { NextRequest, NextResponse } from "next/server"

import { getPaymentsLedgerReport, type PaymentsLedgerKind, type PaymentsLedgerRow } from "@/lib/services/reports/payments-ledger"
import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const format = request.nextUrl.searchParams.get("format") ?? "json"
  const kindParam = request.nextUrl.searchParams.get("kind") ?? "ar"
  const kind: PaymentsLedgerKind = kindParam === "ap" ? "ap" : "ar"

  try {
    const report = await getPaymentsLedgerReport({ projectId, kind })

    if (format === "csv") {
      const columns: CsvColumn<PaymentsLedgerRow>[] = [
        { key: "payment_id", header: "payment_id" },
        { key: "kind", header: "kind" },
        { key: "project_id", header: "project_id" },
        { key: "project_name", header: "project_name" },
        { key: "invoice_id", header: "invoice_id" },
        { key: "invoice_number", header: "invoice_number" },
        { key: "bill_id", header: "bill_id" },
        { key: "bill_number", header: "bill_number" },
        { key: "amount_cents", header: "amount_cents" },
        { key: "currency", header: "currency" },
        { key: "status", header: "status" },
        { key: "received_at", header: "received_at" },
        { key: "method", header: "method" },
        { key: "reference", header: "reference" },
        { key: "provider", header: "provider" },
        { key: "provider_payment_id", header: "provider_payment_id" },
      ]

      const csv = toCsv(report.rows, columns)
      const filename = `payments-ledger-${kind}-${projectId}-${report.as_of}.csv`
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
      { as_of: null, project_id: projectId, kind, rows: [], error: error?.message ?? "Failed to build report" },
      { status: 200 },
    )
  }
}
