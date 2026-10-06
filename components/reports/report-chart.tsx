"use client";
import { unwrapCell, formatCell } from "@/lib/reports/format";
import type { ReportTable } from "@/lib/reports/types";
export function ReportChart({ table }: { table: ReportTable }) {
  const label = table.columns.find(
    (c) => !["money", "number", "percent"].includes(c.type ?? "text"),
  );
  const measure = table.columns.find((c) =>
    ["money", "number", "percent"].includes(c.type ?? ""),
  );
  if (!label || !measure) return null;
  const rows = table.rows.filter((r) => !r.emphasis).slice(0, 15);
  const max = Math.max(
    1,
    ...rows.map((r) =>
      Math.abs(Number(unwrapCell(r.cells[measure.key]).value) || 0),
    ),
  );
  return (
    <figure className="space-y-3 rounded-lg border p-5">
      <figcaption className="text-xs font-medium">
        {measure.header} · first {rows.length} rows
      </figcaption>
      {rows.map((row) => {
        const value = Number(unwrapCell(row.cells[measure.key]).value) || 0;
        return (
          <div
            key={row.key}
            className="grid grid-cols-[minmax(80px,1fr)_3fr_auto] items-center gap-3 text-xs"
          >
            <span className="truncate">{formatCell(row.cells[label.key])}</span>
            <div className="h-4 bg-muted/30">
              <div
                className={
                  value < 0 ? "h-4 bg-destructive/60" : "h-4 bg-foreground/60"
                }
                style={{ width: `${(Math.abs(value) / max) * 100}%` }}
              />
            </div>
            <span className="font-mono tabular-nums">
              {formatCell(row.cells[measure.key], measure.type)}
            </span>
          </div>
        );
      })}
      <p className="text-[10px] text-muted-foreground">
        PDF includes this chart. CSV includes the underlying table.
      </p>
    </figure>
  );
}
