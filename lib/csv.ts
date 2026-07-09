import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"

export type { CsvColumn }

/** Browser-side CSV download built on the shared report CSV serializer. */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns: CsvColumn<T>[],
) {
  const csv = toCsv(rows, columns)
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
