"use client"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import { DOCUMENT_NUMBER_KINDS, formatDocNumber, type DocumentNumberKind, type DocumentNumberingSettings } from "@/lib/document-number"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { updateDocumentNumberingAction } from "./actions"

const LABELS: Record<DocumentNumberKind, string> = { rfi: "RFI", submittal: "Submittal", change_order: "Change order", meeting: "Meeting", transmittal: "Transmittal" }

export function DocumentNumberingForm({ initial }: { initial: DocumentNumberingSettings }) {
  const [settings, setSettings] = useState<DocumentNumberingSettings>(initial)
  const [pending, startTransition] = useTransition()
  const update = (kind: DocumentNumberKind, field: "prefix" | "pad", value: string) => setSettings((current) => ({ ...current, [kind]: { ...current[kind], [field]: field === "pad" ? Number(value) : value } }))
  return <form className="max-w-3xl border" onSubmit={(event) => { event.preventDefault(); startTransition(() => { void updateDocumentNumberingAction(settings).then((result) => { unwrapAction(result); toast.success("Document numbering saved") }).catch((error) => toast.error(error instanceof Error ? error.message : "Unable to save")) }) }}>
    <div className="grid grid-cols-[1fr_180px_100px_120px] gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><span>Document</span><span>Prefix</span><span>Padding</span><span>Preview</span></div>
    {DOCUMENT_NUMBER_KINDS.map((kind) => <div key={kind} className="grid grid-cols-[1fr_180px_100px_120px] items-center gap-3 border-b px-4 py-3 last:border-0"><label htmlFor={`${kind}-prefix`} className="text-sm font-medium">{LABELS[kind]}</label><Input id={`${kind}-prefix`} value={settings[kind]?.prefix ?? ""} placeholder="No prefix" onChange={(event) => update(kind, "prefix", event.target.value)} /><Input aria-label={`${LABELS[kind]} padding`} type="number" min={0} max={12} value={settings[kind]?.pad ?? 0} onChange={(event) => update(kind, "pad", event.target.value)} /><span className="font-mono text-sm">{formatDocNumber(kind, 7, settings)}</span></div>)}
    <div className="flex items-center justify-between border-t p-4"><p className="text-xs text-muted-foreground">Stored sequence numbers stay unchanged; this only controls display.</p><Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save numbering"}</Button></div>
  </form>
}

