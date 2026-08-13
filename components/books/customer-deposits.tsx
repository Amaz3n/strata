"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  applyCustomerDepositAction,
  loadCustomerDepositsAction,
} from "@/app/(app)/books/actions";

type DepositWorkspace = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/customer-deposits").getCustomerDepositWorkspace
  >
>;

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function CustomerDeposits() {
  const [workspace, setWorkspace] = useState<DepositWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = () =>
    startTransition(async () => {
      const result = await loadCustomerDepositsAction();
      if (!result.success) setError(result.error);
      else {
        setWorkspace(result.data);
        setError(null);
      }
    });
  useEffect(load, []);

  return (
    <section className="border bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-semibold">Customer deposits</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Earnest money remains a liability until it is applied to a receivable
          or refunded.
        </p>
      </div>
      {pending && !workspace ? (
        <p className="px-5 py-8 text-sm text-muted-foreground">
          Loading deposit subledger…
        </p>
      ) : null}
      {error ? (
        <div className="px-5 py-6 text-sm text-destructive">
          {error}{" "}
          <Button size="sm" variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : null}
      {workspace ? (
        <div className="divide-y">
          {workspace.deposits
            .filter((deposit) => deposit.availableCents > 0)
            .map((deposit) => {
              const targets = workspace.targetInvoices.filter(
                (invoice: any) =>
                  invoice.id !== deposit.invoiceId &&
                  (!deposit.customerId ||
                    invoice.customer_id === deposit.customerId),
              );
              return (
                <form
                  key={deposit.paymentId}
                  className="grid gap-3 px-5 py-4 lg:grid-cols-[1fr_1fr_10rem_auto] lg:items-end"
                  action={(formData) =>
                    startTransition(async () => {
                      const amount = Number(formData.get("amount"));
                      const result = await applyCustomerDepositAction({
                        depositPaymentId: deposit.paymentId,
                        targetInvoiceId: String(
                          formData.get("targetInvoiceId"),
                        ),
                        amountCents: Math.round(amount * 100),
                      });
                      if (!result.success) toast.error(result.error);
                      else {
                        toast.success("Deposit applied");
                        load();
                      }
                    })
                  }
                >
                  <div>
                    <p className="text-sm font-medium">
                      {deposit.invoiceNumber} · {deposit.title}
                    </p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      Available {money.format(deposit.availableCents / 100)} of{" "}
                      {money.format(deposit.receivedCents / 100)}
                    </p>
                  </div>
                  <Select name="targetInvoiceId" required>
                    <SelectTrigger>
                      <SelectValue placeholder="Apply to invoice" />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((invoice: any) => (
                        <SelectItem key={invoice.id} value={invoice.id}>
                          {invoice.invoice_number} ·{" "}
                          {money.format(
                            Number(
                              invoice.balance_cents ?? invoice.total_cents,
                            ) / 100,
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    name="amount"
                    type="number"
                    min="0.01"
                    max={(deposit.availableCents / 100).toFixed(2)}
                    step="0.01"
                    required
                    placeholder="Amount"
                  />
                  <Button disabled={pending || targets.length === 0}>
                    {pending ? "Applying…" : "Apply"}
                  </Button>
                </form>
              );
            })}
          {workspace.deposits.filter((deposit) => deposit.availableCents > 0)
            .length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">
              No unapplied customer deposits.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
