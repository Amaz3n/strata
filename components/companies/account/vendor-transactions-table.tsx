"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import type {
  VendorLedgerEntry,
  VendorLedgerEntryKind,
  VendorLedgerFacets,
  VendorLedgerPagination,
} from "@/lib/services/vendor-account";
import { deleteProjectVendorBillAction } from "@/app/(app)/projects/[id]/payables/actions";
import { unwrapAction } from "@/lib/action-result";
import {
  CostInboxDetailOverlays,
  type CostInboxOverlayTarget,
} from "@/components/cost-inbox/cost-inbox-detail-overlays";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown, Filter, MoreHorizontal, Plus, X } from "@/components/icons";
import { useToast } from "@/hooks/use-toast";
import { formatDate, formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<VendorLedgerEntryKind, string> = {
  bill: "Bill",
  vendor_credit: "Credit",
  payment: "Payment",
  expense: "Expense",
};

const KIND_OPTIONS: VendorLedgerEntryKind[] = ["bill", "payment", "vendor_credit", "expense"];

function statusTone(entry: VendorLedgerEntry) {
  if (entry.is_draft) return "text-muted-foreground";
  switch (entry.status) {
    case "paid":
    case "succeeded":
    case "completed":
    case "approved":
      return "text-success";
    case "rejected":
      return "text-destructive";
    case "pending":
    case "partial":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

export function VendorTransactionsTable({
  companyId,
  companyName,
  entries,
  pagination,
  facets,
  truncated,
  canViewBills,
  costCodesEnabledByProject,
}: {
  companyId: string;
  companyName: string;
  entries: VendorLedgerEntry[];
  pagination: VendorLedgerPagination;
  facets: VendorLedgerFacets;
  truncated: boolean;
  canViewBills: boolean;
  costCodesEnabledByProject: Record<string, boolean>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [overlayTarget, setOverlayTarget] = useState<CostInboxOverlayTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VendorLedgerEntry | null>(null);

  const selectedKinds = useMemo(
    () => new Set((searchParams.get("kind") ?? "").split(",").filter(Boolean)),
    [searchParams],
  );
  const selectedStatuses = useMemo(
    () => new Set((searchParams.get("status") ?? "").split(",").filter(Boolean)),
    [searchParams],
  );
  const selectedProject = searchParams.get("project") ?? "";
  const overdueOnly = searchParams.get("filter") === "overdue";
  const fromDate = searchParams.get("from") ?? "";
  const toDate = searchParams.get("to") ?? "";

  const activeFilterCount =
    selectedKinds.size +
    selectedStatuses.size +
    (selectedProject ? 1 : 0) +
    (overdueOnly ? 1 : 0) +
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0);

  /** Every filter and page lives in the URL, so a view is shareable and back works. */
  const navigate = useCallback(
    (next: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      if (!("page" in next)) params.delete("page");
      const query = params.toString();
      router.replace(query ? `?${query}` : "?", { scroll: false });
    },
    [router, searchParams],
  );

  const toggleInSet = (key: string, current: Set<string>, value: string) => {
    const next = new Set(current);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    navigate({ [key]: next.size > 0 ? Array.from(next).join(",") : null });
  };

  const openEntry = (entry: VendorLedgerEntry) => {
    if (!entry.project_id) return;
    setOverlayTarget({
      kind: entry.kind === "expense" ? "expense" : "vendor_bill",
      id: entry.target_id,
      projectId: entry.project_id,
      costCodesEnabled: costCodesEnabledByProject[entry.project_id] ?? true,
    });
  };

  const confirmDelete = () => {
    const entry = deleteTarget;
    if (!entry?.project_id) return;
    startTransition(async () => {
      try {
        unwrapAction(await deleteProjectVendorBillAction(entry.project_id!, entry.source_id));
        toast({ title: "Payable deleted" });
        setDeleteTarget(null);
        router.refresh();
      } catch (error) {
        toast({ title: "Unable to delete", description: (error as Error).message });
      }
    });
  };

  if (!canViewBills) {
    return (
      <div className="px-4 py-16 text-center text-sm text-muted-foreground sm:px-6">
        Transaction history requires payables access.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar: what you are looking at, and how to narrow it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2.5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8">
                <Filter className="mr-1.5 h-3.5 w-3.5" />
                Filters
                {activeFilterCount > 0 ? (
                  <span className="ml-1.5 border bg-muted px-1 font-mono text-[11px] tabular-nums">
                    {activeFilterCount}
                  </span>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-0">
              <div className="max-h-[26rem] overflow-y-auto">
                <div className="border-b px-3 py-2.5">
                  <div className="microlabel mb-2">Type</div>
                  <div className="space-y-1.5">
                    {KIND_OPTIONS.map((kind) => (
                      <label key={kind} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={selectedKinds.has(kind)}
                          onCheckedChange={() => toggleInSet("kind", selectedKinds, kind)}
                        />
                        {KIND_LABEL[kind]}
                      </label>
                    ))}
                  </div>
                </div>
                {facets.statuses.length > 0 ? (
                  <div className="border-b px-3 py-2.5">
                    <div className="microlabel mb-2">Status</div>
                    <div className="space-y-1.5">
                      {facets.statuses.map((status) => (
                        <label key={status} className="flex items-center gap-2 text-sm capitalize">
                          <Checkbox
                            checked={selectedStatuses.has(status)}
                            onCheckedChange={() => toggleInSet("status", selectedStatuses, status)}
                          />
                          {status}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
                {facets.projects.length > 0 ? (
                  <div className="border-b px-3 py-2.5">
                    <div className="microlabel mb-2">Project</div>
                    <div className="space-y-1.5">
                      {facets.projects.map((project) => (
                        <label key={project.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={selectedProject === project.id}
                            onCheckedChange={() =>
                              navigate({
                                project: selectedProject === project.id ? null : project.id,
                              })
                            }
                          />
                          <span className="truncate">{project.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="space-y-2 px-3 py-2.5">
                  <div className="microlabel">Date</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={fromDate}
                      onChange={(event) => navigate({ from: event.target.value })}
                      className="h-8 w-full border bg-background px-2 text-xs"
                      aria-label="From date"
                    />
                    <input
                      type="date"
                      value={toDate}
                      onChange={(event) => navigate({ to: event.target.value })}
                      className="h-8 w-full border bg-background px-2 text-xs"
                      aria-label="To date"
                    />
                  </div>
                  <label className="flex items-center gap-2 pt-1 text-sm">
                    <Checkbox
                      checked={overdueOnly}
                      onCheckedChange={() => navigate({ filter: overdueOnly ? null : "overdue" })}
                    />
                    Overdue bills only
                  </label>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {activeFilterCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground"
              onClick={() =>
                navigate({ kind: null, status: null, project: null, filter: null, from: null, to: null })
              }
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Clear
            </Button>
          ) : null}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="h-8">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New
              <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem asChild>
              <Link href={`/payables?new=1&vendor=${companyId}`}>Bill</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/payables?tab=pay&q=${encodeURIComponent(companyName)}`}>Payment</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Register */}
      <div className="min-h-0 flex-1 overflow-auto">
        {/*
          Proportional widths, not one flexible column. Sizing every column but
          Reference in px makes Reference absorb all the leftover width, which
          on a wide screen leaves it hoarding hundreds of pixels beside tight
          neighbours. Percentages keep every gap in the same ratio at any width.
        */}
        {entries.length > 0 ? (
          <Table className="min-w-[1000px] table-fixed">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="w-[9%] pl-4 sm:pl-6">Date</TableHead>
                <TableHead className="w-[7%]">Type</TableHead>
                <TableHead className="w-[28%]">Reference</TableHead>
                <TableHead className="w-[19%]">Project</TableHead>
                <TableHead className="w-[10%]">Status</TableHead>
                <TableHead className="w-[12%] text-right">Amount</TableHead>
                <TableHead className="w-[12%] text-right">Balance</TableHead>
                <TableHead className="w-[3%] pr-4 sm:pr-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const openable = Boolean(entry.project_id) && entry.kind !== "payment";
                return (
                  <TableRow
                    key={entry.id}
                    className={cn("group/row", openable && "cursor-pointer")}
                    onClick={openable ? () => openEntry(entry) : undefined}
                  >
                    <TableCell className="whitespace-nowrap pl-4 text-muted-foreground sm:pl-6">
                      {formatDate(entry.date)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {KIND_LABEL[entry.kind]}
                    </TableCell>
                    <TableCell>
                      <span className="block truncate font-medium">
                        {entry.reference || entry.commitment_title || "—"}
                      </span>
                      {entry.memo ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {entry.memo}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {entry.project_id ? (
                        <Link
                          href={`/projects/${entry.project_id}`}
                          onClick={(event) => event.stopPropagation()}
                          className="block truncate text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                        >
                          {entry.project_name ?? "Project"}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      <span className={cn("capitalize", statusTone(entry))}>
                        {entry.is_draft ? "draft" : (entry.status ?? "—")}
                      </span>
                      {/* The due column is gone; lateness still has to be visible. */}
                      {entry.days_past_due > 0 ? (
                        <span className="block text-destructive">
                          {entry.days_past_due}d late
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "whitespace-nowrap text-right font-mono tabular-nums",
                        entry.amount_cents < 0 ? "text-success" : "text-foreground",
                      )}
                    >
                      {formatMoneyFromCents(entry.amount_cents)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums text-muted-foreground">
                      {entry.balance_cents === null
                        ? "—"
                        : formatMoneyFromCents(entry.balance_cents)}
                    </TableCell>
                    <TableCell className="pr-4 sm:pr-6">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <MoreHorizontal className="size-4" />
                            <span className="sr-only">
                              Actions for {entry.reference || KIND_LABEL[entry.kind]}
                            </span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="w-56"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {openable ? (
                            <DropdownMenuItem onSelect={() => openEntry(entry)}>
                              Open
                            </DropdownMenuItem>
                          ) : null}
                          {entry.attachment_file_id ? (
                            <DropdownMenuItem asChild>
                              <a
                                href={`/api/files/${entry.attachment_file_id}/raw`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Download document
                              </a>
                            </DropdownMenuItem>
                          ) : null}
                          {entry.kind === "bill" || entry.kind === "vendor_credit" ? (
                            <>
                              <DropdownMenuSeparator />
                              {entry.delete_blocked_reason ? (
                                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                  Cannot be deleted — {entry.delete_blocked_reason}.
                                </p>
                              ) : (
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onSelect={() => setDeleteTarget(entry)}
                                >
                                  Delete
                                </DropdownMenuItem>
                              )}
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="px-4 py-16 text-center sm:px-6">
            <p className="text-sm text-muted-foreground">
              {activeFilterCount > 0
                ? "No transactions match these filters."
                : "No transactions with this vendor yet."}
            </p>
          </div>
        )}
      </div>

      {/* Footer: scale of the register, and the way through it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-2 text-xs sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
          <span className="tabular-nums">
            {pagination.total} {pagination.total === 1 ? "transaction" : "transactions"} · page{" "}
            {pagination.page} of {pagination.pageCount}
          </span>
          {truncated ? (
            <span title="Composed from the most recent 500 records of each type.">
              Older records are not included
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={pagination.page <= 1}
            onClick={() => navigate({ page: String(pagination.page - 1) })}
          >
            Previous
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={pagination.page >= pagination.pageCount}
            onClick={() => navigate({ page: String(pagination.page + 1) })}
          >
            Next
          </Button>
        </div>
      </div>

      <CostInboxDetailOverlays
        costCodesEnabled
        target={overlayTarget}
        onClose={() => setOverlayTarget(null)}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this payable?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.reference ? `${deleteTarget.reference} ` : ""}will be removed from{" "}
              {companyName}&apos;s account. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
