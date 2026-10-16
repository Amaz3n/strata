"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { listShortageVpoReasonsAction, resolvePoShortageAction } from "@/app/(app)/purchasing/delivery-actions"
import { formatDay, formatQuantity } from "@/components/purchasing/delivery-format"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import type { DeliveryLine } from "@/lib/services/po-receipts"

type Resolution = "backordered" | "vpo" | "accepted_short" | "cancelled"

const OPTIONS: Array<{ value: Resolution; label: string; hint: string }> = [
  { value: "backordered", label: "Back-order", hint: "The vendor promises it for a new date; the clock restarts." },
  { value: "vpo", label: "Raise a VPO", hint: "Buy the replacement from this vendor or another through a variance order." },
  { value: "accepted_short", label: "Accept short", hint: "Build with what arrived. Needs a reason." },
  { value: "cancelled", label: "Cancel the rest", hint: "The remainder of this line is no longer needed. Needs a reason." },
]

const asResolution = (value: string): Resolution =>
  value === "vpo" || value === "accepted_short" || value === "cancelled" ? value : "backordered"

/** Purchasing's decision on one short line. The desk reads; this calls the same service the order's sheet does. */
export function ResolveShortageDialog({ line, open, onOpenChange, onDone }: {
  line: DeliveryLine
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const [resolution, setResolution] = useState<Resolution>("backordered")
  const [date, setDate] = useState("")
  const [note, setNote] = useState("")
  const [reasons, setReasons] = useState<Array<{ id: string; label: string }> | null>(null)
  const [reasonId, setReasonId] = useState("")
  const [quantity, setQuantity] = useState(String(line.outstanding))
  const [unitCost, setUnitCost] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setResolution("backordered"); setDate(""); setNote(""); setError(null); setQuantity(String(line.outstanding)); setUnitCost("")
  }, [open, line.outstanding])

  useEffect(() => {
    if (!open || resolution !== "vpo" || reasons) return
    void listShortageVpoReasonsAction().then((result) => {
      if (!result.success) { setError(result.error); return }
      setReasons(result.data)
      setReasonId((current) => current || result.data[0]?.id || "")
    }).catch(() => setError("Unable to load variance reasons."))
  }, [open, resolution, reasons])

  const cents = parseMoneyToCents(unitCost)
  const quantityValue = Number(quantity)
  const valid = resolution === "backordered" ? date !== ""
    : resolution === "vpo" ? Boolean(reasonId) && cents !== null && unitCost.trim() !== "" && quantityValue > 0
      : note.trim().length >= 3

  function submit() {
    if (!line.shortageId || !valid) return
    setError(null)
    startTransition(async () => {
      try {
        const result = await resolvePoShortageAction({
          shortageId: line.shortageId,
          resolution,
          backorderDate: resolution === "backordered" ? date : undefined,
          note: note.trim() || undefined,
          vpo: resolution === "vpo" && cents !== null ? { reasonCodeId: reasonId, quantity: quantityValue, unitCostCents: cents } : undefined,
        }, line.projectId)
        if (!result.success) { setError(result.error); return }
        toast.success(resolution === "vpo" ? "Variance order raised for approval" : "Shortage updated")
        onOpenChange(false)
        onDone?.()
      } catch {
        setError("Unable to confirm the result. Refresh the queue before retrying.")
      }
    })
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Resolve shortage</DialogTitle>
        <DialogDescription>{line.description} · {line.poTitle} · {line.projectName}. {formatQuantity(line.outstanding)} {line.unit} outstanding, needed {formatDay(line.neededBy)}.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5 text-xs">
        <Label htmlFor="shortage-resolution">What happens next</Label>
        <select id="shortage-resolution" value={resolution} disabled={pending} onChange={(event) => setResolution(asResolution(event.target.value))} className="h-9 border bg-background px-3 text-sm">
          {OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <p className="text-muted-foreground">{OPTIONS.find((option) => option.value === resolution)?.hint}</p>
      </div>
      {resolution === "backordered" && <div className="grid gap-1.5 text-xs"><Label htmlFor="shortage-date">Promised for</Label><Input id="shortage-date" type="date" value={date} disabled={pending} onChange={(event) => setDate(event.target.value)} /></div>}
      {resolution === "vpo" && <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5 text-xs sm:col-span-3"><Label htmlFor="shortage-reason">Reason</Label>
          <select id="shortage-reason" value={reasonId} disabled={pending || !reasons} onChange={(event) => setReasonId(event.target.value)} className="h-9 border bg-background px-3 text-sm">
            {(reasons ?? []).map((reason) => <option key={reason.id} value={reason.id}>{reason.label}</option>)}
          </select></div>
        <div className="grid gap-1.5 text-xs"><Label htmlFor="shortage-quantity">Quantity</Label><Input id="shortage-quantity" type="number" min="0" step="any" value={quantity} disabled={pending} onChange={(event) => setQuantity(event.target.value)} className="tabular-nums" /></div>
        <div className="grid gap-1.5 text-xs"><Label htmlFor="shortage-cost">Unit cost (dollars)</Label><Input id="shortage-cost" type="number" min="0" step="0.01" value={unitCost} disabled={pending} onChange={(event) => setUnitCost(event.target.value)} className="tabular-nums" /></div>
      </div>}
      <div className="grid gap-1.5 text-xs"><Label htmlFor="shortage-note">{resolution === "accepted_short" || resolution === "cancelled" ? "Reason" : "Note (optional)"}</Label>
        <Textarea id="shortage-note" rows={2} value={note} maxLength={2000} disabled={pending} onChange={(event) => setNote(event.target.value)} /></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="button" disabled={pending || !valid} onClick={submit}>{pending ? "Saving…" : "Save"}</Button>
      </div>
    </DialogContent>
  </Dialog>
}
