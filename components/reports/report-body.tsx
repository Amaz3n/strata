"use client";

import { Fragment, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from "lucide-react";
import { AccountActivitySheet } from "@/components/books/account-activity-sheet";
import type { ReportActivity } from "@/lib/reports/types";
import Link from "next/link";

import {
  formatCell,
  isNumericColumn,
  unwrapCell,
  visibleColumns,
} from "@/lib/reports/format";
import type {
  ReportCell,
  ReportColumn,
  ReportResult,
  ReportRow,
  ReportTable,
  ReportTone,
} from "@/lib/reports/types";
import { cn } from "@/lib/utils";
import { AlertTriangle, Info } from "@/components/icons";

/**
 * The one renderer every report shares. Because it reads the same `ReportResult`
 * the CSV and PDF read, the screen can never disagree with the export.
 */

const TONE_CLASSES: Record<ReportTone, string> = {
  positive: "text-success",
  negative: "text-destructive",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

function toneClass(tone?: ReportTone) {
  return tone ? TONE_CLASSES[tone] : undefined;
}

function Cell({
  cell,
  column,
  activity,
  onActivity,
}: {
  cell: ReportCell | undefined;
  column: ReportColumn;
  activity?: ReportActivity;
  onActivity?: (activity: ReportActivity) => void;
}) {
  const unwrapped = unwrapCell(cell ?? null);
  const text = formatCell(cell ?? null, column.type);
  const className = cn(
    "px-3 py-2 align-top whitespace-nowrap",
    isNumericColumn(column) && "text-right tabular-nums font-mono",
    toneClass(unwrapped.tone),
  );

  if (activity && onActivity)
    return (
      <td className={className}>
        <button
          className="underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2"
          onClick={() => onActivity(activity)}
          aria-label={`Inspect ${column.header}: ${text}`}
        >
          {text}
        </button>
      </td>
    );

  if (unwrapped.href) {
    return (
      <td className={className}>
        <Link
          href={unwrapped.href}
          className="underline-offset-4 hover:underline"
        >
          {text}
        </Link>
      </td>
    );
  }
  return <td className={className}>{text}</td>;
}

function Row({
  row,
  columns,
  onActivity,
}: {
  row: ReportRow;
  columns: ReportColumn[];
  onActivity?: (activity: ReportActivity) => void;
}) {
  const [expanded, setExpanded] = useState(false);
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
    );
  }

  const emphasised = row.emphasis === "subtotal" || row.emphasis === "total";
  const content = columns.map((column, index) =>
    index === 0 && row.children?.length ? (
      <td key={column.key} className="px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-2 text-left"
            aria-label={`Expand ${formatCell(row.cells[column.key], column.type)}`}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRight
              className={cn(
                "size-3 transition-transform",
                expanded && "rotate-90",
              )}
            />
          </button>
          {row.activity && onActivity ? (
            <button
              className="text-left hover:underline underline-offset-4"
              onClick={() => onActivity(row.activity!)}
            >
              {formatCell(row.cells[column.key], column.type)}
            </button>
          ) : (
            formatCell(row.cells[column.key], column.type)
          )}
        </div>
      </td>
    ) : (
      <Cell
        key={column.key}
        cell={row.cells[column.key]}
        column={column}
        activity={
          row.activities?.[column.key] ??
          (column.key === "prior" ||
          column.key.startsWith("variance") ||
          column.key.startsWith("calc_")
            ? undefined
            : row.activity)
        }
        onActivity={onActivity}
      />
    ),
  );

  return (
    <Fragment>
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
              <Link
                href={row.href}
                className="block px-3 py-2 font-medium underline-offset-4 hover:underline"
              >
                {formatCell(row.cells[columns[0].key] ?? null, columns[0].type)}
              </Link>
            </td>
            {content.slice(1)}
          </>
        ) : (
          content
        )}
      </tr>
      {expanded &&
        row.children?.map((child) => (
          <Row
            key={child.key}
            row={child}
            columns={columns}
            onActivity={onActivity}
          />
        ))}
    </Fragment>
  );
}

