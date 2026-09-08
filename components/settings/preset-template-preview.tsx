"use client";
import { useEffect, useRef, useState } from "react";
import { pdf } from "@react-pdf/renderer";
import {
  PresetTemplateDocument,
  type PresetPreviewData,
} from "@/lib/pdfs/preset-template";
import { WaiverPdfPreview } from "@/components/invoices/waiver-pdf-preview";
export default function PresetTemplatePreview({
  data,
}: {
  data: PresetPreviewData;
}) {
  const serialized = JSON.stringify(data);
  const [url, setUrl] = useState<string>(),
    [error, setError] = useState(false);
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void pdf(<PresetTemplateDocument data={JSON.parse(serialized)} />)
        .toBlob()
        .then((blob) => {
          if (!active) return;
          const next = URL.createObjectURL(blob);
          urls.current.push(next);
          setUrl(next);
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
  }, [serialized]);
  if (error)
    return (
      <p role="alert" className="p-8 text-sm text-muted-foreground">
        Unable to render this preview. Your edits are still available.
      </p>
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
    <p role="status" className="p-8 text-sm text-muted-foreground">
      Preparing preview…
    </p>
  );
}
