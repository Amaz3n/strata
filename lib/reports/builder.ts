import { sortReportRows } from "./sort";
import { z } from "zod";
import { unwrapCell } from "./format";
import type { ReportCell, ReportResult, ReportRow, ReportTable } from "./types";

const calculation = z.object({
  key: z.string().regex(/^calc_[a-z0-9_]+$/),
  label: z.string().trim().min(1).max(80),
  left: z.string().max(100),
  right: z.string().max(100),
  operation: z.enum(["difference", "ratio", "sum"]),
});
export const tableLayoutSchema = z.object({
  title: z.string().max(120).default(""),
  note: z.string().max(2000).default(""),
  pageBreak: z.boolean().default(false),
  columns: z.array(z.string().max(100)).max(100).optional(),
  rowLabels: z.record(z.string().max(100), z.string().max(120)).default({}),
  accountGroups: z.record(z.string().max(100), z.string().max(80)).default({}),
  labels: z.record(z.string().max(100), z.string().max(80)).default({}),
  filters: z
    .array(
      z.object({
        column: z.string().max(100),
        operator: z.enum(["contains", "equals", "not_equals", "gt", "lt"]),
        value: z.string().max(200),
      }),
    )
    .max(12)
    .default([]),
  filterColumn: z.string().max(100).default(""),
  filterValue: z.string().max(200).default(""),
  groupBy: z.string().max(100).default(""),
  subgroupBy: z.string().max(100).default(""),
  sortBy: z.string().max(100).default(""),
  descending: z.boolean().default(false),
  hideZero: z.boolean().default(false),
  calculations: z.array(calculation).max(8).default([]),
  chart: z.boolean().default(false),
});
export const layoutSchema = z.object({
  version: z.literal(1).default(1),
  tables: z.record(z.string().max(100), tableLayoutSchema).default({}),
  notes: z.string().max(10000).default(""),
});
export type ReportLayout = z.infer<typeof layoutSchema>;
export type TableLayout = z.infer<typeof tableLayoutSchema>;
export const emptyLayout = (): ReportLayout => layoutSchema.parse({});
export function parseLayout(raw?: string): ReportLayout {
  if (!raw) return emptyLayout();
  if (raw.length > 40000) throw new Error("Report configuration is too large.");
  return layoutSchema.parse(JSON.parse(raw));
}
const value = (cell: ReportCell | undefined) => unwrapCell(cell).value;
const numeric = (cell: ReportCell | undefined) =>
  typeof value(cell) === "number" ? (value(cell) as number) : null;
function calculate(
  cells: ReportRow["cells"],
  spec: z.infer<typeof calculation>,
) {
  const left = numeric(cells[spec.left]),
    right = numeric(cells[spec.right]);
  if (left === null || right === null) return null;
  return spec.operation === "difference"
    ? left - right
    : spec.operation === "sum"
      ? left + right
      : right === 0
        ? null
        : (left / right) * 100;
}

