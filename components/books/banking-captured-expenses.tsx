"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { loadUnmatchedCapturedExpensesAction } from "@/app/(app)/books/banking-actions";
import type { UnmatchedCapturedExpense } from "@/lib/services/books/banking-workspace";
import { formatBankDate } from "./banking-ui";

/** One line naming the receipt a charge already is: "Home Depot · Smith job". */
export function capturedExpenseLabel(expense: {
  vendorName: string | null;
  homeLabel: string;
}) {
  return `${expense.vendorName ?? "Receipt"} · ${expense.homeLabel}`;
}

/**
 * Shown above the categorize form when a charge is the cost of an approved
 * expense. Matching links the two; categorizing would post the cost again.
 */
export function CapturedExpenseBand({
  vendorName,
  entryDate,
  homeLabel,
  receiptFileId,
  busy,
  onMatch,
}: {
  vendorName: string | null;
  entryDate: string;
  homeLabel: string;
  receiptFileId: string | null;
  busy: boolean;
  onMatch: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border border-primary/30 bg-primary/5 p-3">
      <div className="min-w-0 text-sm">
        <p className="font-medium">
          This looks like the receipt {vendorName ?? "someone"} captured on{" "}
          {formatBankDate(entryDate)} for {homeLabel}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          That expense already recorded this cost. Match it so the charge is
          reconciled without counting the cost twice.
          {receiptFileId && (
            <>
              {" "}
              <a
                className="text-primary hover:underline"
                href={`/api/files/${receiptFileId}/raw`}
                target="_blank"
                rel="noreferrer"
              >
                View receipt
              </a>
            </>
          )}
        </p>
      </div>
      <Button size="sm" disabled={busy} onClick={onMatch}>
        {busy ? <Loader2 className="mr-2 size-3 animate-spin" /> : null}
        Match to this expense
      </Button>
    </div>
  );
}

export function RecordCostTwiceConfirm({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Record this cost twice?</AlertDialogTitle>
          <AlertDialogDescription>
            An approved expense already recorded this charge. Posting it as a
            new transaction adds the cost a second time. Match it to the
            expense instead unless this is a different purchase.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Go back</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Post anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

function expenseHref(row: UnmatchedCapturedExpense) {
  return row.projectId
    ? `/projects/${row.projectId}/expenses`
    : "/payables/expenses?queue=overhead";
}

/** Approved spend that has not appeared on a statement yet, newest first. */
export function UnstatementedExpenses({ refreshKey }: { refreshKey: number }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | {
        kind: "ready";
        rows: UnmatchedCapturedExpense[];
        truncated: boolean;
        rowCap: number;
      }
  >({ kind: "loading" });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    loadUnmatchedCapturedExpensesAction()
      .then((result) => {
        if (!alive) return;
        setState(
          result.success
            ? { kind: "ready", ...result.data }
            : {
                kind: "error",
                message: result.error ?? "Could not load expenses",
              },
        );
      })
      .catch(() => {
        if (alive) setState({ kind: "error", message: "Could not load expenses" });
      });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (state.kind === "loading")
    return (
      <div className="border-b px-6 py-3">
        <Skeleton className="h-5 w-72" />
      </div>
    );
  if (state.kind === "error")
    return (
      <p role="alert" className="border-b px-6 py-3 text-xs text-destructive">
        {state.message}
      </p>
    );
  if (state.rows.length === 0) return null;
  const withoutReceipt = state.rows.filter((row) => !row.hasReceipt).length;
  return (
    <div className="border-b px-6 py-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left text-sm"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="font-medium">
          {state.rows.length}
          {state.truncated ? "+" : ""} approved expenses not on a statement yet
        </span>
        <span className="text-xs text-muted-foreground">
          {withoutReceipt > 0
            ? `${withoutReceipt} without a receipt · `
            : ""}
          last 90 days · {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto border">
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {state.rows.map((row) => (
                <tr key={row.expenseId} className="h-9">
                  <td className="px-3 text-xs tabular-nums text-muted-foreground">
                    {formatBankDate(row.expenseDate)}
                  </td>
                  <td className="px-3">
                    <Link
                      className="hover:underline"
                      href={expenseHref(row)}
                    >
                      {capturedExpenseLabel(row)}
                    </Link>
                  </td>
                  <td className="px-3 text-xs text-muted-foreground">
                    {row.hasReceipt ? "Receipt attached" : "No receipt"}
                  </td>
                  <td className="px-3 text-right tabular-nums">
                    {money(row.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.truncated && (
            <p className="border-t px-3 py-2 text-xs text-warning">
              Showing the newest {state.rowCap}. Reconcile the oldest charges
              to see the rest.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
