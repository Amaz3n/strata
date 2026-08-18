"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { createDepositBatchAction, loadDepositBatchWorkspaceAction } from "@/app/(app)/books/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoneyCentsExact } from "@/lib/utils";

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/deposit-batches").getDepositBatchWorkspace>>;

export function DepositBatches() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [transactionId, setTransactionId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reference, setReference] = useState("");
  const [pending, startTransition] = useTransition();
  const load = useCallback(() => loadDepositBatchWorkspaceAction().then((result) => {
    if (result.success) setWorkspace(result.data);
  }), []);
  useEffect(() => { void load(); }, [load]);
  const selectedTransaction = workspace?.bankTransactions.find((row) => row.id === transactionId);
  const selectedTotal = useMemo(() => (workspace?.payments ?? []).filter((payment) => selected.has(payment.id)).reduce((sum, payment) => sum + payment.amountCents, 0), [selected, workspace]);

  if (!workspace) return <section className="border bg-background p-5 text-sm text-muted-foreground">Loading deposit workspace…</section>;
  return (
    <section className="border bg-background">
      <div className="border-b p-5"><p className="text-sm font-semibold">Make a bank deposit</p><p className="mt-1 text-xs text-muted-foreground">Group receipts in undeposited funds, post one bank deposit, and match it to the feed.</p></div>
      <div className="grid lg:grid-cols-[1.2fr_.8fr]">
        <div className="space-y-4 p-5 lg:border-r">
          <Select value={transactionId} onValueChange={(value) => { setTransactionId(value); setSelected(new Set()); }}>
            <SelectTrigger><SelectValue placeholder="Choose an unmatched bank deposit" /></SelectTrigger>
            <SelectContent>{workspace.bankTransactions.map((transaction) => <SelectItem key={transaction.id} value={transaction.id}>{transaction.date} · {transaction.accountName} · {formatMoneyCentsExact(transaction.amountCents)}</SelectItem>)}</SelectContent>
          </Select>
          <div className="max-h-72 divide-y overflow-y-auto border">
            {workspace.payments.map((payment) => (
              <label key={payment.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-xs">
                <input type="checkbox" checked={selected.has(payment.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(payment.id); else next.delete(payment.id); return next; })} />
                <div className="min-w-0 flex-1"><p className="truncate font-medium">{payment.label}</p><p className="truncate text-muted-foreground">{payment.receivedAt.slice(0, 10)} · {payment.invoiceNumber || payment.method}{payment.reference ? ` · ${payment.reference}` : ""}</p></div>
                <span className="font-mono tabular-nums">{formatMoneyCentsExact(payment.amountCents)}</span>
              </label>
            ))}
            {workspace.payments.length === 0 ? <p className="p-8 text-center text-xs text-muted-foreground">No projected receipts are waiting in undeposited funds.</p> : null}
          </div>
          <Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Deposit slip or reference (optional)" />
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <div className="text-xs"><p>Selected {formatMoneyCentsExact(selectedTotal)}</p><p className={selectedTransaction && selectedTotal !== selectedTransaction.amountCents ? "text-destructive" : "text-muted-foreground"}>Bank deposit {formatMoneyCentsExact(selectedTransaction?.amountCents ?? 0)}</p></div>
            <Button disabled={pending || !selectedTransaction || selected.size === 0 || selectedTotal !== selectedTransaction.amountCents} onClick={() => startTransition(async () => {
              const result = await createDepositBatchAction({ bankTransactionId: selectedTransaction!.id, paymentIds: Array.from(selected), reference: reference || null });
              if (!result.success) { toast.error(result.error); return; }
              toast.success("Deposit posted and matched"); setTransactionId(""); setSelected(new Set()); setReference(""); await load();
            })}>{pending ? "Posting…" : "Post deposit"}</Button>
          </div>
        </div>
        <div><div className="border-b p-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent deposits</div><div className="divide-y">{workspace.batches.map((batch) => <div key={batch.id} className="flex items-center justify-between gap-3 p-4 text-xs"><div><p className="font-medium">{batch.depositedOn} · {batch.accountName}</p><p className="mt-0.5 text-muted-foreground">{batch.itemCount} receipt{batch.itemCount === 1 ? "" : "s"}{batch.reference ? ` · ${batch.reference}` : ""}</p></div><div className="text-right"><p className="font-mono tabular-nums">{formatMoneyCentsExact(batch.totalCents)}</p><Badge variant="outline" className="mt-1 capitalize">{batch.status}</Badge></div></div>)}{workspace.batches.length === 0 ? <p className="p-8 text-center text-xs text-muted-foreground">No deposit batches yet.</p> : null}</div></div>
      </div>
    </section>
  );
}
