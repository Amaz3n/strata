import { exportCell } from "@/lib/reports/format"
import type { ReportResult, ReportTable } from "@/lib/reports/types"

/**
 * Serialises a rendered result, not a re-query — the file and the screen come
 * from the same object, so they cannot drift. Money exports as raw cents and
 * dates as ISO, because a spreadsheet should not have to parse "$1,234".
 */

function escapeCell(value: string | number | null): string {
  if (value === null || value === undefined) return ""
  const raw = String(value)
  if (raw.includes('"') || raw.includes(",") || raw.includes("\n") || raw.includes("\r")) {
    return `"${raw.replaceAll('"', '""')}"`
  }
  return raw
}

function tableToCsv(table: ReportTable): string[] {
  const lines: string[] = []
  if (table.title) lines.push(escapeCell(table.title))
  lines.push(table.columns.map((column) => escapeCell(column.header)).join(","))

  for (const row of table.rows) {
    lines.push(
      table.columns
        .map((column) => escapeCell(exportCell(row.cells[column.key] ?? null, column.type)))
        .join(","),
    )
  }

  if (table.totals) {
    lines.push(
      table.columns
        .map((column) => escapeCell(exportCell(table.totals?.[column.key] ?? null, column.type)))
        .join(","),
    )
  }

  return lines
}

export function reportToCsv(result: ReportResult): string {
  const sections: string[] = []

  if (result.stats?.length) {
    sections.push([...result.stats.map((stat) => escapeCell(stat.label))].join(","))
    sections.push([...result.stats.map((stat) => escapeCell(stat.value))].join(","))
    sections.push("")
  }

  result.tables.forEach((table, index) => {
    if (index > 0) sections.push("")
    sections.push(...tableToCsv(table))
  })

  return sections.join("\n")
}

export function csvFilename(slug: string, subtitle?: string) {
  const stamp = (subtitle?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? new Date().toISOString().slice(0, 10)).replace(/-/g, "")
  return `${slug}-${stamp}.csv`
}
