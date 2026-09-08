"use client";
import { useEffect, useRef, useState } from "react";
import { pdf } from "@react-pdf/renderer";
import { WaiverTemplateDocument } from "@/lib/pdfs/waiver-template";
import { WaiverPdfPreview } from "@/components/invoices/waiver-pdf-preview";
import type { WaiverTemplateDraft } from "@/lib/templates/waiver-template";
export default function LivePreview({
  draft,
  sample,
  values,
  invoiceNumber,
}: {
  draft: WaiverTemplateDraft;
  sample: boolean;
  values?: Record<string, string>;
  invoiceNumber?: string;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  const urls = useRef<string[]>([]);
  useEffect(
    () => () => {
      urls.current.forEach(URL.revokeObjectURL);
    },
    [],
  );
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    const timer = setTimeout(() => {
      void pdf(
        <WaiverTemplateDocument
          draft={draft}
          sample={sample}
          values={values}
          invoiceNumber={invoiceNumber}
        />,
      )
        .toBlob()
        .then((blob) => {
          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          urls.current.push(objectUrl);
          setUrl(objectUrl);
          setError(false);
        })
        .catch(() => {
          if (active) setError(true);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [draft, sample, values, invoiceNumber]);
  if (error)
    return (
      <div role="alert" className="p-10 text-sm text-muted-foreground">
        Preview unavailable. Try simplifying unsupported characters in the
        document.
      </div>
    );
  return url ? (
    <WaiverPdfPreview
      url={url}
      onReady={() => {
        const index = urls.current.indexOf(url);
        if (index > 0)
          urls.current.splice(0, index).forEach(URL.revokeObjectURL);
      }}
    />
  ) : (
    <div role="status" className="p-10 text-sm text-muted-foreground">
      Preparing preview…
    </div>
  );
}
