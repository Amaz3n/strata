import type { getAccountActivity } from "@/lib/services/books/statement-detail";
import type { ReportResult } from "./types";
export type ActivityData = Awaited<ReturnType<typeof getAccountActivity>>;
export function accountActivityResult(data: ActivityData): ReportResult {
  return {
    subtitle: `${data.startDate} through ${data.endDate} · accrual`,
    notice: data.truncated
      ? {
          tone: "warning",
          message: `Showing the first ${data.rowCap} entries. Narrow the dates to see remaining activity. Totals and exports cover only these entries.`,
        }
      : undefined,
    tables: [
      {
        key: "transactions",
        columns: [
          { key: "date", header: "Date", type: "date" },
          { key: "type", header: "Transaction type" },
          { key: "description", header: "Description" },
          { key: "company", header: "Name" },
          { key: "project", header: "Project" },
          { key: "debit", header: "Debit", type: "money", aggregation: "sum" },
          {
            key: "credit",
            header: "Credit",
            type: "money",
            aggregation: "sum",
          },
          {
            key: "amount",
            header: "Amount",
            type: "money",
            aggregation: "sum",
          },
          {
            key: "balance",
            header: "Account balance",
            type: "money",
            exportOnly: true,
          },
          { key: "memo", header: "Memo", exportOnly: true },
          { key: "entryKind", header: "Entry kind", exportOnly: true },
        ],
        rows: data.rows.map((row) => ({
          key: row.lineId,
          cells: {
            date: row.entryDate,
            type: row.source?.label ?? row.entryKind,
            description: {
              value: row.description || row.memo || "Journal entry",
              href: row.source?.href ?? undefined,
            },
            company: {
              value: row.companyId ?? "unassigned",
              label: row.companyName ?? "—",
            },
            project: {
              value: row.projectId ?? "unassigned",
              label: row.projectName ?? "Unassigned",
            },
            debit: row.debitCents,
            credit: row.creditCents,
            amount:
              data.account.normalBalance === "debit"
                ? row.debitCents - row.creditCents
                : row.creditCents - row.debitCents,
            balance: row.balanceCents,
            memo: row.memo,
            entryKind: row.entryKind,
          },
        })),
        totals: {
          description: "Total",
          debit: data.periodDebitCents,
          credit: data.periodCreditCents,
          amount: data.closingBalanceCents - data.openingBalanceCents,
        },
        emptyMessage: "No transactions for this account and period.",
      },
    ],
  };
}
