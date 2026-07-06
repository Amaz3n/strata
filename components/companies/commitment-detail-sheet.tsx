"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";

import type { CommitmentSummary } from "@/lib/services/commitments";
import { updateCompanyCommitmentAction } from "@/app/(app)/companies/[id]/actions";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { EntityAttachments, type AttachedFile } from "@/components/files";
import { useToast } from "@/hooks/use-toast";
import { formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import { commitmentStatusMeta } from "@/components/companies/commitment-status";

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "complete", label: "Complete" },
  { value: "canceled", label: "Canceled" },
];

function mapLinks(
  links: Awaited<ReturnType<typeof listAttachmentsAction>>,
): AttachedFile[] {
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

function SummaryFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2.5">
      <div className="microlabel">{label}</div>
      <div className="mt-1 font-mono text-sm tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

export function CommitmentDetailSheet({
  commitment,
  open,
  onOpenChange,
  canEdit,
}: {
  commitment: CommitmentSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);

  const [form, setForm] = useState({
    title: "",
    contract_number: "",
    total_dollars: "",
    status: "approved",
    retainage_percent: "",
    start_date: "",
    end_date: "",
    scope: "",
    terms: "",
  });

  useEffect(() => {
    if (!commitment) return;
    setForm({
      title: commitment.title ?? "",
      contract_number: commitment.contract_number ?? "",
      total_dollars:
        commitment.total_cents != null
          ? String((commitment.total_cents / 100).toFixed(2))
          : "",
      status: (commitment.status ?? "approved").toLowerCase(),
      retainage_percent:
        commitment.retainage_percent != null
          ? String(commitment.retainage_percent)
          : "",
      start_date: commitment.start_date ?? "",
      end_date: commitment.end_date ?? "",
      scope: commitment.scope ?? "",
      terms: commitment.terms ?? "",
    });
  }, [commitment]);

  const commitmentId = commitment?.id;
  const projectId = commitment?.project_id;

  const refreshAttachments = useCallback(async () => {
    if (!commitmentId) return;
    const links = await listAttachmentsAction("commitment", commitmentId);
    setAttachments(mapLinks(links));
  }, [commitmentId]);

  useEffect(() => {
    if (!open || !commitmentId) return;
    let cancelled = false;
    setAttachmentsLoading(true);
    listAttachmentsAction("commitment", commitmentId)
      .then((links) => {
        if (!cancelled) setAttachments(mapLinks(links));
      })
      .catch(() => {
        if (!cancelled) setAttachments([]);
      })
      .finally(() => {
        if (!cancelled) setAttachmentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, commitmentId]);

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!commitmentId || !projectId) return;
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("projectId", projectId);
      formData.append("category", "financials");
      const uploaded = await uploadFileAction(formData);
      await attachFileAction(uploaded.id, "commitment", commitmentId, projectId, linkRole);
    }
    await refreshAttachments();
  };

  const handleDetach = async (linkId: string) => {
    await detachFileLinkAction(linkId);
    await refreshAttachments();
  };

  const save = () => {
    if (!commitmentId) return;
    if (!form.title.trim() || form.title.trim().length < 2) {
      toast({ title: "Title required", description: "Enter a commitment title." });
      return;
    }
    const totalDollars = Number(form.total_dollars);
    if (!Number.isFinite(totalDollars) || totalDollars < 0) {
      toast({ title: "Invalid total", description: "Enter a valid amount." });
      return;
    }
    const retainage =
      form.retainage_percent.trim() === "" ? null : Number(form.retainage_percent);
    if (retainage != null && (!Number.isFinite(retainage) || retainage < 0 || retainage > 100)) {
      toast({ title: "Invalid retainage", description: "Enter 0–100." });
      return;
    }
    startTransition(async () => {
      try {
        await updateCompanyCommitmentAction(commitmentId, {
          title: form.title.trim(),
          contract_number: form.contract_number.trim() || null,
          total_cents: Math.round(totalDollars * 100),
          status: form.status,
          retainage_percent: retainage,
          start_date: form.start_date || undefined,
          end_date: form.end_date || undefined,
          scope: form.scope.trim() || null,
          terms: form.terms.trim() || null,
        });
        toast({ title: "Commitment updated" });
        onOpenChange(false);
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to update commitment",
          description: (error as Error).message,
        });
      }
    });
  };

  const total = commitment?.total_cents ?? 0;
  const billed = commitment?.billed_cents ?? 0;
  const paid = commitment?.paid_cents ?? 0;
  const remaining = Math.max(0, total - billed);
  const status = commitmentStatusMeta(commitment);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="gap-0 p-0 sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <div className="border-b px-6 pt-6 pb-4">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
              {commitment?.title ?? "Commitment"}
            </SheetTitle>
            <span
              className={cnStatus(status.className)}
            >
              {status.label}
            </span>
          </div>
          <SheetDescription className="mt-1.5 text-sm text-muted-foreground">
            {commitment?.project_name ?? "Commitment"}
            {commitment?.contract_number ? ` · #${commitment.contract_number}` : ""}
          </SheetDescription>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 divide-x divide-y border sm:grid-cols-4 sm:divide-y-0">
            <SummaryFigure label="Total" value={formatMoneyFromCents(total)} />
            <SummaryFigure label="Billed" value={formatMoneyFromCents(billed)} />
            <SummaryFigure label="Paid" value={formatMoneyFromCents(paid)} />
            <SummaryFigure label="Remaining" value={formatMoneyFromCents(remaining)} />
          </div>

          <fieldset disabled={!canEdit || isPending} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>Title</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                  placeholder="Plumbing rough-in"
                />
              </div>
              <div className="space-y-2">
                <Label>Contract no.</Label>
                <Input
                  value={form.contract_number}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, contract_number: e.target.value }))
                  }
                  placeholder="PO-1042"
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(value) => setForm((p) => ({ ...p, status: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Commitment total</Label>
                <Input
                  value={form.total_dollars}
                  inputMode="decimal"
                  onChange={(e) =>
                    setForm((p) => ({ ...p, total_dollars: e.target.value }))
                  }
                  placeholder="10000"
                />
              </div>
              <div className="space-y-2">
                <Label>Retainage %</Label>
                <Input
                  value={form.retainage_percent}
                  inputMode="decimal"
                  onChange={(e) =>
                    setForm((p) => ({ ...p, retainage_percent: e.target.value }))
                  }
                  placeholder="10"
                />
              </div>
              <div className="space-y-2">
                <Label>Start date</Label>
                <Input
                  type="date"
                  value={form.start_date}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, start_date: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>End date</Label>
                <Input
                  type="date"
                  value={form.end_date}
                  onChange={(e) => setForm((p) => ({ ...p, end_date: e.target.value }))}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Scope</Label>
                <Textarea
                  value={form.scope}
                  onChange={(e) => setForm((p) => ({ ...p, scope: e.target.value }))}
                  placeholder="Scope of work covered by this commitment"
                  rows={3}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Terms</Label>
                <Textarea
                  value={form.terms}
                  onChange={(e) => setForm((p) => ({ ...p, terms: e.target.value }))}
                  placeholder="Payment / contract terms"
                  rows={3}
                />
              </div>
            </div>
          </fieldset>

          <div className="space-y-2">
            <div className="microlabel">Files</div>
            {commitment ? (
              <EntityAttachments
                entityType="commitment"
                entityId={commitment.id}
                projectId={commitment.project_id}
                attachments={attachments}
                onAttach={handleAttach}
                onDetach={handleDetach}
                readOnly={!canEdit || attachmentsLoading}
                compact
              />
            ) : null}
          </div>
        </div>

        {canEdit ? (
          <div className="flex-shrink-0 border-t bg-background p-4">
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button onClick={save} disabled={isPending}>
                {isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function cnStatus(className: string) {
  return `inline-flex items-center border px-2 py-0.5 text-xs font-medium ${className}`;
}
