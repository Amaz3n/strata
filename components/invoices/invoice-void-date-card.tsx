"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { recordInvoiceVoidDateAction } from "@/app/(app)/invoices/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { Invoice } from "@/lib/types"

/**
 * A void Arc never dated is left out of receivables at every past date. The
 * person who knows when it happened records it, with what the date rests on.
 */
export function InvoiceVoidDateCard({ invoice, onChanged }: { invoice: Invoice; onChanged: () => void | Promise<void> }) {
  const lastChanged = invoice.updated_at?.slice(0, 10)
  const [voidedOn, setVoidedOn] = useState("")
  const [basis, setBasis] = useState("")
  const [pending, startTransition] = useTransition()
  const save = () => startTransition(async () => {
    try {
      unwrapAction(await recordInvoiceVoidDateAction({ invoiceId: invoice.id, voidedOn, basis }))
      toast.success("Void date recorded", { description: "Past receivables now count this invoice until that day." })
      await onChanged()
    } catch (error) {
      toast.error("Could not record the void date", { description: error instanceof Error ? error.message : "Please try again." })
    }
  })
  return (
    <section aria-label="Void date" className="space-y-3 border border-warning/40 bg-warning/5 p-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Void date unknown</h3>
        <p className="text-xs text-muted-foreground">
          This invoice was voided before Arc recorded when, so it is left out of receivables aging at every past date.
          Record the day it was voided{lastChanged ? ` (on or before ${lastChanged}, when it last changed)` : ""}.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <Input type="date" aria-label="Voided on" value={voidedOn} min={invoice.issue_date ?? undefined} max={lastChanged} onChange={(event) => setVoidedOn(event.target.value)} />
        <Textarea aria-label="What the date rests on" rows={2} placeholder="What the date rests on, such as the void record in the accounting system" value={basis} onChange={(event) => setBasis(event.target.value)} />
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={pending || !voidedOn || basis.trim().length < 5} onClick={save}>{pending ? "Recording…" : "Record void date"}</Button>
      </div>
    </section>
  )
}
