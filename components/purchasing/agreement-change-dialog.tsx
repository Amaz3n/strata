"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { endPriceAgreementAction, getAgreementImpactAction, repriceAgreementAction, voidPriceAgreementAction } from "@/app/(app)/purchasing/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import type { PriceAgreement } from "@/lib/services/price-book"

export type AgreementChange = { kind: "reprice" | "end" | "void"; agreement: PriceAgreement }

const TITLES = { reprice: "Reprice agreement", end: "End agreement", void: "Void agreement" } as const
const DONE = { reprice: "Agreement repriced with a new history row", end: "Agreement end date set", void: "Agreement voided" } as const

const dayAfter = (date: string) => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

/**
 * The one place a price agreement changes after it is in force. Reprice, end and
 * void all carry a reason, and all show the purchase orders already priced from
 * the agreement before the buyer commits; those orders keep their price.
 */
export function AgreementChangeDialog({ change, onClose }: { change: AgreementChange | null; onClose: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [reason, setReason] = useState("")
  const [price, setPrice] = useState("")
  const [date, setDate] = useState("")
  const [impact, setImpact] = useState<{ affectedPoCount: number } | null>(null)
  const [impactError, setImpactError] = useState<string | null>(null)
  const [impactTry, setImpactTry] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const agreement = change?.agreement

  useEffect(() => {
    if (!agreement) return
    let active = true
    setReason("")
    setPrice("")
    setError(null)
    setImpact(null)
    setImpactError(null)
    setDate(change?.kind === "reprice" ? new Date().toISOString().slice(0, 10) : agreement.effective_to ?? new Date().toISOString().slice(0, 10))
    getAgreementImpactAction(agreement.id).then((result) => {
      if (!active) return
      if (result.success) setImpact(result.data)
      else setImpactError(result.error)
    })
    return () => {
      active = false
    }
  }, [agreement, change?.kind, impactTry])

  if (!change || !agreement) return null
  const cents = parseMoneyToCents(price)
  const minDate = change.kind === "reprice" ? dayAfter(agreement.effective_from) : agreement.effective_from
  const dateOk = change.kind === "void" || (date >= minDate && (!agreement.effective_to || date <= agreement.effective_to))
  const valid = impact !== null && reason.trim().length >= 3 && dateOk && (change.kind !== "reprice" || (price.trim() !== "" && cents !== null && cents >= 0))

  function submit() {
    if (!change || !agreement || !valid) return
    setError(null)
    startTransition(async () => {
      try {
        const result = change.kind === "reprice"
          ? await repriceAgreementAction(agreement.id, {
              effective_from: date, reason: reason.trim(),
              unit_cost_cents: agreement.pricing_kind === "unit" ? cents : null,
              lump_sum_cents: agreement.pricing_kind === "lump_sum" ? cents : null,
            })
          : change.kind === "end"
            ? await endPriceAgreementAction(agreement.id, { effective_to: date, reason: reason.trim() })
            : await voidPriceAgreementAction(agreement.id, { reason: reason.trim() })
        if (!result.success) { setError(result.error); return }
        const orders = result.data.affectedPoCount
        toast.success(DONE[change.kind], orders ? { description: `${orders} purchase order${orders === 1 ? "" : "s"} already priced from it keep their price.` } : undefined)
        onClose()
        router.refresh()
      } catch {
        setError("Unable to confirm the result. Refresh the price book before retrying.")
      }
    })
  }

  return <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose() }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{TITLES[change.kind]}</DialogTitle>
        <DialogDescription>{agreement.company_name} · {agreement.cost_code_code} {agreement.cost_code_name}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        {change.kind === "reprice" && <div className="space-y-1.5">
          <Label htmlFor="agreement-price">New price (dollars{agreement.pricing_kind === "unit" ? ` per ${agreement.uom}` : ", lump sum"})</Label>
          <Input id="agreement-price" inputMode="decimal" value={price} disabled={pending} onChange={(event) => setPrice(event.target.value)} aria-invalid={price !== "" && cents === null} />
          {price !== "" && cents === null && <p className="text-xs text-destructive">Enter a dollar amount.</p>}
        </div>}
        {change.kind !== "void" && <div className="space-y-1.5">
          <Label htmlFor="agreement-date">{change.kind === "reprice" ? "Effective from" : "Ends on"}</Label>
          <Input id="agreement-date" type="date" min={minDate} max={agreement.effective_to ?? undefined} value={date} disabled={pending} onChange={(event) => setDate(event.target.value)} className="w-44" aria-invalid={!dateOk} />
          {!dateOk && <p className="text-xs text-destructive">{change.kind === "reprice" ? "The new price starts after the current one and before it ends." : "An agreement can end earlier, not later, and not before it starts."}</p>}
        </div>}
        <div className="space-y-1.5">
          <Label htmlFor="agreement-reason">Why</Label>
          <Textarea id="agreement-reason" rows={3} maxLength={1000} value={reason} disabled={pending} onChange={(event) => setReason(event.target.value)} />
        </div>
        {impactError
          ? <p role="alert" className="flex items-center justify-between gap-3 border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">Could not count the orders priced from this agreement: {impactError}<Button size="sm" variant="outline" onClick={() => setImpactTry((n) => n + 1)}>Retry</Button></p>
          : impact === null
          ? <div className="h-9 animate-pulse bg-muted" aria-busy="true" />
          : <p className="border bg-muted/30 px-3 py-2 text-sm">
              <span className="font-semibold tabular-nums">{impact.affectedPoCount}</span> open purchase order{impact.affectedPoCount === 1 ? "" : "s"} priced from this agreement{impact.affectedPoCount ? "; they keep their price and the change applies to orders generated from now on" : ""}.
            </p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
        <Button variant={change.kind === "void" ? "destructive" : "default"} onClick={submit} disabled={pending || !valid}>{pending ? "Saving…" : TITLES[change.kind]}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
