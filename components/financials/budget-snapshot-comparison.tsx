"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, History } from "lucide-react";

import { compareForecastSnapshotLines } from "@/lib/financials/forecasting";
import type { BudgetSnapshotRow } from "@/lib/services/budgets";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Snapshot = Pick<
  BudgetSnapshotRow,
  "id" | "snapshot_date" | "label" | "source" | "by_cost_code"
>;
type CostCodeLabel = { id: string; code: string | null; name: string | null };

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

const snapshotLabel = (snapshot: Snapshot) =>
  snapshot.label ??
  `${new Date(`${snapshot.snapshot_date}T12:00:00`).toLocaleDateString()} · ${snapshot.source}`;

export function BudgetSnapshotComparison({
  projectId,
  snapshots,
  costCodes = [],
}: {
  projectId: string;
  snapshots: Snapshot[];
  costCodes?: CostCodeLabel[];
}) {
  const [fromId, setFromId] = useState(
    snapshots[1]?.id ?? snapshots[0]?.id ?? "",
  );
  const [toId, setToId] = useState(snapshots[0]?.id ?? "");
  const [showUnchanged, setShowUnchanged] = useState(false);

  const enrichedSnapshots = useMemo(() => {
    const labels = new Map(costCodes.map((code) => [code.id, code]));
    return snapshots.map((snapshot) => ({
      ...snapshot,
      by_cost_code: snapshot.by_cost_code.map((row) => {
        const match = row.cost_code_id ? labels.get(row.cost_code_id) : null;
        return {
          ...row,
          cost_code: row.cost_code ?? match?.code ?? null,
          cost_code_name: row.cost_code_name ?? match?.name ?? null,
        };
      }),
    }));
  }, [costCodes, snapshots]);

  const rows = useMemo(() => {
    const from =
      enrichedSnapshots.find((item) => item.id === fromId)?.by_cost_code ?? [];
    const to =
      enrichedSnapshots.find((item) => item.id === toId)?.by_cost_code ?? [];
    return compareForecastSnapshotLines(from, to).sort(
      (left, right) =>
        Math.abs(right.variance_cents) - Math.abs(left.variance_cents),
    );
  }, [enrichedSnapshots, fromId, toId]);

  const changedRows = rows.filter((row) => row.variance_cents !== 0);
  const visibleRows = showUnchanged ? rows : changedRows;
  const netMovement = rows.reduce((sum, row) => sum + row.variance_cents, 0);
  const grossMovement = rows.reduce(
    (sum, row) => sum + Math.abs(row.variance_cents),
    0,
  );

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <p className="text-sm font-semibold">Snapshot comparison</p>
          <p className="text-xs text-muted-foreground">
            Trace forecast movement by cost code between two captured states.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/projects/${projectId}/reports/forecast-time-phased`}>
            Time-phased forecast
          </Link>
        </Button>
      </div>

      {snapshots.length < 2 ? (
        <div className="border border-dashed py-16 text-center">
          <History className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">Two snapshots are required</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Nightly snapshots will appear here automatically.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                From
              </label>
              <Select value={fromId} onValueChange={setFromId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {snapshots.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {snapshotLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ArrowRight className="mb-2 hidden h-4 w-4 text-muted-foreground sm:block" />
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                To
              </label>
              <Select value={toId} onValueChange={setToId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {snapshots.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {snapshotLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-px border bg-border sm:grid-cols-3">
            <div className="bg-card p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Changed cost codes
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {changedRows.length}
              </p>
            </div>
            <div className="bg-card p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Gross movement
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {money(grossMovement)}
              </p>
            </div>
            <div className="bg-card p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Net forecast change
              </p>
              <p
                className={`mt-1 text-xl font-semibold tabular-nums ${netMovement > 0 ? "text-destructive" : netMovement < 0 ? "text-success" : ""}`}
              >
                {netMovement > 0 ? "+" : ""}
                {money(netMovement)}
              </p>
            </div>
          </div>

          <div className="border">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <p className="text-xs text-muted-foreground">
                {showUnchanged
                  ? `${rows.length} total cost codes`
                  : `${changedRows.length} changed cost codes`}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowUnchanged((value) => !value)}
              >
                {showUnchanged ? "Hide unchanged" : "Show all"}
              </Button>
            </div>
            <div className="max-h-[560px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cost code</TableHead>
                    <TableHead className="text-right">From EAC</TableHead>
                    <TableHead className="text-right">To EAC</TableHead>
                    <TableHead className="text-right">Movement</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="h-24 text-center text-muted-foreground"
                      >
                        No forecast movement between these snapshots.
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibleRows.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell className="font-medium">
                          {row.label}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(row.from_cents)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(row.to_cents)}
                        </TableCell>
                        <TableCell
                          className={`text-right font-medium tabular-nums ${row.variance_cents > 0 ? "text-destructive" : row.variance_cents < 0 ? "text-success" : ""}`}
                        >
                          {row.variance_cents > 0 ? "+" : ""}
                          {money(row.variance_cents)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
