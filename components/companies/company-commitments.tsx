"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { CostCode, Project } from "@/lib/types";
import type { CommitmentSummary } from "@/lib/services/commitments";
import {
  createCompanyCommitmentWithLineAction,
  listCompanyCommitmentCostCodesAction,
} from "@/app/(app)/companies/[id]/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Maximize2, Minimize2, Plus } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  EmptyState,
  Section,
  TABLE_EDGE,
  formatMoneyFromCents,
} from "@/components/companies/company-detail-ui";
import { commitmentStatusMeta } from "@/components/companies/commitment-status";
import { CommitmentDetailSheet } from "@/components/companies/commitment-detail-sheet";

import { unwrapAction } from "@/lib/action-result"

type CommitmentFilter = "active" | "previous" | "all";

const FILTERS: Array<[CommitmentFilter, string]> = [
  ["active", "Active"],
  ["previous", "Previous"],
  ["all", "All"],
];

export function CompanyCommitments({
  companyId,
  commitments,
  projects,
  canEdit,
  stagger = 1,
  fill = false,
  expanded = false,
  onToggleExpand,
  className,
}: {
  companyId: string;
  commitments: CommitmentSummary[];
  projects: Project[];
  canEdit: boolean;
  stagger?: number;
  fill?: boolean;
  expanded?: boolean;
  onToggleExpand?: (next: boolean) => void;
  className?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [filter, setFilter] = useState<CommitmentFilter>("active");
  const [selected, setSelected] = useState<CommitmentSummary | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [costCodesLoading, setCostCodesLoading] = useState(false);

  const [form, setForm] = useState({
    project_id: "none",
    cost_code_id: "none",
    title: "",
    total_dollars: "",
    status: "approved",
    contract_number: "",
    retainage_percent: "",
    scope: "",
    terms: "",
  });

  useEffect(() => {
    if (!createOpen || costCodes.length > 0 || costCodesLoading) return;
    let cancelled = false;
    setCostCodesLoading(true);
    listCompanyCommitmentCostCodesAction()
      .then((rows) => {
        if (!cancelled) setCostCodes(rows ?? []);
      })
      .catch((error) => {
        console.error(error);
        if (!cancelled) setCostCodes([]);
      })
      .finally(() => {
        if (!cancelled) setCostCodesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen, costCodes.length, costCodesLoading]);

  const { active, previous } = useMemo(() => {
    const active: CommitmentSummary[] = [];
    const previous: CommitmentSummary[] = [];
    for (const c of commitments) {
      (commitmentStatusMeta(c).isPrevious ? previous : active).push(c);
    }
    return { active, previous };
  }, [commitments]);

  // Filtering only applies when the panel is expanded; collapsed always shows active.
  const rows = useMemo(() => {
    const effective = expanded ? filter : "active";
    if (effective === "active") return active;
    if (effective === "previous") return previous;
    return [...active, ...previous];
  }, [expanded, filter, active, previous]);

  const totals = useMemo(() => {
    const committed = rows.reduce((sum, c) => sum + (c.revised_total_cents ?? c.total_cents ?? 0), 0);
    const billed = rows.reduce((sum, c) => sum + (c.billed_cents ?? 0), 0);
    return { committed, billed, remaining: Math.max(0, committed - billed) };
  }, [rows]);

  const openDetail = (commitment: CommitmentSummary) => {
    setSelected(commitment);
    setDetailOpen(true);
  };

  const submit = () => {
    if (form.project_id === "none") {
      toast({ title: "Project required", description: "Select a project." });
      return;
    }
    if (!form.title.trim() || form.title.trim().length < 2) {
      toast({ title: "Title required", description: "Enter a commitment title." });
      return;
    }
    const totalDollars = Number(form.total_dollars);
    if (!Number.isFinite(totalDollars) || totalDollars <= 0) {
      toast({ title: "Invalid total", description: "Enter a valid amount." });
      return;
    }
    if (costCodes.length > 0 && form.cost_code_id === "none") {
      toast({ title: "Cost code required", description: "Select a cost code for the commitment line." });
      return;
    }
    if (!form.scope.trim() || form.scope.trim().length < 2) {
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
        unwrapAction(await createCompanyCommitmentWithLineAction({
          commitment: {
            project_id: form.project_id,
            company_id: companyId,
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
        }));
        toast({ title: "Commitment created" });
        setCreateOpen(false);
        setForm({
          project_id: "none",
          cost_code_id: "none",
          title: "",
          total_dollars: "",
          status: "approved",
          contract_number: "",
          retainage_percent: "",
          scope: "",
          terms: "",
        });
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to create commitment",
          description: (error as Error).message,
        });
      }
    });
  };

  const filterControl = (
    <div
      className={cn(
        "flex items-center border p-0.5",
        !expanded && "lg:hidden",
      )}
    >
      {FILTERS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => setFilter(value)}
          className={cn(
            "px-2 py-0.5 text-xs font-medium transition-colors",
            filter === value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <Section
        title="Commitments"
        count={rows.length}
        stagger={stagger}
        fill={fill}
        noRise={expanded}
        className={className}
        bodyClassName="overflow-x-auto"
        footer={
          rows.length > 0 ? (
            <Table className={cn(TABLE_EDGE, "table-fixed")}>
              <colgroup>
                <col className="w-[34%]" />
                <col className="w-[22%]" />
                <col className="w-[22%]" />
                <col className="w-[22%]" />
              </colgroup>
              <TableBody>
                <TableRow className="border-0 hover:bg-transparent">
                  <TableCell className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Total
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium tabular-nums">
                    {formatMoneyFromCents(totals.committed)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                    {formatMoneyFromCents(totals.billed)}
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium tabular-nums">
                    {formatMoneyFromCents(totals.remaining)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          ) : null
        }
        action={
          <div className="flex items-center gap-2">
            {filterControl}
            {canEdit ? (
              <Button size="sm" className="h-8" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                New
              </Button>
            ) : null}
            {onToggleExpand ? (
              expanded ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => {
                    setFilter("active");
                    onToggleExpand(false);
                  }}
                >
                  <Minimize2 className="mr-1.5 h-3.5 w-3.5" />
                  Minimize
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="hidden h-8 lg:inline-flex"
                  onClick={() => onToggleExpand(true)}
                >
                  <Maximize2 className="mr-1.5 h-3.5 w-3.5" />
                  View all
                </Button>
              )
            ) : null}
          </div>
        }
      >
        {rows.length > 0 ? (
          <Table className={cn(TABLE_EDGE, "table-fixed")}>
            <colgroup>
              <col className="w-[34%]" />
              <col className="w-[22%]" />
              <col className="w-[22%]" />
              <col className="w-[22%]" />
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Billed</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((commitment) => {
                const original = commitment.total_cents ?? 0;
                const approvedChangeOrders = commitment.approved_change_orders_cents ?? 0;
                const total = commitment.revised_total_cents ?? original + approvedChangeOrders;
                const billed = commitment.billed_cents ?? 0;
                const remaining = Math.max(0, total - billed);
                const status = commitmentStatusMeta(commitment);
                return (
                  <TableRow
                    key={commitment.id}
                    className="cursor-pointer"
                    onClick={() => openDetail(commitment)}
                  >
                    <TableCell>
                      <div className="font-medium text-foreground">
                        {commitment.project_name ?? "—"}
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span
                          className={`inline-flex items-center border px-1.5 py-0 text-[10px] font-medium ${status.className}`}
                        >
                          {status.label}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {commitment.title}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatMoneyFromCents(total)}
                      {approvedChangeOrders !== 0 ? (
                        <div className="text-[10px] text-muted-foreground">
                          {formatMoneyFromCents(original)} + {formatMoneyFromCents(approvedChangeOrders)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                      {formatMoneyFromCents(billed)}
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium tabular-nums">
                      {formatMoneyFromCents(remaining)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <EmptyState>
            {expanded && filter !== "active"
              ? "Nothing here."
              : "No active commitments."}
            {!expanded && previous.length > 0 && onToggleExpand ? (
              <>
                {" "}
                <button
                  type="button"
                  className="text-primary underline-offset-4 hover:underline"
                  onClick={() => onToggleExpand(true)}
                >
                  View all ({previous.length} previous)
                </button>
              </>
            ) : null}
          </EmptyState>
        )}
      </Section>

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
              Create a vendor/sub commitment to track invoices against.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Project</Label>
              <Select
                value={form.project_id}
                onValueChange={(value) => setForm((p) => ({ ...p, project_id: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Select project</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Cost code</Label>
                <Select
                  value={form.cost_code_id}
                  onValueChange={(value) => setForm((p) => ({ ...p, cost_code_id: value }))}
                  disabled={costCodesLoading}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={costCodesLoading ? "Loading..." : "Select cost code"} />
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
                  onValueChange={(value) => setForm((p) => ({ ...p, status: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="complete">Complete</SelectItem>
                    <SelectItem value="canceled">Canceled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                  placeholder="Plumbing rough-in"
                />
              </div>
              <div className="space-y-2">
                <Label>Commitment total</Label>
                <Input
                  value={form.total_dollars}
                  onChange={(e) => setForm((p) => ({ ...p, total_dollars: e.target.value }))}
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
                  onChange={(e) => setForm((p) => ({ ...p, contract_number: e.target.value }))}
                  placeholder="SUB-004"
                />
              </div>
              <div className="space-y-2">
                <Label>Retainage (%)</Label>
                <Input
                  value={form.retainage_percent}
                  onChange={(e) => setForm((p) => ({ ...p, retainage_percent: e.target.value }))}
                  placeholder="10"
                  inputMode="decimal"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Scope</Label>
              <Textarea
                value={form.scope}
                onChange={(e) => setForm((p) => ({ ...p, scope: e.target.value }))}
                placeholder="Describe the work covered by this commitment."
                className="min-h-[84px]"
              />
            </div>
            <div className="space-y-2">
              <Label>Terms</Label>
              <Textarea
                value={form.terms}
                onChange={(e) => setForm((p) => ({ ...p, terms: e.target.value }))}
                placeholder="Payment terms, inclusions, exclusions, or notes."
                className="min-h-[72px]"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button disabled={isPending} onClick={submit}>
                {isPending ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
