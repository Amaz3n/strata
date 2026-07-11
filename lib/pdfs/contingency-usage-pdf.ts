import {
  createDocumentKit,
  drawKeyValueGrid,
  drawSectionTitle,
  drawTable,
  saveDocumentKit,
  type DocumentHeader,
} from "@/lib/pdfs/document-kit"
import type { ContingencyUsageReport } from "@/lib/services/reports/contingency-usage"

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })

export async function renderContingencyUsagePdf(data: {
  header: DocumentHeader
  report: ContingencyUsageReport
}): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)

  for (const summary of data.report.summaries) {
    drawSectionTitle(kit, summary.cost_code ? `${summary.cost_code} · ${summary.line_name}` : summary.line_name)
    drawKeyValueGrid(kit, [
      { label: "Starting amount", value: money(summary.starting_amount_cents) },
      { label: "Transfers in", value: money(summary.transfers_in_cents) },
      { label: "Draws", value: money(summary.draws_cents) },
      { label: "Remaining", value: money(summary.remaining_cents) },
      { label: "Drawn", value: summary.drawn_percent == null ? "—" : `${summary.drawn_percent.toFixed(2)}%` },
      { label: "Actual costs", value: money(summary.actual_cents) },
      { label: "Draws less actuals", value: money(summary.draw_vs_actual_cents) },
    ])
  }

  drawSectionTitle(kit, "Contingency transfer and draw log")
  drawTable(kit, [
    { label: "Date", width: 60, value: (row) => new Date(row.date).toLocaleDateString() },
    { label: "#", width: 28, value: (row) => row.transfer_number },
    { label: "Reason", width: 155, value: (row) => row.reason },
    { label: "Other budget line(s)", width: 120, value: (row) => row.counterparty_lines },
    { label: "Movement", width: 78, value: (row) => money(row.amount_cents), align: "right" },
    { label: "Remaining", width: 79, value: (row) => money(row.remaining_after_cents), align: "right" },
  ], data.report.entries)

  return saveDocumentKit(kit)
}
