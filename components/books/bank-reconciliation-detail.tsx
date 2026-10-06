"use client";
import { reopenBankReconciliationAction } from "@/app/(app)/books/actions";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Circle, Minus } from "lucide-react";
import { toast } from "sonner";

import {
  closeBankReconciliationAction,
  createBankBookOffsetAction,
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
          {detail.status === "closed" ? <details className="text-xs"><summary className="cursor-pointer">Reopen statement</summary><form className="mt-2 flex gap-2" onSubmit={event => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? ""); startTransition(async () => { const result = await reopenBankReconciliationAction({ reconciliationId: detail.id, reason }); if (!result.success) { toast.error(result.error); return; } toast.success("Statement reopened; prior evidence preserved"); load(); onClosed(); }); }}><input name="reason" minLength={10} required placeholder="Reason for reopening" aria-label="Reopening reason" className="border bg-background p-2" /><Button type="submit" size="sm" variant="outline" disabled={pending}>Reopen</Button></form></details> : null}
          {detail.status !== "closed" ? (
            <Button
              size="sm"
              disabled={pending || detail.differenceCents !== 0 || detail.bookDifferenceCents !== 0 || detail.items.some((item) => item.status === "outstanding") || detail.truncated}
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
          ["Statement difference", detail.differenceCents],
          ["Outstanding book activity", detail.outstandingBalanceCents],
          ["Adjusted statement", detail.endingBalanceCents + detail.outstandingBalanceCents],
          ["Book balance", detail.bookBalanceCents],
          ["Book difference", detail.bookDifferenceCents],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-background p-4">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className={cn("mt-1 font-mono text-sm tabular-nums", String(label).toLowerCase().includes("difference") && Number(value) !== 0 && "text-destructive")}>{formatMoneyCentsExact(Number(value))}</p>
          </div>
        ))}
      </div>
      {detail.legacyTransactionEvidence ? <p className="border-b p-4 text-sm text-muted-foreground">This older close preserved totals and outstanding entries, but not transaction descriptions. Its transaction list is unavailable.</p> : null}
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
        {rows.length === 0 && !detail.legacyTransactionEvidence ? <p className="p-8 text-center text-sm text-muted-foreground">No statement transactions match.</p> : null}
      </div>
      {detail.outstandingItems.length > 0 ? <OutstandingEntries detail={detail} onOffset={load} /> : null}
      {detail.evidenceDigest ? <p className="break-all border-t p-4 text-xs text-muted-foreground">Closed evidence: {detail.evidenceDigest}</p> : null}
      {detail.truncated ? <p className="border-t px-4 py-3 text-xs text-destructive">More than 5,000 transactions fall in this statement period. Narrow the period before closing.</p> : null}
    </section>
  );
}

/**
 * Book entries the bank has not cleared. Entries that cancel each other — a
 * check and its void — are cleared together as an offset instead of waiting
 * on a bank transaction that will never come.
 */
function OutstandingEntries({ detail, onOffset }: { detail: Detail; onOffset: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const open = detail.status !== "closed";
  const selectedCents = detail.outstandingItems.filter((item) => selected.has(item.journal_line_id)).reduce((sum, item) => sum + item.amount_cents, 0);
  const canOffset = selected.size >= 2 && selectedCents === 0 && reason.trim().length >= 10;
  return (
    <div className="border-t">
      <div className="flex items-center justify-between gap-4 px-4 pt-4">
        <p className="text-sm font-medium">Outstanding book entries</p>
        {open && selected.size > 0 ? <p className={cn("text-xs tabular-nums", selectedCents === 0 ? "text-success" : "text-muted-foreground")}>Selected net {formatMoneyCentsExact(selectedCents)}</p> : null}
      </div>
      <ul className="divide-y px-4">
        {detail.outstandingItems.map((item) => (
          <li key={item.journal_line_id} className="grid grid-cols-[auto_90px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-xs">
            {open ? (
              <input type="checkbox" aria-label={`Select ${item.memo} for an offset`} checked={selected.has(item.journal_line_id)}
                onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(item.journal_line_id); else next.delete(item.journal_line_id); return next; })} />
            ) : <span />}
            <span className="tabular-nums text-muted-foreground">{item.entryDate}</span>
            <div className="min-w-0"><p className="truncate font-medium">{item.memo}</p>{item.description ? <p className="truncate text-muted-foreground">{item.description}</p> : null}</div>
            <span className="font-mono tabular-nums">{formatMoneyCentsExact(item.amount_cents)}</span>
          </li>
        ))}
      </ul>
      {open && selected.size >= 2 ? (
        <form className="flex flex-wrap items-center gap-2 border-t p-4" onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await createBankBookOffsetAction({ bankAccountId: detail.bankAccountId, journalLineIds: Array.from(selected), reason });
            if (!result.success) { toast.error(result.error); return; }
            toast.success("Entries cleared as an offset");
            setSelected(new Set()); setReason(""); onOffset();
          });
        }}>
          <input value={reason} onChange={(event) => setReason(event.target.value)} aria-label="Why these entries cancel" placeholder="Why these entries cancel (for example, check 301 voided)"
            className="h-9 min-w-0 flex-1 border bg-background px-3 text-xs outline-none focus:border-ring" />
          <Button type="submit" size="sm" variant="outline" disabled={pending || !canOffset}>{pending ? "Clearing…" : "Clear as offsetting entries"}</Button>
          {selectedCents !== 0 ? <p className="w-full text-xs text-muted-foreground">Selected entries must net to zero to clear each other.</p> : null}
        </form>
      ) : null}
    </div>
  );
}
