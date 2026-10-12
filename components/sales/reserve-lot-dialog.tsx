"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { cancelReservationConversionAction, convertHoldToReservationAction, inspectReservationConversionAction, registerReservationConversionAction } from "@/app/(app)/sales/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import { parseReservationDeposit, reservationDepositInput } from "@/lib/sales/reservation-deposit"
import { reservationConversionStateSchema, type ReservationConversionScope, type ReservationConversionState } from "@/lib/validation/reservation-conversion"
import { formatMoneyCents } from "@/lib/utils"

export interface ReserveLotTarget {
  reservationId: string
  conversionScope: ReservationConversionScope
  lotLabel: string | null
  /** Prefilled when a deposit was already agreed on the hold. */
  depositRequiredCents: number
  hasProject: boolean
}

/**
 * Taking the reservation: the moment a hold becomes a sale. The consultant
 * saves a review first (buyer, home, deposit), then reserving commits the home,
 * the earnest invoice and the lot assignment together in one database step, so
 * a collision or a failure leaves nothing half-made.
 */
export function ReserveLotDialog({ target, open, onOpenChange }: {
  target: ReserveLotTarget
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const scope = target.conversionScope
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const generation = useRef(0)
  const requestKey = useRef<string | null>(null)
  const [deposit, setDeposit] = useState("")
  const [projectName, setProjectName] = useState("")
  const [state, setState] = useState<ReservationConversionState | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { orgId, actorId, reservationId } = scope

  const readReply = useCallback((value: unknown, expectedKey?: string | null) => {
    const result = reservationConversionStateSchema.parse(value)
    if (result.scope.orgId !== orgId || result.scope.actorId !== actorId || result.scope.reservationId !== reservationId || (expectedKey && result.requestKey !== expectedKey)) throw new Error("This saved review belongs to another buyer file or signed-in context.")
    return result
  }, [orgId, actorId, reservationId])

  useEffect(() => {
    const epoch = ++generation.current
    if (!open) return
    setState(null); setError(null); setInitialized(false); setUnconfirmed(false); requestKey.current = null
    setDeposit(reservationDepositInput(target.depositRequiredCents > 0 ? target.depositRequiredCents : 500_000))
    setProjectName("")
    if (reservationId !== target.reservationId) {
      setError("Reload the buyer file to verify your reservation access."); setUnconfirmed(true); return
    }
    startTransition(async () => {
      try {
        const saved = unwrapAction(await inspectReservationConversionAction({ scope: { orgId, actorId, reservationId } }))
        if (generation.current !== epoch) return
        if (saved) {
          const original = readReply(saved)
          setState(original); requestKey.current = original.requestKey
          setDeposit(reservationDepositInput(original.input.depositCents)); setProjectName(original.input.projectName ?? "")
        }
        setInitialized(true)
      } catch {
        if (generation.current !== epoch) return
        setUnconfirmed(true); setError("The saved reservation review could not be checked. Check it again before preparing a new reservation.")
      }
    })
    return () => { ++generation.current }
    // Primitive identity fences recovery; rerendering the same buyer does not reset its review.
  }, [open, orgId, actorId, reservationId, target.reservationId, target.depositRequiredCents, readReply])

  const cents = parseReservationDeposit(deposit)
  const savedReview = state?.status === "pending" || state?.status === "changed"
  const editable = initialized && !pending && !unconfirmed && !savedReview && state?.status !== "committed"
  const operate = (operation: "review" | "commit" | "inspect" | "cancel") => {
    if (pending) return
    if (operation === "review" && (!editable || cents === null)) return
    const original = state
    const epoch = ++generation.current
    if (operation === "review") requestKey.current = crypto.randomUUID()
    const key = requestKey.current
    setError(null)
    startTransition(async () => {
      try {
        let value: unknown
        if (operation === "review") {
          value = unwrapAction(await registerReservationConversionAction({ scope, requestKey: key, input: { reservationId: scope.reservationId, depositCents: cents, ...(projectName.trim() ? { projectName: projectName.trim() } : {}) } }))
        } else if (operation === "inspect") {
          value = unwrapAction(await inspectReservationConversionAction({ scope, ...(key ? { requestKey: key } : {}) }))
          if (value === null && original && original.status !== "cancelled") throw new Error("The previously saved review is unavailable. Keep this buyer file for reconciliation before creating another reservation.")
        } else {
          if (!original || original.status === "committed" || original.status === "cancelled") throw new Error("Inspect the original saved review before continuing.")
          const input = { scope, requestKey: original.requestKey, input: original.input }
          value = unwrapAction(await (operation === "commit" ? convertHoldToReservationAction(input) : cancelReservationConversionAction(input)))
        }
        if (generation.current !== epoch) return
        if (value === null) { setState(null); requestKey.current = null; setUnconfirmed(false); setInitialized(true); return }
        const next = readReply(value, key)
        setState(next); requestKey.current = next.requestKey; setUnconfirmed(false); setInitialized(true)
        setDeposit(reservationDepositInput(next.input.depositCents)); setProjectName(next.input.projectName ?? "")
        if (next.status === "committed") {
          toast({ title: `Lot reserved for ${next.review.buyerName}`, description: next.input.depositCents > 0 ? `${formatMoneyCents(next.input.depositCents)} earnest invoice created. Delivery can be inspected from the home.` : "No deposit invoiced." })
          router.refresh()
        }
      } catch (failure) {
        if (generation.current !== epoch) return
        setUnconfirmed(true); setError(failure instanceof Error ? failure.message : "Reservation outcome could not be confirmed. Check the saved review.")
      }
    })
  }

  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value) }}>
    <DialogContent onEscapeKeyDown={event => { if (pending) event.preventDefault() }} onInteractOutside={event => { if (pending) event.preventDefault() }} className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Take the reservation{target.lotLabel ? ` on Lot ${target.lotLabel}` : ""}</DialogTitle>
        <DialogDescription>{savedReview ? "Review the saved buyer, home and deposit. Reserving commits them together." : "Prepare a review before opening the home, creating the earnest invoice and assigning the lot."}</DialogDescription>
      </DialogHeader>
      {!initialized && !error ? <div role="status" className="space-y-2 py-2"><div className="h-4 w-3/4 animate-pulse bg-muted" /><div className="h-4 w-1/2 animate-pulse bg-muted" /><span className="sr-only">Checking the saved reservation review</span></div> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {state?.status === "committed" ? <div className="space-y-2 text-sm"><p>This reservation is already saved. Its original home and deposit were recovered.</p>{state.receipt ? <Link className="underline underline-offset-4" href={`/projects/${state.receipt.projectId}`}>View home and deposit</Link> : null}</div> : savedReview && state ? <div className="space-y-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm"><dt className="text-muted-foreground">Buyer</dt><dd>{state.review.buyerName}</dd><dt className="text-muted-foreground">Lot</dt><dd>{state.review.lotLabel} · {state.review.communityName}</dd><dt className="text-muted-foreground">Home</dt><dd>{state.review.homeName}{state.review.createsHome ? " · opens with this reservation" : " · existing home"}</dd><dt className="text-muted-foreground">Deposit</dt><dd className="tabular-nums">{formatMoneyCents(state.input.depositCents)}</dd><dt className="text-muted-foreground">Email delivery</dt><dd>{state.review.recipients.join(", ") || "No email delivery requested"}</dd></dl>
        {state.status === "changed" ? <p role="alert" className="text-sm text-destructive">The buyer, lot or billing source changed. Cancel this saved review and prepare a current one.</p> : null}
      </div> : initialized ? <div className="space-y-3">
        <div className="space-y-1"><Label htmlFor="review-deposit">Earnest deposit</Label><Input id="review-deposit" inputMode="decimal" value={deposit} disabled={!editable} aria-invalid={deposit.trim() !== "" && cents === null} aria-describedby="review-deposit-help" onChange={event => setDeposit(event.target.value)} className="tabular-nums" /><p id="review-deposit-help" className="text-xs text-muted-foreground">{cents === null && deposit.trim() !== "" ? "Enter a supported deposit amount." : "Zero reserves the lot without an invoice."}</p></div>
        {!target.hasProject ? <div className="space-y-1"><Label htmlFor="review-home">Job name (optional)</Label><Input id="review-home" value={projectName} disabled={!editable} maxLength={200} onChange={event => setProjectName(event.target.value)} placeholder={target.lotLabel ? `Lot ${target.lotLabel}` : "Lot"} /></div> : null}
      </div> : null}
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Close</Button>
        {savedReview && state ? <Button variant="outline" disabled={pending || unconfirmed} onClick={() => operate("cancel")}>Cancel saved review</Button> : null}
        {unconfirmed || !initialized ? <Button disabled={pending} onClick={() => operate("inspect")}>{pending ? "Checking…" : "Check saved review"}</Button> : state?.status === "committed" ? null : savedReview ? <Button disabled={pending || state?.status !== "pending"} onClick={() => operate("commit")}>{pending ? "Reserving…" : "Reserve the lot"}</Button> : <Button disabled={!editable || cents === null} onClick={() => operate("review")}>{pending ? "Preparing…" : "Review reservation"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
