"use client"

import { useEffect, useMemo, useState } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { createReceivableAdjustmentAction } from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { Invoice } from "@/lib/types"

import { balanceCentsOf, formatMoneyFromCents } from "./invoice-presentation"

interface ReceivableAdjustmentDialogProps {
  invoice: Invoice | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onPosted: () => void | Promise<void>
}

function currencyToCents(value: string) {
  const normalized = value.replace(/[$,\s]/g, "")
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null
  return Math.round(Number(normalized) * 100)
}

export function ReceivableAdjustmentDialog({ invoice, open, onOpenChange, onPosted }: ReceivableAdjustmentDialogProps) {
  const balanceCents = invoice ? balanceCentsOf(invoice) : 0
  const [kind, setKind] = useState<"credit_memo" | "write_off">("credit_memo")
  const [amount, setAmount] = useState("")
  const [tax, setTax] = useState("0.00")
  const [taxableBase, setTaxableBase] = useState("")
  const [exemptBase, setExemptBase] = useState("")
  const [effectiveDate, setEffectiveDate] = useState(format(new Date(), "yyyy-MM-dd"))
  const [reason, setReason] = useState("")
  const [idempotencyKey, setIdempotencyKey] = useState("")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setKind("credit_memo")
    setAmount("")
    setTax("0.00")
    setTaxableBase(""); setExemptBase("")
    setEffectiveDate(format(new Date(), "yyyy-MM-dd"))
    setReason("")
    setIdempotencyKey(`${invoice?.id ?? "invoice"}:${crypto.randomUUID()}`)
  }, [open, invoice?.id])

  const amountCents = useMemo(() => currencyToCents(amount), [amount])
  const taxCents = useMemo(() => currencyToCents(tax), [tax])
  const taxableBaseCents = taxableBase.trim() ? currencyToCents(taxableBase) : undefined
  const exemptBaseCents = exemptBase.trim() ? currencyToCents(exemptBase) : undefined
  const invalid =
    (kind === "credit_memo" && (taxableBaseCents === null || exemptBaseCents === null || (taxableBaseCents ?? 0) < 0 || (exemptBaseCents ?? 0) < 0 || (taxableBaseCents ?? 0) + (exemptBaseCents ?? 0) > (amountCents ?? 0) - (taxCents ?? 0))) ||
    !invoice ||
    amountCents === null ||
    amountCents <= 0 ||
    amountCents > balanceCents ||
    taxCents === null ||
    taxCents < 0 ||
    taxCents > amountCents ||
    reason.trim().length < 3 ||
    !idempotencyKey ||
    !effectiveDate

  async function submit() {
    if (!invoice || invalid || amountCents === null || taxCents === null) return
    setSubmitting(true)
    try {
      unwrapAction(await createReceivableAdjustmentAction({
        invoiceId: invoice.id,
        adjustmentType: kind,
        amountCents,
        taxCents: kind === "credit_memo" ? taxCents : 0,
        ...(kind === "credit_memo" ? { taxableBaseCents: taxableBaseCents ?? undefined, exemptBaseCents: exemptBaseCents ?? undefined } : {}),
        effectiveDate,
        reason: reason.trim(),
        idempotencyKey,
      }))
      toast.success(kind === "credit_memo" ? "Credit memo posted" : "Balance written off")
      onOpenChange(false)
      await onPosted()
    } catch (error) {
      toast.error("Could not adjust invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust invoice balance</DialogTitle>
          <DialogDescription>
            Open balance: {formatMoneyFromCents(balanceCents)}. This posts to AR and Arc Books with a permanent audit trail.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Adjustment type">
            <Button type="button" variant={kind === "credit_memo" ? "default" : "outline"} onClick={() => setKind("credit_memo")}>
              Credit memo
            </Button>
            <Button type="button" variant={kind === "write_off" ? "default" : "outline"} onClick={() => setKind("write_off")}>
              Write off
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="adjustment-amount">Amount</Label>
              <Input id="adjustment-amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus />
              {amountCents !== null && amountCents > balanceCents ? <p className="text-xs text-destructive">Cannot exceed the open balance.</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adjustment-date">Effective date</Label>
              <Input id="adjustment-date" type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} />
            </div>
          </div>

          {kind === "credit_memo" ? (
            <div className="space-y-1.5">
              <Label htmlFor="adjustment-tax">Sales tax included in credit</Label>
              <Input id="adjustment-tax" inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} />
              <p className="text-xs text-muted-foreground">Use zero unless the credit reverses taxable work.</p>
              <Label htmlFor="adjustment-taxable-base">Taxable work credited, before tax</Label><Input id="adjustment-taxable-base" inputMode="decimal" value={taxableBase} onChange={event => setTaxableBase(event.target.value)} placeholder="Unclassified" />
              <Label htmlFor="adjustment-exempt-base">Exempt work credited</Label><Input id="adjustment-exempt-base" inputMode="decimal" value={exemptBase} onChange={event => setExemptBase(event.target.value)} placeholder="Unclassified" />
              <p className="text-xs text-muted-foreground">Any remaining pre-tax credit stays unclassified for the tax review.</p>
            </div>
          ) : (
            <p className="border bg-muted/40 p-3 text-xs text-muted-foreground">A write-off keeps revenue intact and posts the loss to Bad debt expense.</p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="adjustment-reason">Reason</Label>
            <Input id="adjustment-reason" maxLength={500} placeholder={kind === "credit_memo" ? "Scope credit, allowance, correction…" : "Uncollectible balance…"} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={invalid || submitting}>
            {submitting ? "Posting…" : kind === "credit_memo" ? "Post credit memo" : "Write off balance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
