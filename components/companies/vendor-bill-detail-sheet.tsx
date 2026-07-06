"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";

import type { VendorBillSummary } from "@/lib/services/vendor-bills";
import { updateVendorBillStatusAction } from "@/app/(app)/companies/[id]/actions";
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/documents/actions";
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
  SheetTitle,
} from "@/components/ui/sheet";
import { EntityAttachments, type AttachedFile } from "@/components/files";
import { useToast } from "@/hooks/use-toast";
import { formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import { payableStatusMeta } from "@/components/companies/payable-status";

const PAYMENT_METHODS = [
  { value: "check", label: "Check" },
  { value: "ach", label: "ACH" },
  { value: "wire", label: "Wire" },
  { value: "card", label: "Card" },
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

export function VendorBillDetailSheet({
  bill,
  companyId,
  open,
  onOpenChange,
  canEdit,
}: {
  bill: VendorBillSummary | null;
  companyId: string;
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
    bill_number: "",
    bill_date: "",
    due_date: "",
    payment_method: "check",
    payment_reference: "",
  });

  useEffect(() => {
    if (!bill) return;
    setForm({
      bill_number: bill.bill_number ?? "",
      bill_date: bill.bill_date ?? "",
      due_date: bill.due_date ?? "",
      payment_method: bill.payment_method ?? "check",
      payment_reference: bill.payment_reference ?? "",
    });
  }, [bill]);

  const billId = bill?.id;
  const projectId = bill?.project_id;

  const refreshAttachments = useCallback(async () => {
    if (!billId) return;
    const links = await listAttachmentsAction("vendor_bill", billId);
    setAttachments(mapLinks(links));
  }, [billId]);

  useEffect(() => {
    if (!open || !billId) return;
    let cancelled = false;
    setAttachmentsLoading(true);
    listAttachmentsAction("vendor_bill", billId)
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
  }, [open, billId]);

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!billId || !projectId) return;
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("projectId", projectId);
      formData.append("category", "financials");
      const uploaded = await uploadFileAction(formData);
      await attachFileAction(uploaded.id, "vendor_bill", billId, projectId, linkRole);
    }
    await refreshAttachments();
  };

  const handleDetach = async (linkId: string) => {
    await detachFileLinkAction(linkId);
    await refreshAttachments();
  };

  const runUpdate = (
    patch: Record<string, unknown>,
    successTitle: string,
  ) => {
    if (!billId) return;
    startTransition(async () => {
      try {
        await updateVendorBillStatusAction(billId, companyId, patch);
        toast({ title: successTitle });
        onOpenChange(false);
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to update bill",
          description: (error as Error).message,
        });
      }
    });
  };

  const detailPatch = () => ({
    bill_number: form.bill_number.trim() || undefined,
    bill_date: form.bill_date || undefined,
    due_date: form.due_date || undefined,
  });

  const paymentPatch = () => ({
    payment_method: form.payment_method || undefined,
    payment_reference: form.payment_reference.trim() || undefined,
  });

  const status = (bill?.status ?? "pending").toLowerCase();
  const canApprove = status === "pending";
  const canPay = status === "approved" || status === "partial";

  const total = bill?.total_cents ?? 0;
  const paid = bill?.paid_cents ?? 0;
  const remaining = Math.max(0, total - paid);
  const meta = bill ? payableStatusMeta(bill) : null;

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
              {bill?.bill_number ? `Invoice ${bill.bill_number}` : "Vendor bill"}
            </SheetTitle>
            {meta ? (
              <span
                className={`inline-flex items-center border px-2 py-0.5 text-xs font-medium ${meta.className}`}
              >
                {meta.label}
              </span>
            ) : null}
          </div>
          <SheetDescription className="mt-1.5 text-sm text-muted-foreground">
            {bill?.project_name ?? "Vendor bill"}
            {bill?.commitment_title ? ` · ${bill.commitment_title}` : ""}
          </SheetDescription>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-3 divide-x border">
            <SummaryFigure label="Amount" value={formatMoneyFromCents(total)} />
            <SummaryFigure label="Paid" value={formatMoneyFromCents(paid)} />
            <SummaryFigure label="Remaining" value={formatMoneyFromCents(remaining)} />
          </div>

          <fieldset disabled={!canEdit || isPending} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>Invoice no.</Label>
                <Input
                  value={form.bill_number}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, bill_number: e.target.value }))
                  }
                  placeholder="INV-1042"
                />
              </div>
              <div className="space-y-2">
                <Label>Invoice date</Label>
                <Input
                  type="date"
                  value={form.bill_date}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, bill_date: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Due date</Label>
                <Input
                  type="date"
                  value={form.due_date}
                  onChange={(e) => setForm((p) => ({ ...p, due_date: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Payment method</Label>
                <Select
                  value={form.payment_method}
                  onValueChange={(value) =>
                    setForm((p) => ({ ...p, payment_method: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Payment reference</Label>
                <Input
                  value={form.payment_reference}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, payment_reference: e.target.value }))
                  }
                  placeholder="Check / ACH / QBO ref"
                />
              </div>
            </div>
          </fieldset>

          <div className="space-y-2">
            <div className="microlabel">Files</div>
            {bill ? (
              <EntityAttachments
                entityType="vendor_bill"
                entityId={bill.id}
                projectId={bill.project_id}
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
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  runUpdate({ status, ...detailPatch() }, "Bill saved")
                }
                disabled={isPending}
              >
                Save
              </Button>
              {canApprove ? (
                <Button
                  onClick={() =>
                    runUpdate(
                      { status: "approved", ...detailPatch() },
                      "Bill approved",
                    )
                  }
                  disabled={isPending}
                >
                  Approve
                </Button>
              ) : null}
              {canPay ? (
                <Button
                  onClick={() =>
                    runUpdate(
                      { status: "paid", ...detailPatch(), ...paymentPatch() },
                      "Bill marked paid",
                    )
                  }
                  disabled={isPending}
                >
                  Mark paid
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
