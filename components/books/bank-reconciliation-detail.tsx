"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Circle, Minus } from "lucide-react";
import { toast } from "sonner";

import {
  closeBankReconciliationAction,
  loadBankReconciliationDetailAction,
} from "@/app/(app)/books/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { BankReconciliationDetail as Detail } from "@/lib/services/books/bank-reconciliation";
import { cn, formatMoneyCentsExact } from "@/lib/utils";

export function BankReconciliationDetail({
  reconciliationId,
  onClosed,
}: {
  reconciliationId: string;
  onClosed: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    setError(null);
    loadBankReconciliationDetailAction(reconciliationId)
      .then((result) => result.success ? setDetail(result.data) : setError(result.error))
      .catch(() => setError("The statement checklist could not be loaded."));
  }, [reconciliationId]);

  useEffect(load, [load]);

  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return detail?.items ?? [];
    return (detail?.items ?? []).filter((row) =>
      `${row.transactionDate} ${row.counterparty ?? ""} ${row.description} ${row.amountCents}`.toLowerCase().includes(normalized),
    );
  }, [detail, query]);

  if (error) return <p className="border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>;
  if (!detail) return <div className="space-y-2 border bg-background p-5"><Skeleton className="h-6 w-48" /><Skeleton className="h-24 w-full" /></div>;

  const outstanding = detail.items.filter((item) => item.status === "outstanding").length;
  return (
    <section className="border bg-background">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5">
        <div>
          <p className="text-sm font-semibold">Statement checklist</p>
          <p className="mt-1 text-xs text-muted-foreground">{detail.statementStart} → {detail.statementEnd} · {outstanding} outstanding</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline"><Link href="/books/banking">Review unmatched</Link></Button>
          {detail.status !== "closed" ? (
            <Button
              size="sm"
              disabled={pending || detail.differenceCents !== 0 || detail.truncated}
              onClick={() => startTransition(async () => {
                const result = await closeBankReconciliationAction(detail.id);
                if (!result.success) {
                  toast.error(result.error);
                  return;
                }
                toast.success("Reconciliation closed");
                load();
                onClosed();
              })}
            >
              {pending ? "Closing…" : "Close reconciliation"}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
        {[
          ["Beginning", detail.beginningBalanceCents],
          ["Cleared", detail.clearedBalanceCents],
          ["Statement", detail.endingBalanceCents],
          ["Difference", detail.differenceCents],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-background p-4">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className={cn("mt-1 font-mono text-sm tabular-nums", label === "Difference" && Number(value) !== 0 && "text-destructive")}>{formatMoneyCentsExact(Number(value))}</p>
          </div>
        ))}
      </div>
      <div className="border-b p-3">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search statement transactions" className="h-9 w-full border bg-background px-3 text-sm outline-none focus:border-ring" />
      </div>
      <div className="max-h-[440px] divide-y overflow-y-auto">
        {rows.map((row) => (
          <div key={row.transactionId} className="grid grid-cols-[22px_90px_1fr_auto] items-center gap-3 px-4 py-2.5 text-xs">
            {row.status === "cleared" ? <Check className="h-4 w-4 text-success" /> : row.status === "excluded" ? <Minus className="h-4 w-4 text-muted-foreground" /> : <Circle className="h-4 w-4 text-warning" />}
            <span className="tabular-nums text-muted-foreground">{row.transactionDate}</span>
            <div className="min-w-0"><p className="truncate font-medium">{row.counterparty || row.description}</p><p className="truncate text-muted-foreground">{row.status === "outstanding" ? `${formatMoneyCentsExact(row.matchedCents)} matched` : row.status}</p></div>
            <span className="font-mono tabular-nums">{row.direction === "outflow" ? "−" : ""}{formatMoneyCentsExact(row.amountCents)}</span>
          </div>
        ))}
        {rows.length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">No statement transactions match.</p> : null}
      </div>
      {detail.truncated ? <p className="border-t px-4 py-3 text-xs text-destructive">More than 5,000 transactions fall in this statement period. Narrow the period before closing.</p> : null}
    </section>
  );
}
