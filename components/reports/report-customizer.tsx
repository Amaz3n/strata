"use client";
import { ReportFilters } from "./report-filters";
import { ReportSelect, ReportOption } from "./report-select";
import { ArrowUp, ArrowDown, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  tableLayoutSchema,
  type ReportLayout,
  type TableLayout,
} from "@/lib/reports/builder";
import type { ReportResult } from "@/lib/reports/types";

export const controlClass =
  "h-9 w-full rounded-md border bg-background px-2 text-xs";
export function ReportCustomizer({
  result,
  layout,
  onChange,
  onClose,
  controls,
}: {
  onClose?: () => void;
  controls?: React.ReactNode;
  result: ReportResult;
  layout: ReportLayout;
  onChange: (layout: ReportLayout) => void;
}) {
  function patch(key: string, update: Partial<TableLayout>) {
    onChange({
      ...layout,
      tables: {
        ...layout.tables,
        [key]: {
          ...tableLayoutSchema.parse(layout.tables[key] ?? {}),
          ...update,
        },
      },
    });
  }
  return (
    <aside className="space-y-6 rounded-lg border bg-muted/10 p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-140px)] lg:overflow-y-auto">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Customize report</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Columns, filters, and layout.
          </p>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close customization"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      {controls}
      {result.tables.map((table) => {
        const config = tableLayoutSchema.parse(layout.tables[table.key] ?? {});
        const structured =
          table.locked || table.rows.some((row) => row.emphasis);
        const numeric = table.columns.filter((c) =>
          ["money", "number"].includes(c.type ?? ""),
        );
        const dimensions = table.columns.filter(
          (c) => !["money", "number", "percent"].includes(c.type ?? ""),
        );
        const available = [
          ...table.columns,
          ...config.calculations.map((c) => ({ key: c.key, header: c.label })),
        ];
        const order = config.columns ?? [
          ...table.columns.filter((c) => !c.exportOnly).map((c) => c.key),
          ...config.calculations.map((c) => c.key),
        ];
        const ordered = [
          ...order,
          ...available.filter((c) => !order.includes(c.key)).map((c) => c.key),
        ];
        return (
          <section key={table.key} className="space-y-4 border-t pt-4">
            <h3 className="text-xs font-semibold">
              {table.title ?? "Report table"}
            </h3>
            {result.tables.length > 1 && (
              <Field label="Section title">
                <Input
                  className="h-8 text-xs"
                  value={config.title || table.title || ""}
                  onChange={(e) => patch(table.key, { title: e.target.value })}
                />
              </Field>
            )}
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Columns & labels
              </p>
              <ReportSelect
                aria-label="Add report column"
                className="w-full text-xs"
                value=""
                onValueChange={(key) =>
                  patch(table.key, { columns: [...order, key] })
                }
              >
                <ReportOption value="">Add column…</ReportOption>
                {available
                  .filter((c) => !order.includes(c.key))
                  .map((c) => (
                    <ReportOption key={c.key} value={c.key}>
                      {c.header}
                    </ReportOption>
                  ))}
              </ReportSelect>
              {ordered
                .filter((key) => order.includes(key))
                .map((key, index) => {
                  const column = available.find((c) => c.key === key);
                  if (!column) return null;
                  return (
                    <div key={key} className="flex items-center gap-1.5">
                      <input
                        aria-label={`Show ${column.header}`}
                        type="checkbox"
                        checked={order.includes(key)}
                        disabled={
                          order.includes(key) &&
                          (order.length <= 2 ||
                            Boolean(
                              structured &&
                              key ===
                                dimensions.find((c) => !c.exportOnly)?.key,
                            ))
                        }
                        onChange={(e) =>
                          patch(table.key, {
                            columns: e.target.checked
                              ? [...order, key]
                              : order.filter((c) => c !== key),
                          })
                        }
                      />
                      <Input
                        aria-label={`Label for ${column.header}`}
                        value={config.labels[key] ?? column.header}
                        onChange={(e) =>
                          patch(table.key, {
                            labels: { ...config.labels, [key]: e.target.value },
                          })
                        }
                        className="h-8 min-w-0 text-xs"
                      />
                      {[-1, 1].map((delta) => (
                        <button
                          key={delta}
                          className="p-1 disabled:opacity-20"
                          aria-label={`Move ${column.header} ${delta < 0 ? "up" : "down"}`}
                          disabled={
                            !order.includes(key) ||
                            index + delta < 0 ||
                            index + delta >= order.length
                          }
                          onClick={() => {
                            const next = [...order];
                            [next[index], next[index + delta]] = [
                              next[index + delta],
                              next[index],
                            ];
                            patch(table.key, { columns: next });
                          }}
                        >
                          {delta < 0 ? (
                            <ArrowUp className="size-3" />
                          ) : (
                            <ArrowDown className="size-3" />
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })}
            </div>
            {structured ? (
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={config.hideZero}
                    onChange={(e) =>
                      patch(table.key, { hideZero: e.target.checked })
                    }
                  />
                  Hide zero accounts
                </label>
                <p className="text-xs leading-5 text-muted-foreground">
                  Statement rows and totals stay intact. Use the date,
                  comparison, and dimension controls to explore another view.
                  Click an account to filter its transactions.
                </p>
              </div>
            ) : (
              <>
                <Field label="Group rows">
                  <ReportSelect
                    className={controlClass}
                    value={config.groupBy}
                    onValueChange={(value) =>
                      patch(table.key, { groupBy: value })
                    }
                  >
                    <ReportOption value="">No grouping</ReportOption>
                    {table.columns.some((c) => c.aggregation === "sum") &&
                      dimensions.map((c) => (
                        <ReportOption key={c.key} value={c.key}>
                          {c.header}
                        </ReportOption>
                      ))}
                  </ReportSelect>
                </Field>
                {config.groupBy && (
                  <Field label="Then group by">
                    <ReportSelect
                      aria-label="Secondary grouping"
                      className={controlClass}
                      value={config.subgroupBy}
                      onValueChange={(value) =>
                        patch(table.key, { subgroupBy: value })
                      }
                    >
                      <ReportOption value="">
                        No secondary grouping
                      </ReportOption>
                      {dimensions
                        .filter((c) => c.key !== config.groupBy)
                        .map((c) => (
                          <ReportOption key={c.key} value={c.key}>
                            {c.header}
                          </ReportOption>
                        ))}
                    </ReportSelect>
                  </Field>
                )}
                {config.filterColumn && config.filterValue && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      patch(table.key, { filterColumn: "", filterValue: "" })
                    }
                  >
                    Clear saved text filter: {config.filterValue}
                  </Button>
                )}
                <ReportFilters
                  columns={table.columns}
                  filters={config.filters}
                  onChange={(filters) => patch(table.key, { filters })}
                />
                <Field label="Sort">
                  <ReportSelect
                    className={controlClass}
                    value={config.sortBy}
                    onValueChange={(value) =>
                      patch(table.key, { sortBy: value })
                    }
                  >
                    <ReportOption value="">Original order</ReportOption>
                    {available.map((c) => (
                      <ReportOption key={c.key} value={c.key}>
                        {c.header}
                      </ReportOption>
                    ))}
                  </ReportSelect>
                </Field>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={config.descending}
                    onChange={(e) =>
                      patch(table.key, { descending: e.target.checked })
                    }
                  />
                  Descending
                </label>
                {table.columns.some((c) => c.aggregation === "sum") && (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={config.hideZero}
                      onChange={(e) =>
                        patch(table.key, { hideZero: e.target.checked })
                      }
                    />
                    Hide zero balances
                  </label>
                )}
              </>
            )}
            {structured && (
              <details className="space-y-3">
                <summary className="cursor-pointer text-xs font-medium">
                  Account labels & groups
                </summary>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  Group accounts within their existing section. Standard totals
                  remain unchanged.
                </p>
                {table.rows
                  .filter((r) => !r.emphasis)
                  .map((row) => (
                    <div key={row.key} className="space-y-2 border-t pt-2">
                      <Input
                        aria-label={`Row label ${row.key}`}
                        value={
                          config.rowLabels[row.key] ??
                          String(row.cells[table.columns[0].key] ?? "")
                        }
                        onChange={(e) =>
                          patch(table.key, {
                            rowLabels: {
                              ...config.rowLabels,
                              [row.key]: e.target.value,
                            },
                          })
                        }
                        className="h-8 text-xs"
                      />
                      {table.rows.some((r) => r.emphasis === "group") && (
                        <Input
                          aria-label={`Presentation group ${row.key}`}
                          placeholder="Group name (optional)"
                          value={config.accountGroups[row.key] ?? ""}
                          onChange={(e) =>
                            patch(table.key, {
                              accountGroups: {
                                ...config.accountGroups,
                                [row.key]: e.target.value,
                              },
                            })
                          }
                          className="h-8 text-xs"
                        />
                      )}
                    </div>
                  ))}
              </details>
            )}
            {numeric.length >= 2 && (
              <div className="space-y-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Add calculated columns
                </p>
                {config.calculations.map((calc, i) => (
                  <div key={calc.key} className="space-y-2 rounded border p-2">
                    <div className="flex gap-1">
                      <Input
                        aria-label="Calculation label"
                        className="h-8 text-xs"
                        value={calc.label}
                        onChange={(e) =>
                          patch(table.key, {
                            calculations: config.calculations.map((c, j) =>
                              j === i
                                ? {
                                    ...c,
                                    label: e.target.value || "Calculation",
                                  }
                                : c,
                            ),
                          })
                        }
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Remove calculation"
                        onClick={() =>
                          patch(table.key, {
                            columns: config.columns?.filter(
                              (key) => key !== calc.key,
                            ),
                            calculations: config.calculations.filter(
                              (_, j) => i !== j,
                            ),
                          })
                        }
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                    {(["left", "operation", "right"] as const).map((field) => (
                      <ReportSelect
                        key={field}
                        aria-label={`Calculation ${field}`}
                        className={controlClass}
                        value={calc[field]}
                        onValueChange={(value) =>
                          patch(table.key, {
                            calculations: config.calculations.map((c, j) =>
                              j === i ? { ...c, [field]: value } : c,
                            ),
                          })
                        }
                      >
                        {field === "operation" ? (
                          <>
                            <ReportOption value="difference">
                              Minus
                            </ReportOption>
                            <ReportOption value="sum">Plus</ReportOption>
                            <ReportOption value="ratio">
                              Divided by (%)
                            </ReportOption>
                          </>
                        ) : (
                          numeric
                            .filter(
                              (c) =>
                                field === "left" ||
                                c.type ===
                                  numeric.find((n) => n.key === calc.left)
                                    ?.type,
                            )
                            .map((c) => (
                              <ReportOption key={c.key} value={c.key}>
                                {c.header}
                              </ReportOption>
                            ))
                        )}
                      </ReportSelect>
                    ))}
                  </div>
                ))}
                <Button
                  className="w-full"
                  size="sm"
                  variant="outline"
                  disabled={config.calculations.length >= 8}
                  onClick={() => {
                    const key = `calc_${Date.now()}`;
                    patch(table.key, {
                      columns: [...order, key],
                      calculations: [
                        ...config.calculations,
                        {
                          key,
                          label: "Custom measure",
                          left: numeric[0].key,
                          right:
                            numeric.find(
                              (c) =>
                                c.key !== numeric[0].key &&
                                c.type === numeric[0].type,
                            )?.key ?? numeric[0].key,
                          operation: "difference",
                        },
                      ],
                    });
                  }}
                >
                  <Plus className="size-3" />
                  Calculated column
                </Button>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  Ratios recalculate from aggregated measures. A zero
                  denominator displays a dash.
                </p>
              </div>
            )}
            {!structured && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={config.chart}
                  onChange={(e) =>
                    patch(table.key, { chart: e.target.checked })
                  }
                />
                Show comparison chart
              </label>
            )}
          </section>
        );
      })}
    </aside>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block space-y-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
