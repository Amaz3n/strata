"use client";

import { useCallback, useEffect, useState, useTransition, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type {
  CommitmentBillRef,
  CommitmentChangeOrderRef,
  CommitmentDetail,
  CommitmentLine,
  CommitmentSummary,
} from "@/lib/services/commitments";
import { isCommitmentAwaitingExecution } from "@/lib/financials/commitment-position";
import {
  executeProjectCommitmentAction,
  getCommitmentDetailAction,
  updateProjectCommitmentAction,
} from "@/app/(app)/projects/[id]/commitments/actions";
import type { EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard";
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/documents/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { EntityAttachments, type AttachedFile } from "@/components/files";
import { AlertTriangle, ArrowUpRight, Download, PenLine, Send, Upload } from "@/components/icons";
import { useToast } from "@/hooks/use-toast";
import { unwrapAction } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import { formatDate, formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import {
  commitmentFlagClass,
  commitmentFlags,
  commitmentLifecycleMeta,
  commitmentTypeLabel,
} from "@/components/companies/account/commitment-status";

/** Heavy: PDF viewer plus drag-and-drop field placement. Loaded when asked for. */
const EnvelopeWizard = dynamic(
  () => import("@/components/esign/envelope-wizard").then((module) => module.EnvelopeWizard),
  { ssr: false },
);

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "complete", label: "Complete" },
  { value: "canceled", label: "Canceled" },
];

const todayIso = () => new Date().toISOString().slice(0, 10);

const CHANGE_ORDER_STATUS_TONE: Record<string, string> = {
  approved: "text-success",
  rejected: "text-destructive",
  voided: "text-muted-foreground",
  sent: "text-warning",
  draft: "text-muted-foreground",
};

const BILL_STATUS_TONE: Record<string, string> = {
  paid: "text-success",
  approved: "text-success",
  partial: "text-warning",
  pending: "text-warning",
  rejected: "text-destructive",
};

function mapLinks(links: Awaited<ReturnType<typeof listAttachmentsAction>>): AttachedFile[] {
  return links.map((link) => ({
    id: link.file.id,
    linkId: link.id,
    file_name: link.file.file_name,
    mime_type: link.file.mime_type,
    size_bytes: link.file.size_bytes,
    download_url: link.file.download_url,
    thumbnail_url: link.file.thumbnail_url,
    created_at: link.created_at,
    link_role: link.link_role,
  }));
}

/** One rung of the money ladder: what the contract was, is, and has left. */
function LadderRow({
  label,
  value,
  tone,
  emphasis,
  hint,
}: {
  label: string;
  value: number;
  tone?: string;
  emphasis?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 px-3 py-2 text-sm",
        emphasis && "bg-muted/40",
      )}
    >
      <span className={cn("text-muted-foreground", emphasis && "font-medium text-foreground")}>
        {label}
        {hint ? <span className="ml-1.5 text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono tabular-nums",
          emphasis ? "font-medium" : "",
          tone ?? "text-foreground",
        )}
      >
        {formatMoneyFromCents(value)}
      </span>
    </div>
  );
}

