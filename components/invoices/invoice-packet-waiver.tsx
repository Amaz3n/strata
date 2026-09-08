"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { loadWaiverPacketAction } from "@/app/(app)/invoices/waiver-actions";
import { unwrapAction } from "@/lib/action-result";
import { readWaiverWorkflow } from "@/lib/lien-waivers/invoice-waiver";
import { Button } from "@/components/ui/button";
import { WaiverPdfPreview } from "./waiver-pdf-preview";
import type { Invoice, InvoiceLienWaiver } from "@/lib/types";
const Preparation = dynamic(() => import("./waiver-preparation"), {
  ssr: false,
  loading: () => (
    <p className="m-auto text-sm text-muted-foreground">Opening waiver…</p>
  ),
});
export function InvoicePacketWaiver({
  invoiceId,
  onClose,
  onSaved,
}: {
  invoiceId: string;
  onClose: () => void;
  onSaved?: (waiver: InvoiceLienWaiver) => void;
}) {
  const [data, setData] = useState<{
    invoice: Invoice;
    waivers: InvoiceLienWaiver[];
    readinessError?: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [newDraft, setNewDraft] = useState(false);
  useEffect(() => {
    let active = true;
    loadWaiverPacketAction(invoiceId)
      .then(unwrapAction)
      .then((result) => {
        if (active) {
          setData(result);
          setError("");
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [invoiceId, revision]);
  if (error)
    return (
      <div className="m-auto space-y-3 p-8 text-center">
        <p role="alert">{error}</p>
        <Button onClick={() => setRevision((v) => v + 1)}>Try again</Button>
      </div>
    );
  if (!data)
    return (
      <p className="m-auto text-sm text-muted-foreground" role="status">
        Loading your invoice’s waiver…
      </p>
    );
  const current = newDraft
    ? undefined
    : data.waivers.find((w) => w.id === data.invoice.metadata?.waiver_packet?.waiver_id) ?? data.waivers.find((w) => readWaiverWorkflow(w));
  const signed = readWaiverWorkflow(current ?? {})?.lifecycle === "signed";
  if (signed && current)
    return (
      <div className="flex min-h-0 flex-1">
        <div className="w-[360px] space-y-4 border-r p-6">
          <h2 className="text-lg font-medium">Signed waiver</h2>
          <p className="text-sm text-muted-foreground">
            {data.readinessError ? "This signed document is kept on file, but the packet is not ready. Prepare a new waiver with the current invoice details before sending." : "Your company has signed. The client receives this waiver with the invoice in one email."}
          </p>
          <Button onClick={onClose}>Back to invoice</Button>
          <Button variant="ghost" onClick={() => setNewDraft(true)}>
            Prepare a new waiver
          </Button>
        </div>
        <WaiverPdfPreview
          url={`/api/invoices/${invoiceId}/waivers/${current.id}`}
        />
      </div>
    );
  return (
    <Preparation
      key={current?.id ?? "new"}
      embedded
      invoice={data.invoice}
      draft={current}
      onClose={onClose}
      onSaved={(waiver) => {
        const workflow = readWaiverWorkflow(waiver);
        if (workflow?.lifecycle === "signed") {
          setNewDraft(false);
          setData(current => current ? {
            ...current,
            invoice: { ...current.invoice, metadata: { ...current.invoice.metadata, waiver_packet: { enabled: true, waiver_id: waiver.id } } },
            waivers: [waiver, ...current.waivers.filter(w => w.id !== waiver.id)],
            readinessError: workflow.needs_review || !workflow.shared ? "Review this waiver before sending" : null,
          } : current);
        }
        onSaved?.(waiver);
      }}
    />
  );
}
