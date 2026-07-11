"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  approveBudgetTransferAction,
  createBudgetTransferAction,
  setBudgetLineContingencyAction,
} from "@/app/(app)/projects/[id]/budget/actions";
import { unwrapAction } from "@/lib/action-result";
import type { BudgetTransfer } from "@/lib/services/budget-transfers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type Line = {
  id: string;
  description: string;
  amount_cents: number | null;
  metadata?: Record<string, unknown>;
  cost_code?: { code?: string | null; name?: string | null } | null;
};
const toCents = (value: string) =>
  Math.round(Number(value.replaceAll(",", "")) * 100);
const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

export function BudgetTransfersPanel({
  projectId,
  transfers,
  lines,
}: {
  projectId: string;
  transfers: BudgetTransfer[];
  lines: Line[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [contingencyLineId, setContingencyLineId] = useState("");
  const router = useRouter();
  const { toast } = useToast();
  const amountCents = Number.isFinite(toCents(amount)) ? toCents(amount) : 0;
  const net = amountCents > 0 ? 0 : Number.NaN;
  const contingency = useMemo(
    () =>
      lines
        .filter((line) => line.metadata?.is_contingency === true)
        .map((line) => {
          const movement = transfers
            .filter((transfer) => transfer.status === "approved")
            .flatMap((transfer) => transfer.lines)
            .filter((item) => item.budget_line_id === line.id)
            .reduce((sum, item) => sum + item.amount_cents, 0);
          return {
            ...line,
            movement,
            remaining: Number(line.amount_cents ?? 0) + movement,
          };
        }),
    [lines, transfers],
  );
  const create = () =>
    startTransition(async () => {
      try {
        unwrapAction(
          await createBudgetTransferAction(projectId, {
            project_id: projectId,
            reason,
            lines: [
              { budget_line_id: fromId, amount_cents: -amountCents },
              { budget_line_id: toId, amount_cents: amountCents },
            ],
          }),
        );
        toast({ title: "Transfer submitted for approval" });
        setOpen(false);
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to create transfer",
          description: (error as Error).message,
        });
      }
    });
  const approve = (id: string) =>
    startTransition(async () => {
      try {
        unwrapAction(await approveBudgetTransferAction(projectId, id));
        toast({ title: "Budget transfer approved" });
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to approve transfer",
          description: (error as Error).message,
        });
      }
    });
  const markContingency = () =>
    startTransition(async () => {
      try {
        unwrapAction(
          await setBudgetLineContingencyAction(
            projectId,
            contingencyLineId,
            true,
          ),
        );
        toast({ title: "Contingency line updated" });
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to update contingency",
          description: (error as Error).message,
        });
      }
    });
  return (
    <div className="space-y-4 border-t pt-4">
      <div className="flex items-end gap-2">
        <div className="min-w-64">
          <Label>Contingency budget line</Label>
          <Select value={contingencyLineId} onValueChange={setContingencyLineId}>
            <SelectTrigger><SelectValue placeholder="Mark a line as contingency" /></SelectTrigger>
            <SelectContent>
              {lines.filter((line) => line.metadata?.is_contingency !== true).map((line) => (
                <SelectItem key={line.id} value={line.id}>{line.description}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" variant="outline" disabled={!contingencyLineId || pending} onClick={markContingency}>
          Mark contingency
        </Button>
      </div>
      {contingency.length > 0 ? (
        <div className="grid gap-px border bg-border sm:grid-cols-4">
          {contingency.map((line) => (
            <div key={line.id} className="bg-background p-3">
              <div className="text-[11px] uppercase text-muted-foreground">
                Contingency · {line.description}
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {money(line.remaining)}
              </div>
              <div className="text-xs text-muted-foreground">
                Original {money(Number(line.amount_cents ?? 0))} · Net transfers{" "}
                {money(line.movement)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-end justify-between">
        <div>
          <h3 className="text-sm font-semibold">Budget transfers</h3>
          <p className="text-xs text-muted-foreground">
            Move budget between lines without changing the project total or EAC.
          </p>
        </div>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button size="sm">New transfer</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>New budget transfer</SheetTitle>
              <SheetDescription>
                Choose source and destination lines. The transfer must net to
                zero.
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 p-4">
              <div>
                <Label>Reason</Label>
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <div>
                <Label>From</Label>
                <Select value={fromId} onValueChange={setFromId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select source line" />
                  </SelectTrigger>
                  <SelectContent>
                    {lines.map((line) => (
                      <SelectItem key={line.id} value={line.id}>
                        {line.cost_code?.code
                          ? `${line.cost_code.code} · `
                          : ""}
                        {line.description}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>To</Label>
                <Select value={toId} onValueChange={setToId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select destination line" />
                  </SelectTrigger>
                  <SelectContent>
                    {lines
                      .filter((line) => line.id !== fromId)
                      .map((line) => (
                        <SelectItem key={line.id} value={line.id}>
                          {line.cost_code?.code
                            ? `${line.cost_code.code} · `
                            : ""}
                          {line.description}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Amount ($)</Label>
                <Input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="flex justify-between border p-3 text-sm">
                <span>Net change</span>
                <span className="tabular-nums">
                  {Number.isNaN(net) ? "Enter a valid amount" : money(net)}
                </span>
              </div>
              <Button
                className="w-full"
                disabled={
                  pending ||
                  !reason.trim() ||
                  !fromId ||
                  !toId ||
                  amountCents <= 0
                }
                onClick={create}
              >
                {pending ? "Submitting…" : "Submit for approval"}
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
      <div className="border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Movement</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {transfers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-20 text-center text-muted-foreground"
                >
                  No transfers yet.
                </TableCell>
              </TableRow>
            ) : (
              transfers.map((transfer) => (
                <TableRow key={transfer.id}>
                  <TableCell className="tabular-nums">
                    {transfer.transfer_number}
                  </TableCell>
                  <TableCell>
                    {new Date(transfer.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>{transfer.reason}</TableCell>
                  <TableCell className="text-xs">
                    {transfer.lines
                      .map(
                        (line) =>
                          `${line.amount_cents < 0 ? "From" : "To"} ${line.budget_line?.description ?? "line"} ${money(Math.abs(line.amount_cents))}`,
                      )
                      .join(" · ")}
                  </TableCell>
                  <TableCell className="capitalize">
                    {transfer.status.replaceAll("_", " ")}
                  </TableCell>
                  <TableCell className="text-right">
                    {transfer.status === "pending_approval" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => approve(transfer.id)}
                      >
                        Approve
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
