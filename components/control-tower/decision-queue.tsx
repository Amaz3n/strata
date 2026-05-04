"use client";

import Link from "next/link";

import type { DecisionItem, DecisionType } from "@/lib/services/dashboard";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const typeStyles: Partial<Record<DecisionType, string>> = {
  vendor_bill: "border-chart-2/30 bg-chart-2/15 text-foreground",
  change_order: "border-chart-4/35 bg-chart-4/15 text-foreground",
  punch_item: "border-destructive/30 bg-destructive/15 text-foreground",
  rfi: "border-chart-1/30 bg-chart-1/15 text-foreground",
  submittal: "border-chart-3/30 bg-chart-3/15 text-foreground",
  proposal: "border-chart-5/30 bg-chart-5/15 text-foreground",
};

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

export function DecisionQueue({ items }: { items: DecisionItem[] }) {
  const urgentCount = items.filter(
    (item) => item.severity === "high" || item.ageDays > 7,
  ).length;
  const costImpact = items.reduce(
    (sum, item) => sum + (item.impactCents ?? 0),
    0,
  );
  const scheduleImpact = items.reduce(
    (sum, item) => sum + (item.impactDays ?? 0),
    0,
  );

  return (
    <section className="border-b border-border/70 bg-card">
      <header className="border-b border-border/70 bg-gradient-to-r from-chart-1/10 via-card to-chart-4/10 px-4 py-4 sm:px-6">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Action Queue
            </p>
            <h2 className="text-lg font-semibold tracking-tight">
              Needs your decision
            </h2>
          </div>
          <Badge variant="outline" className="bg-background/70">
            {items.length} pending
          </Badge>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Urgent
            </p>
            <p className="text-lg font-semibold tabular-nums text-destructive">
              {urgentCount}
            </p>
          </div>
          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Cost
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {formatCurrency(costImpact)}
            </p>
          </div>
          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Days
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {scheduleImpact}
            </p>
          </div>
        </div>
      </header>

      <div className="px-4 py-3 sm:px-6">
        <Table>
          <TableHeader className="bg-muted/35">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[130px] text-muted-foreground">
                Type
              </TableHead>
              <TableHead className="text-muted-foreground">Item</TableHead>
              <TableHead className="w-[110px] text-right text-muted-foreground">
                Age
              </TableHead>
              <TableHead className="w-[140px] text-right text-muted-foreground">
                Impact
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-muted-foreground"
                >
                  No pending decisions
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => {
                const isUrgent = item.severity === "high" || item.ageDays > 7;

                return (
                  <TableRow
                    key={item.id}
                    className={cn(
                      "group border-border/60",
                      isUrgent
                        ? "bg-destructive/[0.035] hover:bg-destructive/[0.075]"
                        : "hover:bg-accent/35",
                    )}
                  >
                    <TableCell className="relative">
                      <span
                        aria-hidden
                        className={cn(
                          "absolute inset-y-2 left-0 w-1 rounded-r-full",
                          isUrgent ? "bg-destructive" : "bg-chart-1",
                        )}
                      />
                      <Badge
                        variant="outline"
                        className={cn("font-medium", typeStyles[item.type])}
                      >
                        {item.typeLabel}
                      </Badge>
                    </TableCell>
                    <TableCell className="min-w-0">
                      <Link
                        href={item.href}
                        className="block min-w-0 hover:underline"
                      >
                        <span className="block truncate font-medium">
                          {item.title}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.projectName ?? "System"}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-medium tabular-nums",
                        isUrgent ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {item.ageDays === 0 ? "Today" : `${item.ageDays}d`}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {item.impactCents
                        ? formatCurrency(item.impactCents)
                        : null}
                      {item.impactCents && item.impactDays ? " / " : null}
                      {item.impactDays ? `${item.impactDays}d` : null}
                      {!item.impactCents && !item.impactDays
                        ? item.impactLabel
                        : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
