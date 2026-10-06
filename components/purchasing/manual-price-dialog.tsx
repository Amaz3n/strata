"use client"

import { useState, useTransition } from "react"
import { resolvePoExceptionAction } from "@/app/(app)/purchasing/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { PurchasingEntityPicker, type PurchasingEntity } from "@/components/purchasing/entity-picker"
import { toast } from "sonner"
import { parseMoneyToCents } from "@/lib/financials/money-input"

export function ManualPriceDialog({ exceptionId, description, uom }: { exceptionId: string; description: string; uom: string | null }) {
  const [open, setOpen] = useState(false)
  const [vendor, setVendor] = useState<PurchasingEntity | null>(null)
  const [price, setPrice] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const cents = parseMoneyToCents(price)
  const valid = vendor && price.trim() !== "" && cents !== null && cents >= 0 && note.trim().length > 0

  function submit() {
    if (!valid || !vendor) return
    setError(null)
    startTransition(async () => {
      try {
        const result = await resolvePoExceptionAction(exceptionId, { kind: "manual", company_id: vendor.id, unit_cost_cents: cents, note: note.trim() })
        if (!result.success) { setError(result.error); return }
        toast.success("Exception resolved and affected purchase orders regenerated")
        setOpen(false)
      } catch {
        setError("Unable to confirm the resolution. Refresh the queue before retrying.")
      }
    })
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next) }}>
    <DialogTrigger asChild><Button size="sm" variant="ghost">Manual price</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Resolve with a manual price</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      {open && <PurchasingEntityPicker kind="vendor" value={vendor} disabled={pending} onChange={setVendor} />}
      <Label htmlFor={`price-${exceptionId}`}>Price per {uom || "unit"} (dollars)</Label>
      <Input id={`price-${exceptionId}`} type="number" min="0" step="0.01" value={price} disabled={pending} onChange={(event) => setPrice(event.target.value)} />
      <Label htmlFor={`note-${exceptionId}`}>Reason for manual pricing</Label>
      <Textarea id={`note-${exceptionId}`} value={note} maxLength={1000} disabled={pending} onChange={(event) => setNote(event.target.value)} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={pending || !valid} onClick={submit}>{pending ? "Resolving…" : "Resolve and regenerate"}</Button>
    </DialogContent>
  </Dialog>
}
