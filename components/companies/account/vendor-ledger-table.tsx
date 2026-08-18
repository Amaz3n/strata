"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import type { VendorLedgerEntry, VendorLedgerEntryKind } from "@/lib/services/vendor-account";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  TABLE_EDGE,
  formatDate,
  formatMoneyFromCents,
} from "@/components/companies/company-detail-ui";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<VendorLedgerEntryKind, string> = {
  bill: "Bill",
  vendor_credit: "Credit",
  payment: "Payment",
  expense: "Expense",
};

type KindFilter = "all" | VendorLedgerEntryKind;

const FILTERS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "bill", label: "Bills" },
  { key: "payment", label: "Payments" },
  { key: "vendor_credit", label: "Credits" },
  { key: "expense", label: "Expenses" },
];

function statusTone(entry: VendorLedgerEntry) {
  if (entry.is_draft) return "text-muted-foreground";
  switch (entry.status) {
    case "paid":
    case "succeeded":
    case "completed":
      return "text-success";
    case "rejected":
    case "overdue":
      return "text-destructive";
    case "pending":
    case "partial":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

function entryHref(entry: VendorLedgerEntry) {
  if (entry.kind === "expense") {
    return entry.project_id ? `/projects/${entry.project_id}/expenses` : null;
  }
  return `/payables?bill=${entry.target_id}`;
}

function statusLabel(entry: VendorLedgerEntry) {
  if (entry.is_draft) return "draft";
  return entry.status ?? "—";
}

export function VendorLedgerTable({
  entries,
  truncated = false,
  limit,
  showFilters = true,
  emptyMessage = "No transactions with this vendor yet.",
}: {
  entries: VendorLedgerEntry[];
  truncated?: boolean;
  /** Compact mode for the overview: caps rows and hides the filter row. */
  limit?: number;
  showFilters?: boolean;
  emptyMessage?: string;
}) {
  const searchParams = useSearchParams();
  const [kind, setKind] = useState<KindFilter>("all");
  const overdueOnly = showFilters && searchParams.get("filter") === "overdue";

  const visible = useMemo(() => {
    let rows = entries;
    if (kind !== "all") rows = rows.filter((entry) => entry.kind === kind);
    if (overdueOnly) {
      const today = new Date().toISOString().slice(0, 10);
      rows = rows.filter(
        (entry) =>
          entry.kind === "bill" &&
          !entry.is_draft &&
          entry.status !== "paid" &&
          entry.status !== "rejected" &&
          entry.date !== null &&
          entry.date < today,
      );
    }
    return limit ? rows.slice(0, limit) : rows;
  }, [entries, kind, limit, overdueOnly]);

  return (
    <div>
      {showFilters ? (
        <div className="flex flex-wrap items-center gap-1 border-b px-4 py-2">
          {FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => setKind(filter.key)}
              className={cn(
                "border px-2.5 py-1 text-xs font-medium transition-colors",
                kind === filter.key
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {filter.label}
            </button>
          ))}
          {overdueOnly ? (
            <span className="ml-auto text-xs text-warning">Showing overdue bills only</span>
          ) : null}
        </div>
      ) : null}

      {visible.length > 0 ? (
        <div className="overflow-x-auto">
          <Table className={cn("min-w-[860px]", TABLE_EDGE)}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Date</TableHead>
                <TableHead className="w-24">Type</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Project</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="w-32 text-right">Amount</TableHead>
                <TableHead className="w-32 text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((entry) => {
                const href = entryHref(entry);
                const reference = (
                  <span className="block max-w-[28rem] truncate">
                    {entry.reference || entry.commitment_title || "—"}
                  </span>
                );
                return (
                  <TableRow key={entry.id} className="group">
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(entry.date)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {KIND_LABEL[entry.kind]}
                    </TableCell>
                    <TableCell className="font-medium">
                      {href ? (
                        <Link href={href} className="underline-offset-4 group-hover:underline">
                          {reference}
                        </Link>
                      ) : (
                        reference
                      )}
                    </TableCell>
                    <TableCell>
                      {entry.project_id ? (
                        <Link
                          href={`/projects/${entry.project_id}`}
                          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                        >
                          {entry.project_name ?? "Project"}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className={cn("whitespace-nowrap text-xs font-medium capitalize", statusTone(entry))}>
                      {statusLabel(entry)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "whitespace-nowrap text-right font-mono tabular-nums",
                        entry.amount_cents < 0 ? "text-success" : "text-foreground",
                      )}
                    >
                      {formatMoneyFromCents(entry.amount_cents)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums text-muted-foreground">
                      {entry.balance_cents === null ? "—" : formatMoneyFromCents(entry.balance_cents)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState>{emptyMessage}</EmptyState>
      )}

      {truncated ? (
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          Showing the most recent activity — older records are not included in these totals.
        </div>
      ) : null}
    </div>
  );
}
