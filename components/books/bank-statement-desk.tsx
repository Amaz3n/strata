"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { createBankReconciliationAction } from "@/app/(app)/books/actions";
import { BankReconciliationDetail } from "@/components/books/bank-reconciliation-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn, formatMoneyCentsExact } from "@/lib/utils";

type Statement = {
  id: string;
  bank_account_id: string;
  statement_start: string;
  statement_end: string;
  ending_balance_cents: number;
  difference_cents: number | null;
  status: string;
};

/**
 * Statement reconciliation: open a statement with its balances, work its
 * checklist, close it. Closed statements stay viewable for their frozen
 * evidence and newest-first reopen.
 */
export function BankStatementDesk({
  bankAccounts,
  statements,
  canReconcile,
  initialAccountId,
}: {
  bankAccounts: Array<{ id: string; name: string; official_name: string | null }>;
  statements: Statement[];
  canReconcile: boolean;
  initialAccountId?: string | null;
}) {
  const router = useRouter();
  const [accountId, setAccountId] = useState(initialAccountId ?? bankAccounts[0]?.id ?? "");
  const accountStatements = statements.filter((statement) => statement.bank_account_id === accountId);
  const [selectedId, setSelectedId] = useState<string | null>(accountStatements.find((statement) => statement.status !== "closed")?.id ?? null);
  if (bankAccounts.length === 0) return null;
  return (
    <section aria-label="Statement reconciliation" className="space-y-3 border-t pt-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Statements</h2>
        <p className="text-xs text-muted-foreground">Reconcile each statement to the ledger. A period cannot close until its accounts are reconciled through period end.</p>
      </div>
      <Select value={accountId} onValueChange={(value) => { setAccountId(value); setSelectedId(null); }}>
        <SelectTrigger aria-label="Bank or card account" className="w-full"><SelectValue placeholder="Choose an account" /></SelectTrigger>
        <SelectContent>{bankAccounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.official_name || account.name}</SelectItem>)}</SelectContent>
      </Select>
      {canReconcile && accountId ? (
        <form
          className="grid grid-cols-2 gap-2 border bg-background p-3"
          action={async (formData) => {
            formData.set("bankAccountId", accountId);
            const result = await createBankReconciliationAction(formData);
            if (!result.success) { toast.error(result.error); return; }
            toast.success("Statement opened");
            setSelectedId(result.data);
            router.refresh();
          }}
        >
          <label className="text-xs">Statement start<Input name="statementStart" type="date" required className="mt-1" /></label>
          <label className="text-xs">Statement end<Input name="statementEnd" type="date" required className="mt-1" /></label>
          <label className="text-xs">Beginning balance<Input name="beginningBalance" inputMode="decimal" placeholder="12,345.67" required className="mt-1" /></label>
          <label className="text-xs">Ending balance<Input name="endingBalance" inputMode="decimal" placeholder="12,100.42" required className="mt-1" /></label>
          <Button type="submit" size="sm" className="col-span-2">Open statement</Button>
        </form>
      ) : null}
      <ul className="divide-y border bg-background">
        {accountStatements.map((statement) => (
          <li key={statement.id}>
            <button type="button" onClick={() => setSelectedId(statement.id)}
              className={cn("flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-xs hover:bg-muted/40 focus-visible:outline-1 focus-visible:outline-ring", selectedId === statement.id && "bg-muted/60")}>
              <span className="min-w-0">
                <span className="block tabular-nums">{statement.statement_start} → {statement.statement_end}</span>
                <span className="block text-muted-foreground tabular-nums">Ending {formatMoneyCentsExact(statement.ending_balance_cents)}{statement.status !== "closed" && statement.difference_cents ? ` · difference ${formatMoneyCentsExact(statement.difference_cents)}` : ""}</span>
              </span>
              <Badge variant="outline" className={cn("capitalize", statement.status === "closed" ? "text-success" : "text-warning")}>{statement.status}</Badge>
            </button>
          </li>
        ))}
        {accountStatements.length === 0 ? <li className="px-3 py-6 text-center text-xs text-muted-foreground">No statements for this account yet.</li> : null}
      </ul>
      {selectedId ? <BankReconciliationDetail key={selectedId} reconciliationId={selectedId} onClosed={() => router.refresh()} /> : null}
    </section>
  );
}
