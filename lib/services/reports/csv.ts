export type CsvColumn<T> = {
  key: keyof T
  header: string
  format?: (value: T[keyof T], row: T) => string | number | null | undefined
}

function escapeCsvCell(value: unknown): string {
  if (value == null) return ""
  const raw = String(value)
  if (raw.includes('"') || raw.includes(",") || raw.includes("\n") || raw.includes("\r")) {
    return `"${raw.replaceAll('"', '""')}"`
  }
  return raw
}

export function toCsv<T extends Record<string, any>>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => escapeCsvCell(c.header)).join(",")
  const dataLines = rows.map((row) => {
    return columns
      .map((c) => {
        const value = c.format ? c.format(row[c.key], row) : row[c.key]
        return escapeCsvCell(value)
      })
      .join(",")
  })

  return [headerLine, ...dataLines].join("\n")
}

