import { NextRequest, NextResponse } from "next/server"

import {
  getProjectProfitabilityReport,
  type ProfitabilityBasis,
  type ProfitabilityGroupBy,
} from "@/lib/services/reports/project-profitability"
import { renderProjectProfitabilityPdf } from "@/lib/pdfs/project-profitability"

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "project"
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const sp = request.nextUrl.searchParams
  const format = sp.get("format") ?? "json"
  const basis = (sp.get("basis") === "cash" ? "cash" : "accrual") as ProfitabilityBasis
  const groupByParam = sp.get("groupBy")
  const groupBy = groupByParam === "account" || groupByParam === "category" ? (groupByParam as ProfitabilityGroupBy) : undefined
  const from = sp.get("from")
  const to = sp.get("to")

  try {
    const report = await getProjectProfitabilityReport({ projectId, basis, from, to, groupBy })
    const slug = slugify(report.project_name)
    const stamp = report.generated_at.slice(0, 10)

    if (format === "pdf") {
      const pdf = await renderProjectProfitabilityPdf(report)
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="profitability-${slug}-${stamp}.pdf"`,
          "Cache-Control": "no-store",
        },
      })
    }

    if (format === "csv") {
      const csv = buildCsv(report)
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="profitability-${slug}-${stamp}.csv"`,
          "Cache-Control": "no-store",
        },
      })
    }

    return NextResponse.json(report)
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to build report" }, { status: 400 })
  }
}

function escapeCell(value: unknown): string {
  if (value == null) return ""
  const raw = String(value)
  return /[",\n\r]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw
}

function dollars(cents: number) {
  return (cents / 100).toFixed(2)
}

function buildCsv(report: Awaited<ReturnType<typeof getProjectProfitabilityReport>>): string {
  const rows: (string | number)[][] = []
  rows.push(["Section", "Line", "Budget", "Variance", "Amount", "% of income"])

  for (const line of report.income.lines) {
    rows.push(["Income", line.label, "", "", dollars(line.amount_cents), (line.pct_of_income * 100).toFixed(1)])
  }
  rows.push(["Income", "Total income", "", "", dollars(report.income.total_cents), "100.0"])

  for (const line of report.cost_of_work.lines) {
    rows.push([
      "Cost of work",
      line.label,
      line.budget_cents != null ? dollars(line.budget_cents) : "",
      line.variance_cents != null ? dollars(line.variance_cents) : "",
      dollars(line.amount_cents),
      (line.pct_of_income * 100).toFixed(1),
    ])
  }
  rows.push([
    "Cost of work",
    "Total cost of work",
    report.cost_of_work.budget_total_cents != null ? dollars(report.cost_of_work.budget_total_cents) : "",
    report.cost_of_work.variance_total_cents != null ? dollars(report.cost_of_work.variance_total_cents) : "",
    dollars(report.cost_of_work.total_cents),
    "",
  ])

  rows.push(["Result", "Gross profit", "", "", dollars(report.gross_profit_cents), report.gross_margin_percent.toFixed(1)])
  rows.push(["Result", "Net profit", "", "", dollars(report.net_profit_cents), report.net_margin_percent.toFixed(1)])

  return rows.map((cols) => cols.map(escapeCell).join(",")).join("\n")
}
