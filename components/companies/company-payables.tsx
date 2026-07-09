"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import type { VendorBillSummary } from "@/lib/services/vendor-bills";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  Section,
  TABLE_EDGE,
  formatDate,
  formatMoneyFromCents,
} from "@/components/companies/company-detail-ui";
import { payableStatusMeta } from "@/components/companies/payable-status";

export function CompanyPayables({
  vendorBills,
  stagger = 1,
  fill = false,
  className,
}: {
  vendorBills: VendorBillSummary[];
  stagger?: number;
  fill?: boolean;
  className?: string;
}) {
  const router = useRouter();

  const rows = useMemo(
    () =>
      [...vendorBills].sort((a, b) =>
        (b.bill_date ?? b.created_at ?? "").localeCompare(
          a.bill_date ?? a.created_at ?? "",
        ),
      ),
    [vendorBills],
  );

  const totals = useMemo(() => {
    const billed = rows.reduce((sum, b) => sum + (b.total_cents ?? 0), 0);
    const paid = rows.reduce(
      (sum, b) => sum + (b.paid_cents ?? (b.status === "paid" ? (b.total_cents ?? 0) : 0)),
      0,
    );
    return { billed, paid };
  }, [rows]);

  // Bills are edited in the project payables workspace — the single home for
  // payable mutations. This desk view only lists and deep-links.
  const openInWorkspace = (bill: VendorBillSummary) => {
    router.push(`/projects/${bill.project_id}/financials/payables?bill=${bill.id}`);
  };

  return (
    <Section
      id="payables"
      title="Payables"
      count={rows.length}
      stagger={stagger}
      fill={fill}
      className={className}
      bodyClassName="overflow-x-auto"
    >
      {rows.length > 0 ? (
        <Table className={TABLE_EDGE}>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-28">Invoice date</TableHead>
              <TableHead className="min-w-40">Project</TableHead>
              <TableHead>Invoice no.</TableHead>
              <TableHead className="w-24 text-center">Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((bill) => {
              const meta = payableStatusMeta(bill);
              return (
                <TableRow
                  key={bill.id}
                  className="cursor-pointer"
                  onClick={() => openInWorkspace(bill)}
                >
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDate(bill.bill_date ?? bill.created_at?.slice(0, 10))}
                  </TableCell>
                  <TableCell className="truncate">
                    {bill.project_name ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {bill.bill_number ?? "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    <span
                      className={`inline-flex items-center border px-1.5 py-0 text-[10px] font-medium ${meta.className}`}
                    >
                      {meta.label}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium tabular-nums">
                    {formatMoneyFromCents(bill.total_cents)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell
                colSpan={4}
                className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                Total · paid {formatMoneyFromCents(totals.paid)}
              </TableCell>
              <TableCell className="text-right font-mono font-medium tabular-nums">
                {formatMoneyFromCents(totals.billed)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      ) : (
        <EmptyState>No vendor invoices yet.</EmptyState>
      )}
    </Section>
  );
}
