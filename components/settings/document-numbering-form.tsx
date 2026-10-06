"use client"

import { useEffect, useRef, useState, useTransition } from "react"
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
  canManage = true,
}: {
  initial: DocumentNumberingSettings
  onSaved?: (next: DocumentNumberingSettings) => void
  canManage?: boolean
}) {
  type Field = { kind: DocumentNumberKind; field: "prefix" | "pad" }
  const [state, setState] = useState({
    source: initial,
    baseline: initial,
    settings: initial,
    dirty: [] as Field[],
  })
  if (state.source !== initial) {
    const settings = { ...initial }
    const dirty = state.dirty.filter(({ kind, field }) =>
      (state.settings[kind]?.[field] ?? (field === "pad" ? 0 : "")) !==
      (initial[kind]?.[field] ?? (field === "pad" ? 0 : "")),
    )
    for (const { kind, field } of dirty) {
      settings[kind] = { ...settings[kind], [field]: state.settings[kind]?.[field] }
    }
    setState({ source: initial, baseline: initial, settings, dirty })
  }
  const { settings } = state
  const [pending, startTransition] = useTransition()
  const mounted = useRef(false)
  const inFlight = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const update = (kind: DocumentNumberKind, field: "prefix" | "pad", value: string) => {
    const next = field === "pad" ? Number(value) : value
    setState((current) => {
      const dirty = current.dirty.filter((entry) => entry.kind !== kind || entry.field !== field)
      if (next !== (current.baseline[kind]?.[field] ?? (field === "pad" ? 0 : ""))) {
        dirty.push({ kind, field })
      }
      return {
        ...current,
        settings: { ...current.settings, [kind]: { ...current.settings[kind], [field]: next } },
        dirty,
      }
    })
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!mounted.current || inFlight.current || !canManage) return
    inFlight.current = true
    startTransition(async () => {
      try {
        const result = await updateDocumentNumberingAction(settings)
        if (!mounted.current) return
        const next = unwrapAction(result)
        setState((current) => current.source === state.source
          ? { ...current, baseline: next, settings: next, dirty: [] }
          : current)
        toast.success("Document numbering saved")
        onSaved?.(next)
      } catch (error) {
        if (!mounted.current) return
        toast.error(error instanceof Error ? error.message : "Unable to save")
      } finally {
        inFlight.current = false
      }
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      <fieldset disabled={pending || !canManage} className="min-w-0">
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
          <Button type="submit" disabled={pending || !canManage}>
            {pending ? "Saving…" : "Save numbering"}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
