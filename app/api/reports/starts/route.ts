import { NextResponse } from "next/server"

import { getCycleTimeReport, getEvenFlowAdherence, getLateTaskHeatmap, getWipCounts } from "@/lib/services/even-flow"

export const runtime = "nodejs"

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csv(rows: object[]) {
  if (!rows.length) return ""
  const headers = Object.keys(rows[0])
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(Reflect.get(row, header))).join(","))].join("\n")
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const kind = params.get("kind") ?? "wip"
  const today = new Date()
  const fromDate = new Date(today)
  fromDate.setUTCDate(fromDate.getUTCDate() - 84)
  const from = params.get("from") ?? fromDate.toISOString().slice(0, 10)
  const to = params.get("to") ?? today.toISOString().slice(0, 10)
  let rows: object[]
  if (kind === "cycle-time") rows = await getCycleTimeReport({ groupBy: "community", from, to })
  else if (kind === "even-flow") rows = await getEvenFlowAdherence({ from, to })
  else if (kind === "late-tasks") rows = await getLateTaskHeatmap()
  else if (kind === "wip") rows = await getWipCounts()
  else return NextResponse.json({ error: "Unknown starts report" }, { status: 400 })
  return new NextResponse(csv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="starts-${kind}-${to}.csv"`,
    },
  })
}
