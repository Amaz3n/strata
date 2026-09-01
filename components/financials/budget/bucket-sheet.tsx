"use client";

import { useEffect, useState, useTransition, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, MoreHorizontal, Trash2 } from "lucide-react";

import type { CostCode } from "@/lib/types";
import type { CommitmentSummary } from "@/lib/services/commitments";
import type {
  BudgetBucketTransaction,
  VarianceAlert,
} from "@/lib/services/budgets";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { unwrapAction } from "@/lib/action-result";

import {
  acknowledgeVarianceAlertAction,
  fetchBudgetBucketTransactionsAction,
  setBudgetLineContingencyAction,
  updateCostCodeProgressAction,
} from "@/app/(app)/projects/[id]/financials/budget/actions";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CostCodeSelectItems } from "@/components/cost-codes/cost-code-select-items";

import {
  CommitmentStatusBadge,
  dollarsToCents,
  formatCurrency,
  type CostBucketDraft,
  type UnifiedBudgetRow,
} from "./shared";

const SOURCE_TYPE_LABELS: Record<string, string> = {
  vendor_bill_line: "Bill",
  project_expense: "Expense",
  project_expense_line: "Expense",
  time_entry: "Labor",
};

export function BudgetBucketSheet({
  projectId,
  bucket,
  open,
  onOpenChange,
  commitments,
  commitmentsLoading,
  changeOrders,
  changeOrdersLoading,
  alerts,
  costCodesEnabled,
  editable,
  onEditBucket,
  onCreateCommitment,
  onStartBidPackage,
  onEditCommitment,
  onCommitmentLines,
  onCommitmentFiles,
  onCommitmentSignature,
}: {
  projectId: string;
  bucket: UnifiedBudgetRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commitments: Array<
    CommitmentSummary & { allocated_cents: number; matching_line_count: number }
  >;
  commitmentsLoading: boolean;
  changeOrders: Array<{
    id: string;
    title: string;
    status: string;
    approved_at: string | null;
    amount_cents: number;
  }>;
  changeOrdersLoading: boolean;
  alerts: VarianceAlert[];
  costCodesEnabled: boolean;
  editable: boolean;
  onEditBucket: () => void;
  onCreateCommitment: () => void;
  onStartBidPackage: () => void;
  onEditCommitment: (commitment: CommitmentSummary) => void;
  onCommitmentLines: (commitment: CommitmentSummary) => void;
  onCommitmentFiles: (commitment: CommitmentSummary) => void;
  onCommitmentSignature: (commitment: CommitmentSummary) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [commitmentType, setCommitmentType] = useState<
    "all" | "purchase_order" | "subcontract"
  >("all");
  const [transactions, setTransactions] = useState<BudgetBucketTransaction[]>(
    [],
  );
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const visibleCommitments =
    commitmentType === "all"
      ? commitments
      : commitments.filter((item) => item.commitment_type === commitmentType);

  const hasCoAdjustment = (bucket?.coAdjustmentCents ?? 0) !== 0;
  const singleBudgetLine = bucket?.lines.length === 1 ? bucket.lines[0] : null;
  const isContingency = singleBudgetLine?.metadata.is_contingency === true;
  const bucketAlerts = alerts.filter(
    (alert) =>
      alert.status === "active" &&
      (costCodesEnabled
        ? alert.cost_code_id != null &&
          alert.cost_code_id === bucket?.costCodeId
        : alert.budget_line_id != null && alert.budget_line_id === bucket?.key),
  );

  // Load the cost transactions behind Actual whenever a bucket opens.
  useEffect(() => {
    if (!open || !bucket || bucket.key === "uncoded") {
      setTransactions([]);
      return;
    }
    let cancelled = false;
    setTransactionsLoading(true);
    fetchBudgetBucketTransactionsAction(
      projectId,
      costCodesEnabled ? bucket.costCodeId : bucket.key,
      costCodesEnabled ? "cost_code" : "budget_line",
    )
      .then((rows) => {
        if (!cancelled) setTransactions(rows);
      })
      .catch(() => {
        if (!cancelled) setTransactions([]);
      })
      .finally(() => {
        if (!cancelled) setTransactionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, bucket, costCodesEnabled, projectId]);

  const acknowledgeAlert = (
    alertId: string,
    status: "acknowledged" | "resolved",
  ) => {
    startTransition(async () => {
      try {
        unwrapAction(
          await acknowledgeVarianceAlertAction(projectId, alertId, status),
        );
        toast({
          title:
            status === "resolved" ? "Alert resolved" : "Alert acknowledged",
        });
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to update alert",
          description: (error as Error).message,
        });
      }
    });
  };

  const toggleContingency = () => {
    if (!singleBudgetLine) return;
    startTransition(async () => {
      try {
        unwrapAction(
          await setBudgetLineContingencyAction(
            projectId,
            singleBudgetLine.id,
            !isContingency,
          ),
        );
        toast({
          title: isContingency
            ? "Contingency designation removed"
            : "Marked as contingency",
        });
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to update contingency",
          description: (error as Error).message,
        });
      }
    });
  };

  // Remaining to buy measures against the CO-adjusted budget: an approved CO
  // that grows a line grows what there is left to procure.
  const remainingToBuyCents = Math.max(
    0,
    (bucket?.adjustedBudgetCents ?? 0) - (bucket?.committedCents ?? 0),
  );
  const toneClass =
    bucket?.status === "over"
      ? "text-destructive"
      : bucket?.status === "warning"
        ? "text-warning"
        : "";
  const transactionsTotal = transactions.reduce(
    (sum, txn) => sum + txn.cost_cents,
    0,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
        style={
          {
            animationDuration: "150ms",
            transitionDuration: "150ms",
          } as CSSProperties
        }
      >
        <div className="flex-1 overflow-y-auto px-4">
          <div className="pt-6 pb-4">
            <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
              {bucket?.name ?? "Cost code"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              {bucket?.code ? `${bucket.code}` : "Uncoded"}
              {bucket?.category ? ` • ${bucket.category}` : ""}
            </SheetDescription>
          </div>

          <div className="space-y-6 pb-6">
            {bucketAlerts.length > 0 && (
              <div className="space-y-2">
                {bucketAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="flex items-start gap-2 border border-warning/40 bg-warning/5 px-3 py-2 text-sm"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <div className="min-w-0 flex-1">
                      <span className="font-medium capitalize">
                        {alert.alert_type?.replaceAll("_", " ") ??
                          "Variance alert"}
                      </span>
                      {typeof alert.current_percent === "number" ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {alert.current_percent}%
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={isPending}
                        onClick={() =>
                          acknowledgeAlert(alert.id, "acknowledged")
                        }
                      >
                        Ack
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={isPending}
                        onClick={() => acknowledgeAlert(alert.id, "resolved")}
                      >
                        Resolve
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="grid gap-px border bg-border sm:grid-cols-2">
              <div className="border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Revised budget
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCurrency(bucket?.adjustedBudgetCents)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Base {formatCurrency(bucket?.budgetCents)} · Adjustments{" "}
                  {formatCurrency(bucket?.coAdjustmentCents)}
                </p>
              </div>
              <div className="bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Committed
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCurrency(bucket?.committedCents)}
                </p>
                <p
                  className={cn(
                    "mt-1 text-xs",
                    (bucket?.remainingCommitmentCents ?? 0) < 0
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {formatCurrency(bucket?.committedBilledCents ?? 0)} billed ·{" "}
                  {formatCurrency(bucket?.remainingCommitmentCents ?? 0)}{" "}
                  remaining
                </p>
              </div>
              <div className="bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Actual
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCurrency(bucket?.actualCents)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {bucket?.variancePercent ?? 0}% of budget spent
                </p>
              </div>
              <div className="bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Forecast final cost
                </p>
                <p
                  className={cn(
                    "mt-1 text-2xl font-semibold tabular-nums",
                    toneClass,
                  )}
                >
                  {formatCurrency(bucket?.eacCents)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatCurrency(bucket?.costToCompleteCents)} remaining to
                  complete
                </p>
              </div>
              <div className="bg-card p-4 sm:col-span-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Forecast variance
                </p>
                <p
                  className={cn(
                    "mt-1 text-2xl font-semibold tabular-nums",
                    (bucket?.varianceAtCompletionCents ?? 0) < 0
                      ? "text-destructive"
                      : "text-success",
                  )}
                >
                  {formatCurrency(bucket?.varianceAtCompletionCents)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Remaining to buy {formatCurrency(remainingToBuyCents)} ·
                  Exposure {formatCurrency(bucket?.exposureCents)}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold">Budget basis</h4>
                    {isContingency ? (
                      <Badge variant="outline">Contingency</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Base estimate and scope before approved adjustments.
                  </p>
                </div>
                {editable && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={onEditBucket}>
                        Edit budget
                      </DropdownMenuItem>
                      {singleBudgetLine ? (
                        <DropdownMenuItem
                          disabled={isPending}
                          onClick={toggleContingency}
                        >
                          {isContingency
                            ? "Remove contingency designation"
                            : "Mark as contingency"}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              <div className="border bg-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {bucket?.lines[0]?.description?.trim() ||
                        "No scope note yet"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {bucket?.lines.length && bucket.lines.length > 1
                        ? `This bucket rolls up ${bucket.lines.length} internal entries. Changing the amount rescales them proportionally.`
                        : "This note describes the planned scope for the cost code."}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Base budget
                    </p>
                    <p className="mt-1 text-lg font-semibold tabular-nums">
                      {formatCurrency(bucket?.budgetCents)}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {hasCoAdjustment && (
              <div className="space-y-3">
                <div>
                  <h4 className="text-sm font-semibold">Change orders</h4>
                  <p className="text-xs text-muted-foreground">
                    Approved change orders that moved this line&apos;s budget.
                  </p>
                </div>
                {changeOrdersLoading ? (
                  <div className="border border-dashed py-8 text-center text-sm text-muted-foreground">
                    Loading change orders…
                  </div>
                ) : changeOrders.length > 0 ? (
                  <div className="overflow-hidden border">
                    {changeOrders.map((co) => (
                      <Link
                        key={co.id}
                        href={`/projects/${projectId}/change-orders?co=${co.id}`}
                        className="flex items-center justify-between gap-3 border-b px-4 py-2.5 text-sm last:border-b-0 hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <span className="block truncate font-medium">
                            {co.title}
                          </span>
                          {co.approved_at && (
                            <span className="block text-xs text-muted-foreground">
                              Approved{" "}
                              {new Date(co.approved_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        <span
                          className={cn(
                            "shrink-0 tabular-nums",
                            co.amount_cents < 0
                              ? "text-destructive"
                              : "text-success",
                          )}
                        >
                          {co.amount_cents > 0 ? "+" : ""}
                          {formatCurrency(co.amount_cents)}
                        </span>
                      </Link>
                    ))}
                    <div className="flex items-center justify-between bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <span>Total adjustment</span>
                      <span className="tabular-nums">
                        {formatCurrency(bucket?.coAdjustmentCents ?? 0)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="border border-dashed px-4 py-3 text-xs text-muted-foreground">
                    This line&apos;s budget was adjusted by{" "}
                    {formatCurrency(bucket?.coAdjustmentCents ?? 0)} via change
                    orders or posted revisions.
                  </div>
                )}
              </div>
            )}

            {bucket?.costCodeId && editable && (
              <CostCodeProgressEditor
                projectId={projectId}
                costCodeId={bucket.costCodeId}
                percentComplete={bucket.percentComplete}
                estimateRemainingCents={bucket.costToCompleteCents}
              />
            )}

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold">Commitments</h4>
                  <p className="text-xs text-muted-foreground">
                    Subcontracts and POs bought against this cost code.
                  </p>
                </div>
                <Select
                  value={commitmentType}
                  onValueChange={(value) =>
                    setCommitmentType(value as typeof commitmentType)
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All commitments</SelectItem>
                    <SelectItem value="purchase_order">
                      Purchase orders
                    </SelectItem>
                    <SelectItem value="subcontract">Subcontracts</SelectItem>
                  </SelectContent>
                </Select>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={onCreateCommitment}>
                      New commitment
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onStartBidPackage}>
                      Start bid package
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {commitmentsLoading ? (
                <div className="border border-dashed py-10 text-center text-sm text-muted-foreground">
                  Loading commitments...
                </div>
              ) : visibleCommitments.length ? (
                <div className="overflow-hidden border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="px-4">Commitment</TableHead>
                        <TableHead className="hidden lg:table-cell px-4">
                          Type
                        </TableHead>
                        <TableHead className="hidden md:table-cell px-4">
                          Company
                        </TableHead>
                        <TableHead className="w-[120px] px-4 text-right">
                          Contract
                        </TableHead>
                        <TableHead className="w-[120px] px-4 text-right">
                          Allocated
                        </TableHead>
                        <TableHead className="w-[72px] px-2" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleCommitments.map((c) => (
                        <TableRow
                          key={c.id}
                          className="group h-[56px] hover:bg-muted/30"
                        >
                          <TableCell className="px-4">
                            <span className="block truncate text-sm font-medium">
                              {c.title}
                            </span>
                            <div className="mt-1 flex items-center gap-2">
                              <CommitmentStatusBadge status={c.status} />
                              <span className="block text-xs text-muted-foreground">
                                {c.matching_line_count}{" "}
                                {c.matching_line_count === 1
                                  ? "allocation"
                                  : "allocations"}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden px-4 lg:table-cell">
                            <Badge
                              variant="outline"
                              className="rounded-none capitalize"
                            >
                              {c.commitment_type === "purchase_order"
                                ? "PO"
                                : "Subcontract"}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden px-4 md:table-cell">
                            <span className="block truncate text-xs text-muted-foreground">
                              {c.company_name ?? "No company"}
                            </span>
                          </TableCell>
                          <TableCell className="px-4 text-right">
                            <span className="text-sm tabular-nums text-muted-foreground">
                              {formatCurrency(c.total_cents)}
                            </span>
                          </TableCell>
                          <TableCell className="px-4 text-right">
                            <span className="text-sm font-semibold tabular-nums">
                              {formatCurrency(c.allocated_cents)}
                            </span>
                          </TableCell>
                          <TableCell className="px-2">
                            <div className="flex items-center justify-end">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
                                  >
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() => onCommitmentLines(c)}
                                  >
                                    Allocation lines
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => onCommitmentFiles(c)}
                                  >
                                    Files
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => onCommitmentSignature(c)}
                                  >
                                    Send for signature
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => onEditCommitment(c)}
                                  >
                                    Edit commitment
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="border border-dashed py-10 text-center text-sm text-muted-foreground">
                  No commitments allocated to this cost code yet.
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold">Cost transactions</h4>
                  <p className="text-xs text-muted-foreground">
                    The bills, expenses, and labor behind the Actual number.
                  </p>
                </div>
                <Button variant="outline" size="sm" className="h-8" asChild>
                  <Link href={`/projects/${projectId}/financials/payables`}>
                    Open payables
                  </Link>
                </Button>
              </div>
              {transactionsLoading ? (
                <div className="border border-dashed py-8 text-center text-sm text-muted-foreground">
                  Loading transactions…
                </div>
              ) : transactions.length === 0 ? (
                <div className="border border-dashed py-8 text-center text-sm text-muted-foreground">
                  No posted costs on this line yet.
                </div>
              ) : (
                <div className="overflow-hidden border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="px-3">Source</TableHead>
                        <TableHead className="w-[90px] px-3">Type</TableHead>
                        <TableHead className="w-[100px] px-3">Date</TableHead>
                        <TableHead className="w-[110px] px-3 text-right">
                          Amount
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {transactions.map((txn) => (
                        <TableRow key={txn.id}>
                          <TableCell className="px-3">
                            <span className="block truncate text-sm">
                              {txn.label}
                            </span>
                            {txn.detail && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {txn.detail}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="px-3 text-xs text-muted-foreground">
                            {SOURCE_TYPE_LABELS[txn.source_type] ?? "Cost"}
                          </TableCell>
                          <TableCell className="px-3 text-xs tabular-nums text-muted-foreground">
                            {new Date(
                              `${txn.incurred_on}T00:00:00`,
                            ).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="px-3 text-right text-sm tabular-nums">
                            {formatCurrency(txn.cost_cents)}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/30 font-medium">
                        <TableCell
                          colSpan={3}
                          className="px-3 text-xs uppercase tracking-wide text-muted-foreground"
                        >
                          Total posted
                        </TableCell>
                        <TableCell className="px-3 text-right text-sm tabular-nums">
                          {formatCurrency(transactionsTotal)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-shrink-0 border-t bg-background p-4">
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="flex-1">
                  <MoreHorizontal className="h-4 w-4" />
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {editable && (
                  <DropdownMenuItem onClick={onEditBucket}>
                    Edit budget
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onCreateCommitment}>
                  New commitment
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function CostBucketEditorSheet({
  open,
  onOpenChange,
  draft,
  costCodes,
  costCodesEnabled,
  existingBucketKeys,
  onSave,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: CostBucketDraft | null;
  costCodes: CostCode[];
  costCodesEnabled: boolean;
  existingBucketKeys: string[];
  onSave: (draft: CostBucketDraft) => void;
  onRemove?: () => void;
}) {
  const [costCodeId, setCostCodeId] = useState("__uncoded__");
  const [description, setDescription] = useState("");
  const [amountDollars, setAmountDollars] = useState("");

  useEffect(() => {
    if (!open) return;
    setCostCodeId(draft?.costCodeId ?? "__uncoded__");
    setDescription(draft?.description ?? "");
    setAmountDollars(draft?.amountDollars ?? "");
  }, [draft, open]);

  const amountCents = dollarsToCents(amountDollars);
  const canSave =
    description.trim().length > 0 &&
    amountCents !== null &&
    amountCents >= 0 &&
    (!costCodesEnabled ||
      costCodeId === "__uncoded__" ||
      !existingBucketKeys.includes(costCodeId) ||
      draft?.costCodeId === costCodeId);

  const selectedCode =
    costCodeId === "__uncoded__"
      ? null
      : costCodes.find((code) => code.id === costCodeId);

  const submit = () => {
    if (!canSave) return;
    onSave({
      key: draft?.key ?? null,
      costCodeId:
        costCodesEnabled && costCodeId !== "__uncoded__" ? costCodeId : null,
      description: description.trim(),
      amountDollars: amountDollars.trim() || "0",
      lineIds: draft?.lineIds ?? [],
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
        style={
          {
            animationDuration: "150ms",
            transitionDuration: "150ms",
          } as CSSProperties
        }
      >
        <div className="flex-1 overflow-y-auto px-4">
          <div className="pt-6 pb-4">
            <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
              {costCodesEnabled
                ? draft?.key
                  ? "Edit cost bucket"
                  : "Add cost bucket"
                : draft?.key
                  ? "Edit budget line"
                  : "Add budget line"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              Set the budget amount and scope note for this project budget.
            </SheetDescription>
          </div>

          <div className="space-y-5 pb-6">
            {costCodesEnabled ? (
              <div className="space-y-2">
                <Label>Cost code</Label>
                <Select value={costCodeId} onValueChange={setCostCodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select cost code" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__uncoded__">Uncoded</SelectItem>
                    <CostCodeSelectItems costCodes={costCodes} />
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {selectedCode
                    ? selectedCode.name
                    : "Use uncoded only while roughing in the budget."}
                </p>
                {costCodeId !== "__uncoded__" &&
                existingBucketKeys.includes(costCodeId) &&
                draft?.costCodeId !== costCodeId ? (
                  <p className="text-xs text-destructive">
                    That cost code already has a bucket in this budget.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label>Scope note</Label>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="e.g., Rough plumbing labor and trim"
              />
            </div>

            <div className="space-y-2">
              <Label>Amount</Label>
              <Input
                value={amountDollars}
                onChange={(event) => setAmountDollars(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                Preview:{" "}
                {amountCents === null
                  ? "Invalid amount"
                  : formatCurrency(amountCents)}
              </p>
            </div>

            {(draft?.lineIds?.length ?? 0) > 1 ? (
              <p className="text-xs text-muted-foreground">
                This bucket rolls up {draft?.lineIds?.length} internal entries.
                Saving keeps them and rescales their amounts proportionally to
                the new total.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex-shrink-0 border-t bg-background p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              {draft?.lineIds?.length && onRemove ? (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    onRemove();
                    onOpenChange(false);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  {costCodesEnabled ? "Remove bucket" : "Remove line"}
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button className="flex-1" onClick={submit} disabled={!canSave}>
                {draft?.key
                  ? costCodesEnabled
                    ? "Save bucket"
                    : "Save line"
                  : costCodesEnabled
                    ? "Add bucket"
                    : "Add line"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CostCodeProgressEditor({
  projectId,
  costCodeId,
  percentComplete,
  estimateRemainingCents,
}: {
  projectId: string;
  costCodeId: string;
  percentComplete: number | null;
  estimateRemainingCents: number | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const [percent, setPercent] = useState(
    percentComplete != null ? percentComplete.toString() : "",
  );
  const [ctc, setCtc] = useState(
    estimateRemainingCents != null
      ? (estimateRemainingCents / 100).toFixed(2)
      : "",
  );

  useEffect(() => {
    setPercent(percentComplete != null ? percentComplete.toString() : "");
    setCtc(
      estimateRemainingCents != null
        ? (estimateRemainingCents / 100).toFixed(2)
        : "",
    );
  }, [percentComplete, estimateRemainingCents]);

  const submit = () => {
    startTransition(async () => {
      try {
        const p = percent.trim() ? parseFloat(percent) : null;
        const c = ctc.trim() ? Math.round(parseFloat(ctc) * 100) : null;
        unwrapAction(
          await updateCostCodeProgressAction(projectId, costCodeId, {
            percent_complete: p,
            estimate_remaining_cents: c,
          }),
        );
        toast({ title: "Progress updated" });
        router.refresh();
      } catch (error) {
        toast({
          title: "Failed to update progress",
          description: (error as Error).message,
        });
      }
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold">Forecast & Progress</h4>
          <p className="text-xs text-muted-foreground">
            Update completion percentage and CTC.
          </p>
        </div>
      </div>
      <div className="border bg-card p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Percent Complete (%)</Label>
            <Input
              type="number"
              min="0"
              max="100"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              placeholder="0-100"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Cost to Complete (CTC $)</Label>
            <Input
              type="number"
              min="0"
              value={ctc}
              onChange={(e) => setCtc(e.target.value)}
              placeholder="0.00"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={isPending}>
            {isPending ? "Saving..." : "Save Forecast"}
          </Button>
        </div>
      </div>
    </div>
  );
}
