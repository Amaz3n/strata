"use client"

import { useState } from "react"
import { toast } from "sonner"
import { recordCustomerRefundAction } from "@/app/(app)/payments/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { formatMoneyCentsExact } from "@/lib/utils"

export function RecordCustomerRefund({ paymentId, availableCents, externalProvider, onRecorded }: { paymentId: string; availableCents: number; externalProvider?: string; onRecorded: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [pending, setPending] = useState(false)
  const [key, setKey] = useState("")
  async function submit() {
    const amountCents = Math.round(Number(amount) * 100)
    if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > availableCents) return toast.error("Enter an amount within the available payment balance")
    if (!reason.trim()) return toast.error("Enter a refund reason")
    setPending(true)
    try {
      const result = await recordCustomerRefundAction({ paymentId, amountCents, reason, idempotencyKey: key })
      if (!result.success) { toast.error(result.error); return }
      toast.success("Refund recorded")
      setOpen(false)
      setKey("")
      try { await onRecorded() } catch { toast.info("Reload the invoice to see the recorded refund") }
    } catch (error) {
      toast.error("Could not confirm the refund", { description: error instanceof Error ? error.message : "Retry with the same details." })
    } finally { setPending(false) }
  }
  return <>
    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={availableCents <= 0} onClick={() => { if (!key) { setKey(crypto.randomUUID()); setAmount((availableCents / 100).toFixed(2)); setReason("") } setOpen(true) }}>Record refund</Button>
    <Dialog open={open} onOpenChange={value => { if (!pending) setOpen(value) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Record a refund</DialogTitle><DialogDescription>Use this after returning the money outside Arc. This records the refund and updates the customer’s balance.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit() }}>
          <label className="block space-y-1 text-sm">Amount<Input type="number" min="0.01" max={(availableCents / 100).toFixed(2)} step="0.01" required value={amount} onChange={event => setAmount(event.target.value)} disabled={pending} /><span className="text-xs text-muted-foreground">Available {formatMoneyCentsExact(availableCents)}</span></label>
          <label className="block space-y-1 text-sm">Reason / reference<Textarea value={reason} onChange={event => setReason(event.target.value)} required maxLength={500} disabled={pending} /></label>
          <p className="text-xs text-muted-foreground">Returning an invoice payment makes that amount outstanding again. Add a credit memo if the customer no longer owes it.</p>
          {externalProvider ? <p className="text-xs text-muted-foreground">Record the matching refund in {externalProvider} as well. Arc flags the invoice for accounting review.</p> : null}
          <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={pending}>{pending ? "Recording…" : "Record refund"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>
}
