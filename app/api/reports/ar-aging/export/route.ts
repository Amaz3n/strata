import { NextRequest, NextResponse } from "next/server"

import { renderArAgingPdf } from "@/lib/pdfs/ar-aging"
import { getOrgBilling } from "@/lib/services/orgs"
import type { AgingBucket } from "@/lib/services/reports/aging"
import { getArAgingReport, type ARAgingReport } from "@/lib/services/reports/ar-aging"

export const runtime = "nodejs"

const BUCKET_LABELS: Record<Exclude<AgingBucket, "paid">, string> = {
  current: "Current",
  "1_30": "1–30 days",
  "31_60": "31–60 days",
  "61_90": "61–90 days",
  "90_plus": "90+ days",
  no_due_date: "No due date",
}

function escapeCell(value: unknown): string {
  if (value == null) return ""
  const raw = String(value)
  return /[",\n\r]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw
}

function dollars(cents: number) {
  return (cents / 100).toFixed(2)
}

function buildCsv(report: ARAgingReport): string {
  const rows: (string | number)[][] = []
  rows.push(["Invoice", "Customer", "Project", "Bucket", "Due date", "Days past due", "Open balance"])

  const openRows = report.rows.filter((row) => row.bucket !== "paid" && row.open_balance_cents > 0)
  for (const row of openRows) {
    rows.push([
      row.invoice_number ?? row.title ?? "",
      row.customer_name ?? "",
      row.project_name ?? "",
      BUCKET_LABELS[row.bucket as Exclude<AgingBucket, "paid">] ?? row.bucket,
      row.due_date ?? "",
      row.days_past_due,
      dollars(row.open_balance_cents),
    ])
  }

  rows.push([])
  rows.push(["Bucket totals"])
  for (const key of ["current", "1_30", "31_60", "61_90", "90_plus", "no_due_date"] as const) {
    if (key === "no_due_date" && report.totals[key] === 0) continue
    rows.push([BUCKET_LABELS[key], "", "", "", "", "", dollars(report.totals[key])])
  }
  rows.push(["Total open", "", "", "", "", "", dollars(report.totals.total_open_cents)])

  return rows.map((cols) => cols.map(escapeCell).join(",")).join("\n")
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  const format = sp.get("format") === "pdf" ? "pdf" : "csv"
  const projectId = sp.get("projectId")?.trim() || undefined
  const asOf = sp.get("asOf")?.trim() || undefined

  try {
    const report = await getArAgingReport({ projectId, asOf })
    const projectName = projectId
      ? report.rows.find((row) => row.project_id === projectId)?.project_name ?? null
      : null
    const stamp = report.as_of.slice(0, 10)
    const fileBase = `ar-aging-${stamp}`

    if (format === "pdf") {
      const billing = await getOrgBilling().catch(() => null)
      const branding = {
        org_name: (billing?.org?.name as string | undefined) ?? null,
        org_logo_url: (billing?.org?.logo_url as string | undefined) ?? null,
      }
      const pdf = await renderArAgingPdf({ report, branding, projectName })
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${fileBase}.pdf"`,
          "Cache-Control": "no-store",
        },
      })
    }

    const csv = buildCsv(report)
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileBase}.csv"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to build AR aging export." }, { status: 400 })
  }
}
