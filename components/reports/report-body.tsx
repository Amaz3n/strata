import Link from "next/link"

import { formatCell, isNumericColumn, unwrapCell, visibleColumns } from "@/lib/reports/format"
import type { ReportCell, ReportColumn, ReportResult, ReportRow, ReportTable, ReportTone } from "@/lib/reports/types"
import { cn } from "@/lib/utils"
import { AlertTriangle, Info } from "@/components/icons"

/**
 * The one renderer every report shares. Because it reads the same `ReportResult`
 * the CSV and PDF read, the screen can never disagree with the export.
 */

const TONE_CLASSES: Record<ReportTone, string> = {
  positive: "text-success",
  negative: "text-destructive",
  warning: "text-warning",
  muted: "text-muted-foreground",
}

function toneClass(tone?: ReportTone) {
  return tone ? TONE_CLASSES[tone] : undefined
}

function StatStrip({ stats }: { stats: NonNullable<ReportResult["stats"]> }) {
  return (
    <div className="grid border-t border-l sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {stats.map((stat) => (
        <div key={stat.key} className="border-b border-r px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{stat.label}</p>
          <p className={cn("mt-1 text-xl font-semibold tabular-nums", toneClass(stat.tone))}>{stat.value}</p>
          {stat.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{stat.detail}</p> : null}
        </div>
      ))}
    </div>
  )
}

function Cell({ cell, column }: { cell: ReportCell | undefined; column: ReportColumn }) {
  const unwrapped = unwrapCell(cell ?? null)
  const text = formatCell(cell ?? null, column.type)
  const className = cn(
    "px-3 py-2 align-top",
    isNumericColumn(column) && "text-right tabular-nums",
    toneClass(unwrapped.tone),
  )

  if (unwrapped.href) {
    return (
      <td className={className}>
        <Link href={unwrapped.href} className="underline-offset-4 hover:underline">
          {text}
        </Link>
      </td>
    )
  }
  return <td className={className}>{text}</td>
}

function Row({ row, columns }: { row: ReportRow; columns: ReportColumn[] }) {
  if (row.emphasis === "group") {
    return (
      <tr className="border-b bg-muted/40">
        <td
          colSpan={columns.length}
          className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {formatCell(row.cells[columns[0].key] ?? null, "text")}
        </td>
      </tr>
    )
  }

  const emphasised = row.emphasis === "subtotal" || row.emphasis === "total"
  const content = columns.map((column) => <Cell key={column.key} cell={row.cells[column.key]} column={column} />)

  return (
    <tr
      className={cn(
        "border-b",
        emphasised && "font-semibold",
        row.emphasis === "total" && "border-t-2 border-t-foreground/20",
        !emphasised && row.href && "hover:bg-muted/40",
        toneClass(row.tone),
      )}
    >
      {row.href && !emphasised ? (
        <>
          <td className="p-0">
            <Link href={row.href} className="block px-3 py-2 font-medium underline-offset-4 hover:underline">
              {formatCell(row.cells[columns[0].key] ?? null, columns[0].type)}
            </Link>
          </td>
          {content.slice(1)}
        </>
      ) : (
        content
      )}
    </tr>
  )
}

function TableBlock({ table }: { table: ReportTable }) {
  const columns = visibleColumns(table.columns)

  return (
    <section className="space-y-2">
      {table.title ? (
        <div>
          <h2 className="text-sm font-semibold">{table.title}</h2>
          {table.description ? <p className="text-xs text-muted-foreground">{table.description}</p> : null}
        </div>
      ) : null}

      <div className="overflow-x-auto border">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    "px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                    isNumericColumn(column) && "text-right",
                    column.className,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-12 text-center text-sm text-muted-foreground">
                  {table.emptyMessage ?? "No rows for this report."}
                </td>
              </tr>
            ) : (
              table.rows.map((row) => <Row key={row.key} row={row} columns={columns} />)
            )}
          </tbody>
          {table.totals && table.rows.length > 0 ? (
            <tfoot>
              <tr className="border-t-2 border-t-foreground/20 bg-muted/30 font-semibold">
                {columns.map((column) => (
                  <Cell key={column.key} cell={table.totals?.[column.key]} column={column} />
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {table.cap ? (
        <p className="text-xs text-muted-foreground">
          Showing {table.cap.shown.toLocaleString()} of {table.cap.total.toLocaleString()} rows. Export to get the
          full set.
        </p>
      ) : null}
    </section>
  )
}

export function ReportBody({ result }: { result: ReportResult }) {
  return (
    <div className="space-y-5">
      {result.notice ? (
        <div
          className={cn(
            "flex items-start gap-2 border px-3 py-2 text-sm",
            result.notice.tone === "warning"
              ? "border-warning/40 bg-warning/10 text-warning"
              : "border-border bg-muted/40 text-muted-foreground",
          )}
        >
          {result.notice.tone === "warning" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0" />
          )}
          <p>{result.notice.message}</p>
        </div>
      ) : null}

      {result.stats && result.stats.length > 0 ? <StatStrip stats={result.stats} /> : null}

      {result.tables.map((table) => (
        <TableBlock key={table.key} table={table} />
      ))}
    </div>
  )
}
