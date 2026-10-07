import type { ARAgingReport } from "@/lib/services/reports/ar-aging";
import type { ReportColumn, ReportResult, ReportRow } from "./types";
const buckets = [
  ["current", "Current"],
  ["1_30", "1–30 days"],
  ["31_60", "31–60 days"],
  ["61_90", "61–90 days"],
  ["90_plus", "90+ days"],
  ["no_due_date", "No due date"],
] as const;
export function arAgingSummary(
  report: ARAgingReport,
  by: "client" | "project" = "client",
): ReportResult {
  const columns: ReportColumn[] = [
    { key: "name", header: by === "client" ? "Client" : "Project" },
    ...buckets.map(([key, header]) => ({
      key,
      header,
      type: "money" as const,
      aggregation: "sum" as const,
    })),
    { key: "total", header: "Total", type: "money", aggregation: "sum" },
  ];
  const groups = new Map<string, ReportRow>();
  for (const invoice of report.rows.filter(
    (row) => row.open_balance_cents > 0,
  )) {
    const name =
      by === "project"
        ? (invoice.project_name ?? "Unassigned project")
        : (invoice.customer_name ?? "Unassigned client");
    const id =
      by === "project"
        ? (invoice.project_id ?? "unassigned")
        : (invoice.customer_id ?? `name:${name}`);
    let group = groups.get(id);
    if (!group) {
      group = {
        key: id,
        cells: {
          name: { value: id, label: name },
          ...Object.fromEntries(buckets.map(([key]) => [key, 0])),
          total: 0,
        },
        children: [],
      };
      groups.set(id, group);
    }
    if (buckets.some(([key]) => key === invoice.bucket))
      group.cells[invoice.bucket] =
        Number(group.cells[invoice.bucket]) + invoice.open_balance_cents;
    group.cells.total = Number(group.cells.total) + invoice.open_balance_cents;
    group.children!.push({
      key: invoice.invoice_id,
      href: `/invoices/${invoice.invoice_id}`,
      cells: {
        name: invoice.invoice_number ?? invoice.title ?? "Invoice",
        ...Object.fromEntries(
          buckets.map(([key]) => [
            key,
            invoice.bucket === key ? invoice.open_balance_cents : 0,
          ]),
        ),
        total: invoice.open_balance_cents,
      },
    });
  }
  const rows = [...groups.values()].sort((a, b) =>
    String((a.cells.name as { label: string }).label).localeCompare(
      String((b.cells.name as { label: string }).label),
    ),
  );
  const totals: ReportRow["cells"] = { name: "Total" };
  for (const column of columns.slice(1))
    totals[column.key] = rows.reduce(
      (sum, row) => sum + Number(row.cells[column.key] ?? 0),
      0,
    );
  return {
    subtitle: `As of ${report.as_of}${report.as_closed ? ` · as closed ${report.as_closed.slice(0, 10)}` : ""}`,
    tables: [
      {
        key: `aging-${by}`,
        description:
          "Open balances aged by invoice due date. Expand a row to see its invoices.",
        columns,
        rows,
        totals,
        emptyMessage: "No open receivables as of this date.",
      },
    ],
  };
}
