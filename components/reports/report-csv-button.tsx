"use client"

import { Download } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { downloadCsv } from "@/lib/csv"

export function ReportCsvButton({
  filename,
  rows,
}: {
  filename: string
  rows: Array<Record<string, string | number | null>>
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        const keys = Object.keys(rows[0] ?? {})
        downloadCsv(filename, rows, keys.map((key) => ({ key, header: key.replaceAll("_", " ") })))
      }}
      disabled={rows.length === 0}
    >
      <Download className="mr-2 h-4 w-4" />CSV
    </Button>
  )
}