/** Preserve accounting structure. Aggregation is opt-in per measure, never inferred from display type. */
export function customizeReport(
  result: ReportResult,
  layout: ReportLayout,
): ReportResult {
  let narrowed = false;
  const tables = result.tables.map((source): ReportTable => {
    const config = layout.tables[source.key];
    if (!config) return source;
    const structured = source.locked || source.rows.some((row) => row.emphasis);
    let columns = [...source.columns];
    const validCalculations = config.calculations.filter((spec) => {
      const left = source.columns.find((c) => c.key === spec.left),
        right = source.columns.find((c) => c.key === spec.right);
      return (
        left &&
        right &&
        left.type === right.type &&
        ["money", "number"].includes(left.type ?? "") &&
        !source.columns.some((c) => c.key === spec.key)
      );
    });
    for (const spec of validCalculations)
      columns.push({
        key: spec.key,
        header: spec.label,
        type:
          spec.operation === "ratio"
            ? "percent"
            : source.columns.find((c) => c.key === spec.left)?.type,
      });
    let rows = source.rows.map((row) => ({ ...row, cells: { ...row.cells } }));
    const labelColumn = source.columns.find(
      (c) =>
        !c.exportOnly &&
        !["money", "number", "percent"].includes(c.type ?? "text"),
    );
    if (labelColumn)
      for (const row of rows)
        if (config.rowLabels[row.key])
          row.cells[labelColumn.key] = config.rowLabels[row.key];
    // Presentation groups sit inside the existing accounting categories; standard totals stay authoritative.
    if (
      labelColumn &&
      structured &&
      rows.some((r) => r.emphasis === "group") &&
      Object.values(config.accountGroups).some(Boolean)
    ) {
      const regrouped: ReportRow[] = [];
      let bucket: ReportRow[] = [];
      const flush = () => {
        const groups = new Map<string, ReportRow[]>();
        for (const row of bucket) {
          const key = config.accountGroups[row.key]?.trim() ?? "";
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        for (const [name, accounts] of groups) {
          if (name)
            regrouped.push({
              key: `custom-group:${accounts[0].key}`,
              emphasis: "group",
              cells: { [labelColumn.key]: name },
            });
          regrouped.push(...accounts);
          if (name) {
            const cells: ReportRow["cells"] = {
              [labelColumn.key]: `Total ${name}`,
            };
            for (const column of source.columns.filter(
              (c) => c.type === "money",
            ))
              cells[column.key] = accounts.reduce(
                (sum, row) => sum + (numeric(row.cells[column.key]) ?? 0),
                0,
              );
            if (source.columns.some((c) => c.key === "variancePercent"))
              cells.variancePercent = numeric(cells.prior)
                ? ((numeric(cells.variance) ?? 0) /
                    Math.abs(numeric(cells.prior)!)) *
                  100
                : null;
            regrouped.push({
              key: `custom-subtotal:${accounts[0].key}`,
              emphasis: "subtotal",
              cells,
            });
          }
        }
        bucket = [];
      };
      for (const row of rows) {
        if (row.emphasis) {
          flush();
          regrouped.push(row);
        } else bucket.push(row);
      }
      flush();
      rows = regrouped;
    }
    const filter = config.filterValue.toLocaleLowerCase();
    const appliedFilter =
      !structured &&
      Boolean(filter) &&
      source.columns.some((c) => c.key === config.filterColumn);
    if (appliedFilter) {
      rows = rows.filter((row) =>
        String(
          unwrapCell(row.cells[config.filterColumn]).label ??
            value(row.cells[config.filterColumn]) ??
            "",
        )
          .toLocaleLowerCase()
          .includes(filter),
      );
      narrowed = true;
    }
    const activeFilters = !structured
      ? config.filters.filter(
          (f) =>
            f.value !== "" && source.columns.some((c) => c.key === f.column),
        )
      : [];
    if (activeFilters.length) {
      rows = rows.filter((row) =>
        activeFilters.every((filter) => {
          const column = source.columns.find((c) => c.key === filter.column)!;
          const cell = unwrapCell(row.cells[filter.column]);
          const actual = String(
            cell.label ?? cell.value ?? "",
          ).toLocaleLowerCase();
          const expected = filter.value.toLocaleLowerCase();
          const amount =
            column.type === "money"
              ? Math.round(Number(filter.value) * 100)
              : Number(filter.value);
          if (filter.operator === "contains") return actual.includes(expected);
          if (["money", "number", "percent"].includes(column.type ?? "")) {
            if (typeof cell.value !== "number" || !Number.isFinite(amount))
              return false;
            if (filter.operator === "gt") return cell.value > amount;
            if (filter.operator === "lt") return cell.value < amount;
            return filter.operator === "equals"
              ? cell.value === amount
              : cell.value !== amount;
          }
          return filter.operator === "equals"
            ? actual === expected
            : filter.operator === "not_equals"
              ? actual !== expected
              : false;
        }),
      );
      narrowed = true;
    }
    if (config.hideZero) {
      const measures = source.columns.filter((c) =>
        structured
          ? c.type ===
            (source.columns.some((column) => column.type === "money")
              ? "money"
              : "number")
          : c.aggregation === "sum",
      );
      if (measures.length) {
        rows = rows.filter(
          (row) =>
            Boolean(row.emphasis) ||
            measures.some((c) => {
              const n = numeric(row.cells[c.key]);
              return n !== null && n !== 0;
            }),
        );
        if (!structured) narrowed = true;
      }
    }
    const group =
      !structured &&
      source.columns.some((c) => c.aggregation === "sum") &&
      source.columns.find(
        (c) =>
          c.key === config.groupBy &&
          !["money", "number", "percent"].includes(c.type ?? "text"),
      );
    if (group) {
      const subgroup = source.columns.find(
        (c) =>
          c.key === config.subgroupBy &&
          c.key !== group.key &&
          !["money", "number", "percent"].includes(c.type ?? "text"),
      );
      const groups = new Map<string, ReportRow>();
      for (const row of rows) {
        const primaryKey =
          unwrapCell(row.cells[group.key]).href ??
          String(value(row.cells[group.key]) ?? "Unassigned");
        const key = subgroup
          ? JSON.stringify([
              primaryKey,
              unwrapCell(row.cells[subgroup.key]).href ??
                value(row.cells[subgroup.key]),
            ])
          : primaryKey;
        const target = groups.get(key) ?? {
          key: `group:${key}`,
          cells: {
            [group.key]: row.cells[group.key] ?? "Unassigned",
            ...(subgroup
              ? { [subgroup.key]: row.cells[subgroup.key] ?? "Unassigned" }
              : {}),
          },
        };
        for (const column of source.columns.filter(
          (c) => c.aggregation === "sum",
        ))
          target.cells[column.key] =
            (numeric(target.cells[column.key]) ?? 0) +
            (numeric(row.cells[column.key]) ?? 0);
        groups.set(key, target);
      }
      rows = [...groups.values()];
      columns = columns.filter(
        (c) =>
          c.key === group.key ||
          c.key === subgroup?.key ||
          c.aggregation === "sum" ||
          validCalculations.some(
            (calc) =>
              calc.key === c.key &&
              source.columns.find((x) => x.key === calc.left)?.aggregation ===
                "sum" &&
              source.columns.find((x) => x.key === calc.right)?.aggregation ===
                "sum",
          ),
      );
    }
    for (const row of rows)
      for (const spec of validCalculations)
        if (!row.emphasis || row.emphasis !== "group")
          row.cells[spec.key] = calculate(row.cells, spec);
    if (config.sortBy)
      rows = sortReportRows(rows, config.sortBy, config.descending);
    let totals = source.totals ? { ...source.totals } : undefined;
    if (
      !structured &&
      (appliedFilter || activeFilters.length || config.hideZero || group)
    ) {
      totals = Object.fromEntries(
        Object.entries(source.totals ?? {}).filter(
          ([key]) =>
            !["money", "number", "percent"].includes(
              source.columns.find((c) => c.key === key)?.type ?? "text",
            ),
        ),
      );
      for (const column of source.columns.filter(
        (c) => c.aggregation === "sum",
      ))
        totals[column.key] = rows.reduce(
          (sum, row) => sum + (numeric(row.cells[column.key]) ?? 0),
          0,
        );
      if (!Object.keys(totals).length) totals = undefined;
    }
    if (totals)
      for (const spec of validCalculations)
        totals[spec.key] = calculate(totals, spec);
    if (config.columns?.length) {
      let ordered = [...new Set(config.columns)].flatMap(
        (key) => columns.find((c) => c.key === key) ?? [],
      );
      // Keep the statement label and at least one data column visible.
      const label = columns.find(
        (c) =>
          !c.exportOnly &&
          !["money", "number", "percent"].includes(c.type ?? "text"),
      );
      if (structured && label)
        ordered = [label, ...ordered.filter((c) => c.key !== label.key)];
      if (ordered.length >= 2) columns = ordered;
    }
    columns = columns.map((column) => ({
      ...column,
      header: config.labels[column.key] || column.header,
      exportOnly: config.columns?.includes(column.key)
        ? false
        : column.exportOnly,
    }));
    return {
      ...source,
      title: config.title || source.title,
      description:
        [
          source.description,
          config.note,
          activeFilters.length
            ? `Filtered: ${activeFilters.map((f) => `${source.columns.find((c) => c.key === f.column)?.header} ${({ contains: "contains", equals: "equals", not_equals: "does not equal", gt: "greater than", lt: "less than" } as const)[f.operator]} ${f.value}`).join("; ")}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
      chart: !structured && config.chart,
      pageBreak: config.pageBreak,
      columns,
      rows,
      totals,
    };
  });
  return {
    ...result,
    tables,
    stats: narrowed ? undefined : result.stats,
    commentary: layout.notes || result.commentary,
  };
}
