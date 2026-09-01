import { newInvoiceHref } from "@/lib/financials/invoice-destinations"
import Link from "next/link";

import type { PartyReceivablesSummary } from "@/lib/services/financial-parties";
import { Button } from "@/components/ui/button";
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

export function ClientReceivablesTable({
  summary,
}: {
  summary: PartyReceivablesSummary | null;
}) {
  const rows = summary?.projects ?? [];

  return (
    <div>
      {summary && !summary.can_view_invoices ? (
        <div className="border-b px-4 py-3 text-sm text-muted-foreground">
          Invoice totals require invoice access. Contract values and client projects are still
          shown.
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <Table className={cn("min-w-[760px]", TABLE_EDGE)}>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-48">Project</TableHead>
                <TableHead className="text-right">Contract</TableHead>
                <TableHead className="text-right">Invoiced</TableHead>
                <TableHead className="text-right">Collected</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="text-right">Last activity</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.project_id} className="group relative">
                  <TableCell>
                    <Link
                      href={`/projects/${row.project_id}`}
                      className="font-medium underline-offset-4 group-hover:underline"
                    >
                      {row.project_name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatMoneyFromCents(row.contract_value_cents)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatMoneyFromCents(row.invoiced_cents)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                    {formatMoneyFromCents(row.collected_cents)}
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium tabular-nums">
                    {formatMoneyFromCents(row.outstanding_cents)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatDate(row.last_activity)}
                  </TableCell>
                  <TableCell className="text-right">
                    {summary?.can_view_invoices ? (
                      <Button asChild size="sm" variant="ghost">
                        <Link href={newInvoiceHref(row.project_id)}>
                          New invoice
                        </Link>
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState>No client projects yet.</EmptyState>
      )}
    </div>
  );
}
