"use client";
import { useEffect, useRef, useState } from "react";
import { pdf } from "@react-pdf/renderer";
import { WaiverTemplateDocument } from "@/lib/pdfs/waiver-template";
import { WaiverPdfPreview } from "@/components/invoices/waiver-pdf-preview";
import {
  resolveWaiverValues,
  waiverPreviewValues,
} from "@/lib/templates/waiver-engine";
import type { WaiverTemplateDraft } from "@/lib/templates/waiver-template";
export default function LivePreview({
  draft,
  sample,
  values,
  invoiceNumber,
  sourceFileId,
  customValues,
}: {
  draft: WaiverTemplateDraft;
  sample: boolean;
  values?: Record<string, string>;
  invoiceNumber?: string;
  sourceFileId?: string;
  customValues?: Record<string, string>;
}) {
  const [url, setUrl] = useState<string>(),
    [error, setError] = useState("");
  const urls = useRef<string[]>([]),
    sourceCache = useRef<{ id: string; bytes: Uint8Array } | undefined>(
      undefined,
    );
  // Metadata, review checkboxes and default assignment never trigger PDF work.
  const key = JSON.stringify({
    title: draft.title,
    body: draft.body,
    document: draft.document ? { ...draft.document, issues: [] } : undefined,
    values,
    customValues,
    sample,
    invoiceNumber,
    sourceFileId,
  });
  const current = useRef({
    draft,
    sample,
    values,
    invoiceNumber,
    sourceFileId,
    customValues,
  });
  current.current = {
    draft,
    sample,
    values,
    invoiceNumber,
    sourceFileId,
    customValues,
  };
  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const v = current.current;
          const resolved = v.values
            ? resolveWaiverValues(
                v.draft,
                { ...v.values, invoice_number: v.invoiceNumber ?? "" },
                v.customValues,
                true,
              )
            : waiverPreviewValues(v.draft, v.sample);
          let blob: Blob;
          if (v.draft.document?.mode === "original") {
            if (!v.sourceFileId)
              throw new Error("Import a PDF to preview the original form");
            let sourceBytes = sourceCache.current?.id === v.sourceFileId
              ? sourceCache.current.bytes
              : undefined;
            if (!sourceBytes) {
              const response = await fetch(
                `/api/settings/templates/${v.sourceFileId}`,
                { signal: controller.signal },
              );
              if (!active) return;
              if (!response.ok) throw new Error("Original PDF unavailable");
              sourceBytes = new Uint8Array(await response.arrayBuffer());
              if (!active) return;
              sourceCache.current = {
                id: v.sourceFileId,
                bytes: sourceBytes,
              };
            }
            const { renderOriginalWaiver } =
              await import("@/lib/pdfs/waiver-original");
            if (!active) return;
            const bytes = await renderOriginalWaiver(
              sourceBytes,
              v.draft,
              resolved,
              true,
            );
            blob = new Blob([new Uint8Array(bytes)], {
              type: "application/pdf",
            });
          } else
            blob = await pdf(
              <WaiverTemplateDocument
                draft={v.draft}
                sample={v.sample}
                values={v.values ? resolved : undefined}
                invoiceNumber={v.invoiceNumber}
              />,
            ).toBlob();
          if (!active) return;
          const next = URL.createObjectURL(blob);
          urls.current.push(next);
          setUrl(next);
          setError("");
        } catch (e) {
          if (active)
            setError(e instanceof Error ? e.message : "Preview unavailable");
        }
      })();
    }, 450);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [key]);
  if (error)
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {error}
      </p>
    );
  return url ? (
    <WaiverPdfPreview
      resetPageOnUrlChange={false}
      url={url}
      onReady={() => {
        const index = urls.current.indexOf(url);
        if (index > 0)
          urls.current.splice(0, index).forEach(URL.revokeObjectURL);
      }}
    />
  ) : (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      Preparing document…
    </p>
  );
}