function TableBlock({
  table,
  onActivity,
  sorting,
  onSort,
}: {
  sorting?: { sortBy: string; descending: boolean };
  onSort?: (column: string) => void;
  table: ReportTable;
  onActivity?: (activity: ReportActivity) => void;
}) {
  const columns = visibleColumns(table.columns);

  return (
    <section aria-label={table.title || undefined} className="space-y-2">
      {table.title || table.description ? (
        <div>
          {table.title && (
            <h2 className="text-sm font-semibold">{table.title}</h2>
          )}
          {table.description ? (
            <p className="text-xs text-muted-foreground">{table.description}</p>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-auto rounded-lg border bg-background [&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:bg-muted [&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:bg-background [&_td:first-child]:min-w-52 [&_th:first-child]:min-w-52 [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              {columns.map((column) => (
                <th
                  key={column.key}
                  aria-sort={
                    sorting?.sortBy === column.key
                      ? sorting.descending
                        ? "descending"
                        : "ascending"
                      : "none"
                  }
                  className={cn(
                    "px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                    isNumericColumn(column) && "text-right",
                    column.className,
                  )}
                >
                  {onSort ? (
                    <button
                      className={cn(
                        "inline-flex w-full items-center gap-1.5 text-left hover:text-foreground",
                        isNumericColumn(column) && "justify-end",
                      )}
                      onClick={() => onSort(column.key)}
                      aria-label={`Sort by ${column.header}`}
                    >
                      {column.header}
                      {sorting?.sortBy === column.key ? (
                        sorting.descending ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ArrowUp className="size-3" />
                        )
                      ) : (
                        <ArrowUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-12 text-center text-sm text-muted-foreground"
                >
                  {table.emptyMessage ?? "No rows for this report."}
                </td>
              </tr>
            ) : (
              table.rows.map((row) => (
                <Row
                  key={row.key}
                  row={row}
                  columns={columns}
                  onActivity={onActivity}
                />
              ))
            )}
          </tbody>
          {table.totals && table.rows.length > 0 ? (
            <tfoot>
              <tr className="border-t-2 border-t-foreground/20 bg-muted/30 font-semibold">
                {columns.map((column) => (
                  <Cell
                    key={column.key}
                    cell={table.totals?.[column.key]}
                    column={column}
                  />
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {table.cap ? (
        <p className="text-xs text-muted-foreground">
          Showing {table.cap.shown.toLocaleString()} of{" "}
          {table.cap.total.toLocaleString()} rows. This result is partial;
          exports contain the same available rows.
        </p>
      ) : null}
    </section>
  );
}

export function ReportBody({
  result,
  drilldown = true,
  onActivity,
  sorting,
  onSort,
}: {
  sorting?: Record<string, { sortBy: string; descending: boolean }>;
  onSort?: (table: string, column: string) => void;
  result: ReportResult;
  drilldown?: boolean;
  onActivity?: (activity: ReportActivity) => void;
}) {
  const [activity, setActivity] = useState<ReportActivity | null>(null);
  return (
    <div className="space-y-5">
      {result.commentary && (
        <div className="whitespace-pre-wrap rounded-lg border-l-2 border-foreground/30 bg-muted/20 p-5 text-sm leading-6">
          {result.commentary}
        </div>
      )}
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

      {result.tables.map((table) => (
        <TableBlock
          key={table.key}
          table={table}
          sorting={sorting?.[table.key]}
          onSort={onSort ? (column) => onSort(table.key, column) : undefined}
          onActivity={drilldown ? (onActivity ?? setActivity) : undefined}
        />
      ))}
      {drilldown && !onActivity && (
        <AccountActivitySheet
          target={activity}
          startDate={activity?.startDate ?? "1900-01-01"}
          endDate={activity?.endDate ?? "1900-01-01"}
          onOpenChange={(open) => {
            if (!open) setActivity(null);
          }}
        />
      )}
    </div>
  );
}
