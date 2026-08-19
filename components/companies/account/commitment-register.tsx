"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import type {
  CommitmentRegisterExceptions,
  CommitmentRegisterFacets,
  CommitmentRegisterFlag,
  CommitmentRegisterPagination,
  CommitmentRegisterRollup,
  CommitmentSummary,
  CommitmentType,
} from "@/lib/services/commitments";
import type { CostCode, Project } from "@/lib/types";
import { createProjectCommitmentWithLineAction } from "@/app/(app)/projects/[id]/commitments/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { Textarea } from "@/components/ui/textarea";
import { Check, ChevronsUpDown, Filter, MoreHorizontal, Plus, X } from "@/components/icons";
import { useToast } from "@/hooks/use-toast";
import { unwrapAction } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import { formatDate, formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import {
  commitmentFlagClass,
  commitmentFlags,
  commitmentLifecycleMeta,
  commitmentTypeLabel,
  commitmentTypeShortLabel,
} from "@/components/companies/account/commitment-status";
import { CommitmentDetailSheet } from "@/components/companies/account/commitment-detail-sheet";

const TYPE_OPTIONS: CommitmentType[] = ["subcontract", "purchase_order"];

const EXCEPTION_LABEL: Record<CommitmentRegisterFlag, string> = {
  over_billed: "over-billed",
  awaiting_execution: "not executed",
  pending_change_orders: "pending change orders",
};

const EXCEPTION_TONE: Record<CommitmentRegisterFlag, string> = {
  over_billed: "text-destructive",
  awaiting_execution: "text-warning",
  pending_change_orders: "text-warning",
};

const EXCEPTION_ORDER: CommitmentRegisterFlag[] = [
  "over_billed",
  "awaiting_execution",
  "pending_change_orders",
];

/** Only an approved (or complete) commitment can carry a signed agreement. */
const isExecutable = (commitment: CommitmentSummary) => {
  const status = String(commitment.status).toLowerCase();
  return status === "approved" || status === "complete";
};

const EMPTY_FORM = {
  project_id: "",
  cost_code_id: "none",
  title: "",
  total_dollars: "",
  status: "draft",
  contract_number: "",
  retainage_percent: "",
  scope: "",
  terms: "",
};

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="microlabel">{label}</div>
      <div className={cn("mt-0.5 font-mono text-sm tabular-nums", tone ?? "text-foreground")}>
        {value}
      </div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function CommitmentRegister({
  companyId,
  companyName,
  rows,
  rollup,
  exceptions,
  pagination,
  facets,
  truncated,
  projects,
  costCodes,
  canEdit,
}: {
  companyId: string;
  companyName: string;
  rows: CommitmentSummary[];
  rollup: CommitmentRegisterRollup;
  exceptions: CommitmentRegisterExceptions;
  pagination: CommitmentRegisterPagination;
  facets: CommitmentRegisterFacets;
  truncated: boolean;
  projects: Project[];
  costCodes: CostCode[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<CommitmentSummary | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const selectedTypes = useMemo(
    () => new Set((searchParams.get("type") ?? "").split(",").filter(Boolean)),
    [searchParams],
  );
  const selectedStatuses = useMemo(
    () => new Set((searchParams.get("status") ?? "").split(",").filter(Boolean)),
    [searchParams],
  );
  const selectedProject = searchParams.get("project") ?? "";
  const activeFlag = (searchParams.get("flag") ?? "") as CommitmentRegisterFlag | "";

  const activeFilterCount =
    selectedTypes.size + selectedStatuses.size + (selectedProject ? 1 : 0) + (activeFlag ? 1 : 0);

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

  const openDetail = (commitment: CommitmentSummary) => {
    setSelected(commitment);
    setDetailOpen(true);
  };

  const selectedProjectName = projects.find((project) => project.id === form.project_id)?.name;

  const submit = () => {
    if (!form.project_id) {
      toast({ title: "Project required", description: "Choose the project this commitment is on." });
      return;
    }
    if (form.title.trim().length < 2) {
      toast({ title: "Title required", description: "Enter a commitment title." });
      return;
    }
    const totalDollars = Number(form.total_dollars);
    if (!Number.isFinite(totalDollars) || totalDollars <= 0) {
      toast({ title: "Invalid total", description: "Enter a valid amount." });
      return;
    }
    if (costCodes.length > 0 && form.cost_code_id === "none") {
      toast({
        title: "Cost code required",
        description: "The commitment line needs a cost code to reach the budget.",
      });
      return;
    }
    if (form.scope.trim().length < 2) {
      toast({ title: "Scope required", description: "Describe the work this commitment buys." });
      return;
    }
    const retainage = form.retainage_percent.trim() ? Number(form.retainage_percent) : null;
    if (retainage != null && (!Number.isFinite(retainage) || retainage < 0 || retainage > 100)) {
      toast({ title: "Invalid retainage", description: "Enter a percentage from 0 to 100." });
      return;
    }

    startTransition(async () => {
      try {
        const totalCents = Math.round(totalDollars * 100);
        unwrapAction(
          await createProjectCommitmentWithLineAction(form.project_id, {
            commitment: {
              company_id: companyId,
              commitment_type: "subcontract",
              title: form.title.trim(),
              total_cents: totalCents,
              status: form.status,
              contract_number: form.contract_number.trim() || null,
              retainage_percent: retainage,
              scope: form.scope.trim(),
              terms: form.terms.trim() || null,
            },
            line: {
              cost_code_id: form.cost_code_id === "none" ? null : form.cost_code_id,
              description: form.scope.trim(),
              quantity: 1,
              unit: "LS",
              unit_cost_cents: totalCents,
              retainage_percent: retainage,
            },
          }),
        );
        toast({ title: "Commitment created" });
        setCreateOpen(false);
        setForm(EMPTY_FORM);
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to create commitment",
          description: (error as Error).message,
        });
      }
    });
  };

  const newButton = canEdit ? (
    <Button size="sm" className="h-8" onClick={() => setCreateOpen(true)}>
      <Plus className="mr-1.5 h-3.5 w-3.5" />
      New commitment
    </Button>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The position across everything the filters select. */}
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3 border-b px-4 py-3 sm:px-6">
        <Figure label="Committed" value={formatMoneyFromCents(rollup.committed_cents)} />
        <Figure
          label="Billed"
          value={formatMoneyFromCents(rollup.billed_cents)}
          hint={
            rollup.pending_billed_cents > 0
              ? `${formatMoneyFromCents(rollup.pending_billed_cents)} awaiting approval`
              : undefined
          }
        />
        <Figure
          label="Paid"
          value={formatMoneyFromCents(rollup.paid_cents)}
          tone="text-muted-foreground"
        />
        {rollup.retainage_held_cents > 0 ? (
          <Figure
            label="Retainage held"
            value={formatMoneyFromCents(rollup.retainage_held_cents)}
            tone="text-muted-foreground"
          />
        ) : null}
        <Figure
          label={rollup.remaining_cents < 0 ? "Over-billed" : "Remaining"}
          value={formatMoneyFromCents(Math.abs(rollup.remaining_cents))}
          tone={rollup.remaining_cents < 0 ? "text-destructive" : undefined}
        />
        {rollup.pending_change_orders_cents !== 0 ? (
          <Figure
            label="Pending COs"
            value={formatMoneyFromCents(rollup.pending_change_orders_cents)}
            tone="text-warning"
            hint="not yet committed"
          />
        ) : null}
      </div>

      {/* Toolbar: how to narrow the register, and the exceptions worth jumping to. */}
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
                {facets.types.length > 1 ? (
                  <div className="border-b px-3 py-2.5">
                    <div className="microlabel mb-2">Type</div>
                    <div className="space-y-1.5">
                      {TYPE_OPTIONS.filter((type) => facets.types.includes(type)).map((type) => (
                        <label key={type} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={selectedTypes.has(type)}
                            onCheckedChange={() => toggleInSet("type", selectedTypes, type)}
                          />
                          {commitmentTypeLabel(type)}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
                {facets.statuses.length > 0 ? (
                  <div className="border-b px-3 py-2.5">
                    <div className="microlabel mb-2">Status</div>
                    <div className="space-y-1.5">
                      {facets.statuses.map((status) => (
                        <label key={status} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={selectedStatuses.has(status)}
                            onCheckedChange={() => toggleInSet("status", selectedStatuses, status)}
                          />
                          {commitmentLifecycleMeta(status).label}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
                {facets.projects.length > 0 ? (
                  <div className="px-3 py-2.5">
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
              </div>
            </PopoverContent>
          </Popover>

          {EXCEPTION_ORDER.map((flag) => {
            const count = exceptions[flag];
            if (count === 0) return null;
            const active = activeFlag === flag;
            return (
              <button
                key={flag}
                type="button"
                onClick={() => navigate({ flag: active ? null : flag })}
                className={cn(
                  "inline-flex h-8 items-center border px-2 text-xs font-medium transition-colors",
                  active
                    ? "border-foreground bg-foreground text-background"
                    : cn("hover:bg-muted", EXCEPTION_TONE[flag]),
                )}
                aria-pressed={active}
              >
                <span className="font-mono tabular-nums">{count}</span>
                <span className="ml-1.5">{EXCEPTION_LABEL[flag]}</span>
              </button>
            );
          })}

          {activeFilterCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground"
              onClick={() => navigate({ type: null, status: null, project: null, flag: null })}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Clear
            </Button>
          ) : null}
        </div>

        {newButton}
      </div>

      {/* Register */}
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length > 0 ? (
          <Table className="min-w-[1080px] table-fixed">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="w-[26%] pl-4 sm:pl-6">Commitment</TableHead>
                <TableHead className="w-[16%]">Project</TableHead>
                <TableHead className="w-[11%]">Status</TableHead>
                <TableHead className="w-[11%] text-right">Original</TableHead>
                <TableHead className="w-[10%] text-right">Changes</TableHead>
                <TableHead className="w-[11%] text-right">Revised</TableHead>
                <TableHead className="w-[11%] text-right">Billed</TableHead>
                <TableHead className="w-[11%] text-right">Remaining</TableHead>
                <TableHead className="w-[3%] pr-4 sm:pr-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((commitment) => {
                const lifecycle = commitmentLifecycleMeta(commitment.status);
                const flags = commitmentFlags(commitment);
                const remaining = commitment.remaining_cents ?? 0;
                const approvedChangeOrders = commitment.approved_change_orders_cents ?? 0;
                return (
                  <TableRow
                    key={commitment.id}
                    className="group/row cursor-pointer"
                    onClick={() => openDetail(commitment)}
                  >
                    <TableCell className="pl-4 sm:pl-6">
                      <span className="flex items-baseline gap-2">
                        <span className="shrink-0 border px-1 py-0 font-mono text-[10px] uppercase text-muted-foreground">
                          {commitmentTypeShortLabel(commitment.commitment_type)}
                        </span>
                        <span className="min-w-0 truncate font-medium">{commitment.title}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {commitment.contract_number
                          ? commitment.contract_number
                          : formatDate(commitment.created_at)}
                        {commitment.executed_at ? ` · executed ${formatDate(commitment.executed_at)}` : ""}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/projects/${commitment.project_id}`}
                        onClick={(event) => event.stopPropagation()}
                        className="block truncate text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        {commitment.project_name ?? "Project"}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center border px-1.5 py-0 text-[10px] font-medium",
                          lifecycle.className,
                        )}
                      >
                        {lifecycle.label}
                      </span>
                      {flags.length > 0 ? (
                        <span
                          className={cn(
                            "mt-1 block truncate text-[11px] font-medium",
                            commitmentFlagClass(flags[0].tone),
                          )}
                        >
                          {flags[0].label}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums text-muted-foreground">
                      {formatMoneyFromCents(commitment.total_cents ?? 0)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "whitespace-nowrap text-right font-mono tabular-nums",
                        approvedChangeOrders === 0 && "text-muted-foreground",
                      )}
                    >
                      {approvedChangeOrders === 0 ? "—" : formatMoneyFromCents(approvedChangeOrders)}
                      {(commitment.pending_change_orders_cents ?? 0) !== 0 ? (
                        <span className="block text-[11px] text-warning">
                          {formatMoneyFromCents(commitment.pending_change_orders_cents ?? 0)} pending
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono font-medium tabular-nums">
                      {formatMoneyFromCents(commitment.revised_total_cents ?? 0)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums text-muted-foreground">
                      {formatMoneyFromCents(commitment.billed_cents ?? 0)}
                      {(commitment.pending_billed_cents ?? 0) > 0 ? (
                        <span className="block text-[11px] text-warning">
                          {formatMoneyFromCents(commitment.pending_billed_cents ?? 0)} pending
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "whitespace-nowrap text-right font-mono font-medium tabular-nums",
                        remaining < 0 && "text-destructive",
                      )}
                    >
                      {formatMoneyFromCents(remaining)}
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
                            <span className="sr-only">Actions for {commitment.title}</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="w-52"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <DropdownMenuItem onSelect={() => openDetail(commitment)}>
                            Open
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/projects/${commitment.project_id}/financials/budget`}>
                              Open in budget
                            </Link>
                          </DropdownMenuItem>
                          {canEdit && !commitment.executed_at && isExecutable(commitment) ? (
                            <>
                              <DropdownMenuSeparator />
                              {/* Both routes open in the sheet, where the position is in view. */}
                              <DropdownMenuItem onSelect={() => openDetail(commitment)}>
                                Execute…
                              </DropdownMenuItem>
                            </>
                          ) : null}
                          {commitment.executed_file_id ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem asChild>
                                <a
                                  href={`/api/files/${commitment.executed_file_id}/raw`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Signed agreement
                                </a>
                              </DropdownMenuItem>
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
                ? "No commitments match these filters."
                : `No commitments with ${companyName} yet.`}
            </p>
            {activeFilterCount > 0 ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-3 h-8"
                onClick={() => navigate({ type: null, status: null, project: null, flag: null })}
              >
                Clear filters
              </Button>
            ) : (
              <div className="mt-3 flex justify-center">{newButton}</div>
            )}
          </div>
        )}
      </div>

      {/* Footer: scale of the register, and the way through it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-2 text-xs sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
          <span className="tabular-nums">
            {pagination.total} {pagination.total === 1 ? "commitment" : "commitments"} · page{" "}
            {pagination.page} of {pagination.pageCount}
          </span>
          {truncated ? (
            <span title="Composed from the 500 most recent commitments.">
              Older commitments are not included
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

      <CommitmentDetailSheet
        commitment={selected}
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) setSelected(null);
        }}
        canEdit={canEdit}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New commitment</DialogTitle>
            <DialogDescription>
              A subcontract with {companyName}. It lands on the project&apos;s budget, where lines,
              change orders and execution are managed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Project</Label>
              <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={projectPickerOpen}
                    className="w-full justify-between font-normal"
                  >
                    <span className={cn("truncate", !selectedProjectName && "text-muted-foreground")}>
                      {selectedProjectName ?? "Select project"}
                    </span>
                    <ChevronsUpDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command>
                    <CommandInput placeholder="Search projects…" />
                    <CommandList className="max-h-64 overflow-y-auto">
                      <CommandEmpty>No projects found.</CommandEmpty>
                      <CommandGroup>
                        {projects.map((project) => (
                          <CommandItem
                            key={project.id}
                            value={project.name}
                            onSelect={() => {
                              setForm((prev) => ({ ...prev, project_id: project.id }));
                              setProjectPickerOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 size-3.5",
                                form.project_id === project.id ? "opacity-100" : "opacity-0",
                              )}
                            />
                            <span className="truncate">{project.name}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Cost code</Label>
                <Select
                  value={form.cost_code_id}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, cost_code_id: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select cost code" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {costCodes.length > 0 ? "Select cost code" : "Uncoded"}
                    </SelectItem>
                    {costCodes.map((code) => (
                      <SelectItem key={code.id} value={code.id}>
                        {code.code ? `${code.code} - ${code.name}` : code.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                  </SelectContent>
                </Select>
                {form.status === "approved" ? (
                  <p className="text-xs text-muted-foreground">
                    Approving commits the money and runs the prequalification check.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={form.title}
                  onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                  placeholder="Plumbing rough-in"
                />
              </div>
              <div className="space-y-2">
                <Label>Commitment total</Label>
                <Input
                  value={form.total_dollars}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, total_dollars: event.target.value }))
                  }
                  placeholder="10000"
                  inputMode="decimal"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Commitment #</Label>
                <Input
                  value={form.contract_number}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, contract_number: event.target.value }))
                  }
                  placeholder="SUB-004"
                />
              </div>
              <div className="space-y-2">
                <Label>Retainage (%)</Label>
                <Input
                  value={form.retainage_percent}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, retainage_percent: event.target.value }))
                  }
                  placeholder="10"
                  inputMode="decimal"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Scope</Label>
              <Textarea
                value={form.scope}
                onChange={(event) => setForm((prev) => ({ ...prev, scope: event.target.value }))}
                placeholder="Describe the work covered by this commitment."
                className="min-h-[84px]"
              />
            </div>
            <div className="space-y-2">
              <Label>Terms</Label>
              <Textarea
                value={form.terms}
                onChange={(event) => setForm((prev) => ({ ...prev, terms: event.target.value }))}
                placeholder="Payment terms, inclusions, exclusions, or notes."
                className="min-h-[72px]"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button disabled={isPending} onClick={submit}>
                {isPending ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
