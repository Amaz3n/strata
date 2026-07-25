"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { unwrapAction } from "@/lib/action-result"
import {
  DOCUMENT_NUMBER_KINDS,
  formatDocNumber,
  type DocumentNumberKind,
  type DocumentNumberingSettings,
} from "@/lib/document-number"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { updateDocumentNumberingAction } from "@/app/(app)/settings/actions"

const LABELS: Record<DocumentNumberKind, string> = {
  rfi: "RFI",
  submittal: "Submittal",
  change_order: "Change order",
  meeting: "Meeting",
  transmittal: "Transmittal",
}

export function DocumentNumberingForm({
  initial,
  onSaved,
}: {
  initial: DocumentNumberingSettings
  onSaved?: (next: DocumentNumberingSettings) => void
}) {
  const [settings, setSettings] = useState<DocumentNumberingSettings>(initial)
  const [pending, startTransition] = useTransition()

  const update = (kind: DocumentNumberKind, field: "prefix" | "pad", value: string) =>
    setSettings((current) => ({
      ...current,
      [kind]: { ...current[kind], [field]: field === "pad" ? Number(value) : value },
    }))

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    startTransition(() => {
      void updateDocumentNumberingAction(settings)
        .then((result) => {
          unwrapAction(result)
          toast.success("Document numbering saved")
          onSaved?.(settings)
        })
        .catch((error) => toast.error(error instanceof Error ? error.message : "Unable to save"))
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="overflow-x-auto border border-border">
        <div className="grid min-w-[30rem] grid-cols-[1fr_160px_92px_120px] gap-3 border-b border-border bg-muted/40 px-4 py-2">
          <span className="microlabel">Document</span>
          <span className="microlabel">Prefix</span>
          <span className="microlabel">Padding</span>
          <span className="microlabel">Preview</span>
        </div>
        {DOCUMENT_NUMBER_KINDS.map((kind) => (
          <div
            key={kind}
            className="grid min-w-[30rem] grid-cols-[1fr_160px_92px_120px] items-center gap-3 border-b border-border px-4 py-3 last:border-0"
          >
            <label htmlFor={`${kind}-prefix`} className="text-sm font-medium">
              {LABELS[kind]}
            </label>
            <Input
              id={`${kind}-prefix`}
              value={settings[kind]?.prefix ?? ""}
              placeholder="No prefix"
              onChange={(event) => update(kind, "prefix", event.target.value)}
            />
            <Input
              aria-label={`${LABELS[kind]} padding`}
              type="number"
              min={0}
              max={12}
              value={settings[kind]?.pad ?? 0}
              onChange={(event) => update(kind, "pad", event.target.value)}
            />
            <span className="font-mono text-sm tabular-nums">{formatDocNumber(kind, 7, settings)}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Stored sequence numbers stay unchanged; this only controls display.
        </p>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save numbering"}
        </Button>
      </div>
    </form>
  )
}