function SectionHeading({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <div className="microlabel">{title}</div>
      {typeof count === "number" ? (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </div>
  );
}

function LinesTable({ lines }: { lines: CommitmentLine[] }) {
  return (
    <div className="border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left">
            <th className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Cost code</th>
            <th className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Description</th>
            <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground">
              Qty
            </th>
            <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-b last:border-b-0">
              <td className="px-3 py-2 align-top">
                {line.cost_code_code || line.cost_code_name ? (
                  <span className="font-mono text-xs">
                    {[line.cost_code_code, line.cost_code_name].filter(Boolean).join(" · ")}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Uncoded</span>
                )}
              </td>
              <td className="px-3 py-2 align-top">
                <span className="block">{line.description}</span>
                {line.retainage_percent != null && line.retainage_percent > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {line.retainage_percent}% retainage
                  </span>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right align-top font-mono text-xs tabular-nums text-muted-foreground">
                {line.quantity} {line.unit}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right align-top font-mono tabular-nums">
                {formatMoneyFromCents(line.total_cents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangeOrdersList({ changeOrders }: { changeOrders: CommitmentChangeOrderRef[] }) {
  return (
    <div className="border">
      {changeOrders.map((changeOrder) => (
        <div
          key={changeOrder.id}
          className="flex items-baseline justify-between gap-3 border-b px-3 py-2 text-sm last:border-b-0"
        >
          <div className="min-w-0">
            <span className="block truncate font-medium">{changeOrder.title}</span>
            <span className="text-xs text-muted-foreground">
              <span
                className={cn(
                  "capitalize",
                  CHANGE_ORDER_STATUS_TONE[changeOrder.status] ?? "text-muted-foreground",
                )}
              >
                {changeOrder.status}
              </span>
              {changeOrder.reason_label ? ` · ${changeOrder.reason_label}` : ""}
              {changeOrder.approved_at ? ` · ${formatDate(changeOrder.approved_at)}` : ""}
            </span>
          </div>
          <span className="shrink-0 font-mono tabular-nums">
            {formatMoneyFromCents(changeOrder.total_cents)}
          </span>
        </div>
      ))}
    </div>
  );
}

function BillsList({ bills }: { bills: CommitmentBillRef[] }) {
  return (
    <div className="border">
      {bills.map((bill) => (
        <div
          key={bill.id}
          className="flex items-baseline justify-between gap-3 border-b px-3 py-2 text-sm last:border-b-0"
        >
          <div className="min-w-0">
            <span className="block truncate font-medium">
              {bill.bill_number || (bill.is_credit ? "Vendor credit" : "Bill")}
            </span>
            <span className="text-xs text-muted-foreground">
              <span className={cn("capitalize", BILL_STATUS_TONE[bill.status] ?? "text-muted-foreground")}>
                {bill.status}
              </span>
              {bill.bill_date ? ` · ${formatDate(bill.bill_date)}` : ""}
              {bill.retainage_cents > 0
                ? ` · ${formatMoneyFromCents(bill.retainage_cents)} retained`
                : ""}
            </span>
          </div>
          <span
            className={cn(
              "shrink-0 font-mono tabular-nums",
              bill.is_credit ? "text-success" : "text-foreground",
            )}
          >
            {formatMoneyFromCents(bill.total_cents)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CommitmentDetailSheet({
  commitment,
  open,
  onOpenChange,
  canEdit,
}: {
  /** The register row, used to paint the sheet before the detail read lands. */
  commitment: CommitmentSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [detail, setDetail] = useState<CommitmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordForm, setRecordForm] = useState({ executed_at: todayIso(), note: "" });
  const [recordFile, setRecordFile] = useState<File | null>(null);

  const commitmentId = commitment?.id;
  const projectId = commitment?.project_id;

  const [form, setForm] = useState({
    title: "",
    contract_number: "",
    status: "approved",
    retainage_percent: "",
    start_date: "",
    end_date: "",
    scope: "",
    terms: "",
  });

  // The register row is the fallback until the detail read resolves, so the
  // sheet never shows a blank header.
  const current = detail?.commitment ?? commitment;

  useEffect(() => {
    if (!current) return;
    setForm({
      title: current.title ?? "",
      contract_number: current.contract_number ?? "",
      status: (current.status ?? "approved").toLowerCase(),
      retainage_percent: current.retainage_percent != null ? String(current.retainage_percent) : "",
      start_date: current.start_date ?? "",
      end_date: current.end_date ?? "",
      scope: current.scope ?? "",
      terms: current.terms ?? "",
    });
  }, [current]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(unwrapAction(await getCommitmentDetailAction(id)));
    } catch (error) {
      setDetail(null);
      setDetailError((error as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !commitmentId) return;
    let cancelled = false;
    setDetail(null);
    setEditing(false);
    setAttachmentsLoading(true);
    void (async () => {
      const [, links] = await Promise.allSettled([
        loadDetail(commitmentId),
        listAttachmentsAction("commitment", commitmentId),
      ]);
      if (cancelled) return;
      setAttachments(links.status === "fulfilled" ? mapLinks(links.value) : []);
      setAttachmentsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, commitmentId, loadDetail]);

  const refreshAttachments = useCallback(async () => {
    if (!commitmentId) return;
    setAttachments(mapLinks(await listAttachmentsAction("commitment", commitmentId)));
  }, [commitmentId]);

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!commitmentId || !projectId) return;
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("projectId", projectId);
      formData.append("category", "financials");
      const uploaded = unwrapAction(await uploadFileAction(formData));
      unwrapAction(await attachFileAction(uploaded.id, "commitment", commitmentId, projectId, linkRole));
    }
    await refreshAttachments();
  };

  const handleDetach = async (linkId: string) => {
    unwrapAction(await detachFileLinkAction(linkId));
    await refreshAttachments();
  };

  const save = () => {
    if (!commitmentId || !projectId) return;
    if (form.title.trim().length < 2) {
      toast({ title: "Title required", description: "Enter a commitment title." });
      return;
    }
    const retainage = form.retainage_percent.trim() === "" ? null : Number(form.retainage_percent);
    if (retainage != null && (!Number.isFinite(retainage) || retainage < 0 || retainage > 100)) {
      toast({ title: "Invalid retainage", description: "Enter 0–100." });
      return;
    }
    startTransition(async () => {
      try {
        // The total is not editable here: it is the sum of the commitment's
        // lines, which live on the project budget.
        unwrapAction(
          await updateProjectCommitmentAction(projectId, commitmentId, {
            title: form.title.trim(),
            contract_number: form.contract_number.trim() || null,
            status: form.status,
            retainage_percent: retainage,
            start_date: form.start_date || undefined,
            end_date: form.end_date || undefined,
            scope: form.scope.trim() || null,
            terms: form.terms.trim() || null,
          }),
        );
        toast({ title: "Commitment updated" });
        setEditing(false);
        await loadDetail(commitmentId);
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to update commitment",
          description: (error as Error).message,
        });
      }
    });
  };

  const recordExecution = () => {
    if (!commitmentId || !projectId) return;
    if (!recordFile) {
      toast({
        title: "Signed agreement required",
        description: "Attach the countersigned document to record execution.",
      });
      return;
    }
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.append("file", recordFile);
        formData.append("projectId", projectId);
        formData.append("category", "contracts");
        const uploaded = unwrapAction(await uploadFileAction(formData));
        unwrapAction(
          await executeProjectCommitmentAction(projectId, commitmentId, {
            executed_file_id: uploaded.id,
            executed_at: recordForm.executed_at,
            note: recordForm.note.trim() || undefined,
          }),
        );
        toast({ title: "Execution recorded" });
        setRecordOpen(false);
        setRecordFile(null);
        setRecordForm({ executed_at: todayIso(), note: "" });
        await loadDetail(commitmentId);
        await refreshAttachments();
        router.refresh();
      } catch (error) {
        toast({ title: "Unable to record execution", description: (error as Error).message });
      }
    });
  };

  const lifecycle = commitmentLifecycleMeta(current?.status);
  const flags = current ? commitmentFlags(current) : [];
  const status = String(current?.status ?? "").toLowerCase();
  const isDraft = status === "draft";
  const awaitingExecution = current ? isCommitmentAwaitingExecution(current) : false;
  // Purchase orders can be signed when a customer requires it, but a PO without a
  // signature is not an exception, so it is offered rather than urged.
  const canExecute =
    canEdit && !current?.executed_at && (status === "approved" || status === "complete");
  const executionMethod =
    typeof current?.executed_signature_method === "string" ? current.executed_signature_method : null;
  const original = current?.total_cents ?? 0;
  const approvedChangeOrders = current?.approved_change_orders_cents ?? 0;
  const pendingChangeOrders = current?.pending_change_orders_cents ?? 0;
  const revised = current?.revised_total_cents ?? original;
  const billed = current?.billed_cents ?? 0;
  const pendingBilled = current?.pending_billed_cents ?? 0;
  const paid = current?.paid_cents ?? 0;
  const retainageHeld = current?.retainage_held_cents ?? 0;
  const remaining = current?.remaining_cents ?? revised - billed;
  const billedShare = revised > 0 ? Math.min(1, Math.max(0, billed / revised)) : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="fast-sheet-animation flex flex-col gap-0 p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-xl"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <div className="border-b px-6 pb-4 pt-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <SheetTitle className="truncate text-lg font-semibold leading-none tracking-tight">
                  {current?.title ?? "Commitment"}
                </SheetTitle>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center border px-2 py-0.5 text-xs font-medium",
                    lifecycle.className,
                  )}
                >
                  {lifecycle.label}
                </span>
              </div>
              <SheetDescription className="mt-1.5 text-sm text-muted-foreground">
                {commitmentTypeLabel(current?.commitment_type)}
                {current?.contract_number ? ` · ${current.contract_number}` : ""}
                {current?.project_name ? ` · ${current.project_name}` : ""}
              </SheetDescription>
            </div>
            {canEdit && !editing ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => setEditing(true)}
              >
                <PenLine className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            ) : null}
          </div>
          {flags.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium">
              {flags.map((flag) => (
                <span key={flag.label} className={commitmentFlagClass(flag.tone)}>
                  {flag.label}
                </span>
              ))}
            </div>
          ) : null}
          {current?.prequalification_warning ? (
            <p className="mt-2.5 flex items-start gap-1.5 border border-warning/40 bg-warning/5 px-2.5 py-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{current.prequalification_warning}</span>
            </p>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* The position, top to bottom: what we bought, what was claimed, what is left. */}
          <div className="border">
            <LadderRow label="Original" value={original} />
            {approvedChangeOrders !== 0 ? (
              <LadderRow label="Approved change orders" value={approvedChangeOrders} />
            ) : null}
            <LadderRow label="Revised total" value={revised} emphasis />
            <LadderRow
              label="Billed"
              value={billed}
              hint={pendingBilled > 0 ? `${formatMoneyFromCents(pendingBilled)} awaiting approval` : undefined}
            />
            <LadderRow label="Paid" value={paid} tone="text-muted-foreground" />
            {retainageHeld > 0 ? (
              <LadderRow label="Retainage held" value={retainageHeld} tone="text-muted-foreground" />
            ) : null}
            <LadderRow
              label={remaining < 0 ? "Over-billed by" : "Remaining"}
              value={remaining < 0 ? Math.abs(remaining) : remaining}
              emphasis
              tone={remaining < 0 ? "text-destructive" : undefined}
            />
            {pendingChangeOrders !== 0 ? (
              <LadderRow
                label="Pending change orders"
                value={pendingChangeOrders}
                tone="text-warning"
                hint="not yet committed"
              />
            ) : null}
          </div>

          {revised > 0 ? (
            <div
              className="h-1 w-full bg-muted"
              role="img"
              aria-label={`${Math.round(billedShare * 100)}% of the revised total billed`}
            >
              <div
                className={cn("h-full", remaining < 0 ? "bg-destructive" : "bg-primary")}
                style={{ width: `${Math.max(2, billedShare * 100)}%` }}
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <SectionHeading title="Execution" />
            <div className="border px-3 py-2.5 text-sm">
              {current?.executed_at ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    Executed {formatDate(current.executed_at)}
                    {executionMethod === "recorded" ? " · recorded manually" : ""}
                    {executionMethod === "esign" ? " · signed in Arc" : ""}
                  </span>
                  {current.executed_file_id ? (
                    <a
                      href={`/api/files/${current.executed_file_id}/raw`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex shrink-0 items-center text-primary underline-offset-4 hover:underline"
                    >
                      <Download className="mr-1 h-3.5 w-3.5" />
                      Signed agreement
                    </a>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-2.5">
                  <p className={cn(awaitingExecution ? "text-warning" : "text-muted-foreground")}>
                    {awaitingExecution
                      ? "Approved but not executed — no signed agreement on file."
                      : isDraft
                        ? "Approve this commitment before it can be executed."
                        : "No signed agreement on file."}
                  </p>
                  {canExecute ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" className="h-8" onClick={() => setSignatureOpen(true)}>
                        <Send className="mr-1.5 h-3.5 w-3.5" />
                        Send for signature
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => setRecordOpen(true)}
                      >
                        <Upload className="mr-1.5 h-3.5 w-3.5" />
                        Record signed agreement
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          {detailLoading && !detail ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : null}

          {detailError ? (
            <div className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <p>Could not load the commitment&apos;s detail. {detailError}</p>
              {commitmentId ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 h-7 text-xs"
                  onClick={() => void loadDetail(commitmentId)}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}

          {detail ? (
            <>
              <div className="space-y-2">
                <SectionHeading title="Lines" count={detail.lines.length} />
                {detail.lines.length > 0 ? (
                  <LinesTable lines={detail.lines} />
                ) : (
                  <p className="border px-3 py-3 text-sm text-muted-foreground">
                    No lines. A commitment without lines contributes nothing to the budget rollup.
                  </p>
                )}
              </div>

              {detail.change_orders.length > 0 ? (
                <div className="space-y-2">
                  <SectionHeading title="Change orders" count={detail.change_orders.length} />
                  <ChangeOrdersList changeOrders={detail.change_orders} />
                </div>
              ) : null}

              {detail.bills.length > 0 ? (
                <div className="space-y-2">
                  <SectionHeading title="Bills" count={detail.bills.length} />
                  <BillsList bills={detail.bills} />
                </div>
              ) : null}
            </>
          ) : null}

          {current?.scope || current?.terms ? (
            <div className="space-y-3">
              {current.scope ? (
                <div className="space-y-1">
                  <SectionHeading title="Scope" />
                  <p className="whitespace-pre-wrap text-sm text-foreground/90">{current.scope}</p>
                </div>
              ) : null}
              {current.terms ? (
                <div className="space-y-1">
                  <SectionHeading title="Terms" />
                  <p className="whitespace-pre-wrap text-sm text-foreground/90">{current.terms}</p>
                </div>
              ) : null}
            </div>
          ) : null}

          {editing ? (
            <fieldset disabled={isPending} className="space-y-4 border-t pt-5">
              <SectionHeading title="Edit details" />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Title</Label>
                  <Input
                    value={form.title}
                    onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder="Plumbing rough-in"
                  />
                </div>
                <div className="space-y-2">
                  <Label>
                    {current?.commitment_type === "purchase_order" ? "PO number" : "Contract no."}
                  </Label>
                  <Input
                    value={form.contract_number}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, contract_number: event.target.value }))
                    }
                    placeholder="SUB-004"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select
                    value={form.status}
                    onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Retainage %</Label>
                  <Input
                    value={form.retainage_percent}
                    inputMode="decimal"
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, retainage_percent: event.target.value }))
                    }
                    placeholder="10"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Start date</Label>
                  <Input
                    type="date"
                    value={form.start_date}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, start_date: event.target.value }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>End date</Label>
                  <Input
                    type="date"
                    value={form.end_date}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, end_date: event.target.value }))
                    }
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Scope</Label>
                  <Textarea
                    value={form.scope}
                    onChange={(event) => setForm((prev) => ({ ...prev, scope: event.target.value }))}
                    rows={3}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Terms</Label>
                  <Textarea
                    value={form.terms}
                    onChange={(event) => setForm((prev) => ({ ...prev, terms: event.target.value }))}
                    rows={3}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The commitment total is the sum of its lines. Change it on the project budget.
              </p>
            </fieldset>
          ) : null}

          <div className="space-y-2">
            <SectionHeading title="Files" />
            {current ? (
              <EntityAttachments
                entityType="commitment"
                entityId={current.id}
                projectId={current.project_id}
                attachments={attachments}
                onAttach={handleAttach}
                onDetach={handleDetach}
                readOnly={!canEdit || attachmentsLoading}
                compact
              />
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-background p-4">
          {current ? (
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/projects/${current.project_id}/financials/budget`}>
                Open in budget
                <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {editing ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={isPending}>
                {isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </div>
      </SheetContent>

      {current && signatureOpen ? (
        <EnvelopeWizard
          open={signatureOpen}
          onOpenChange={setSignatureOpen}
          sourceEntity={
            {
              type: "subcontract",
              id: current.id,
              project_id: current.project_id,
              title: current.title,
              document_type: "contract",
            } satisfies EnvelopeWizardSourceEntity
          }
          sourceLabel="Commitment"
          sheetTitle="Send commitment for signature"
          sheetDescription="Arc generates the agreement from this commitment, or upload your own, then send it to the vendor to sign."
          onEnvelopeSent={() => {
            setSignatureOpen(false);
            router.refresh();
          }}
        />
      ) : null}

      <Dialog
        open={recordOpen}
        onOpenChange={(next) => {
          setRecordOpen(next);
          if (!next) setRecordFile(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Record signed agreement</DialogTitle>
            <DialogDescription>
              For an agreement signed outside Arc — on paper, or countersigned and returned by
              email. The signed document is kept with the commitment as the record of execution.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="executed-agreement">Signed agreement</Label>
              <input
                id="executed-agreement"
                type="file"
                accept="application/pdf,image/*"
                onChange={(event) => setRecordFile(event.target.files?.[0] ?? null)}
                className="block w-full border bg-background px-2 py-1.5 text-sm file:mr-3 file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="executed-date">Date signed</Label>
              <Input
                id="executed-date"
                type="date"
                max={todayIso()}
                value={recordForm.executed_at}
                onChange={(event) =>
                  setRecordForm((prev) => ({ ...prev, executed_at: event.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="executed-note">Note</Label>
              <Textarea
                id="executed-note"
                value={recordForm.note}
                onChange={(event) => setRecordForm((prev) => ({ ...prev, note: event.target.value }))}
                placeholder="Where the original is held, who signed, or anything worth knowing later."
                rows={2}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRecordOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button onClick={recordExecution} disabled={isPending || !recordFile}>
                {isPending ? "Recording…" : "Record execution"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}
