import type { ReportCell, ReportColumn, ReportColumnType, ReportTone } from "@/lib/reports/types"

/**
 * One formatter for the screen, the CSV, and the PDF. Every surface reads cells
 * through here so an exported number can never disagree with the rendered one.
 */

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

const MONEY_SIGNED = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
  signDisplay: "always",
})

const NUMBER = new Intl.NumberFormat("en-US")

export function formatMoneyCents(cents: number | null | undefined, opts?: { signed?: boolean }) {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—"
  return (opts?.signed ? MONEY_SIGNED : MONEY).format(cents / 100)
}

export function formatPercent(value: number | null | undefined, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return `${value.toFixed(digits)}%`
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "—"
  const parsed = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

export function unwrapCell(cell: ReportCell | undefined): {
  value: string | number | null
  label?: string
  href?: string
  tone?: ReportTone
} {
  if (cell !== null && cell !== undefined && typeof cell === "object") return cell
  return { value: cell ?? null }
}

/** Display string for a cell — what the user reads on screen and in the PDF. */
export function formatCell(cell: ReportCell | undefined, type: ReportColumnType = "text"): string {
  const { value, label } = unwrapCell(cell)
  if (label !== undefined) return label
  if (value === null || value === undefined || value === "") return "—"

  switch (type) {
    case "money":
      return typeof value === "number" ? formatMoneyCents(value) : String(value)
    case "percent":
      return typeof value === "number" ? formatPercent(value) : String(value)
    case "number":
      return typeof value === "number" ? NUMBER.format(value) : String(value)
    case "date":
      return formatDate(String(value))
    default:
      return String(value)
  }
}

/**
 * Export string for a cell. Money exports as raw cents and dates as ISO so the
 * file stays machine-readable — a spreadsheet should not have to parse "$1,234".
 */
export function exportCell(cell: ReportCell | undefined, type: ReportColumnType = "text"): string | number | null {
  const { value, label } = unwrapCell(cell)
  if (value === null || value === undefined) return label ?? null
  if (type === "money" || type === "number" || type === "percent") {
    return typeof value === "number" ? value : String(value)
  }
  if (type === "status" && label) return label
  return typeof value === "number" ? value : String(value)
}

export function isNumericColumn(column: ReportColumn) {
  return column.type === "money" || column.type === "number" || column.type === "percent"
}

/** Screen columns only — `exportOnly` columns exist for the file, not the table. */
export function visibleColumns(columns: ReportColumn[]) {
  return columns.filter((column) => !column.exportOnly)
}
