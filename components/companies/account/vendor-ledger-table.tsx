import Link from "next/link";

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

/**
 * The compact ledger on the vendor overview: the most recent transactions, no
 * controls. Filtering, faceting and paging are the Transactions tab's job — this
 * carried a full filter row that its only caller has always passed
 * `showFilters={false}` to hide.
 */
export function VendorLedgerTable({
  entries,
  truncated = false,
  limit,
  emptyMessage = "No transactions with this vendor yet.",
}: {
  entries: VendorLedgerEntry[];
  truncated?: boolean;
  /** Caps the rows shown; the full register lives on the Transactions tab. */
  limit?: number;
  emptyMessage?: string;
}) {
  const visible = limit ? entries.slice(0, limit) : entries;

  return (
    <div>
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
