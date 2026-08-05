"use client"

import * as React from "react"

import { PaymentAmountBreakdown } from "@/components/payables/payment-amount-breakdown"
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
import { Textarea } from "@/components/ui/textarea"
import { estimateSettlement, type ProviderSettlementWindow } from "@/lib/payments/settlement-estimate"
import type { PaymentRunListRow } from "@/lib/services/payment-runs"
import { cn } from "@/lib/utils"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

/** Bare `YYYY-MM-DD` in, readable date out — never constructed through a timezone. */
function readableDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(`${iso}T00:00:00Z`),
  )
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function amountsOf(run: PaymentRunListRow) {
  return {
    vendorAmountCents: run.vendor_amount_cents,
    processorFeeCents: run.processor_fee_cents,
    platformFeeCents: run.platform_fee_cents,
    totalDebitCents: run.total_debit_cents,
  }
}

/**
 * The vendor-receipt estimate for a given release date.
 *
 * Always rendered as a window and always labelled an estimate: ACH has no
 * guaranteed arrival, and the fintech gameplan forbids a "paid" claim that does
 * not say whose state it describes.
 */
function SettlementNote({
  releaseOn,
  window,
  className,
}: {
  releaseOn: string
  window: ProviderSettlementWindow
  className?: string
}) {
  const estimate = estimateSettlement({ initiatedOn: releaseOn, window })
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      Released {readableDate(releaseOn)} · vendor&rsquo;s bank should credit them{" "}
      <span className="text-foreground">
        {readableDate(estimate.vendorReceivesEarliest)}–{readableDate(estimate.vendorReceivesLatest)}
      </span>
      . Estimated from the rail&rsquo;s normal {estimate.maxBusinessDays} business-day window; bank
      holidays and returns can push it later.
    </p>
  )
}

export function SubmitPaymentRunDialog({
  run,
  open,
  onOpenChange,
  settlementWindow,
  passThroughProcessorFees,
  approverSummary,
  billDueDates,
  pending,
  onSubmit,
}: {
  run: PaymentRunListRow
  open: boolean
  onOpenChange: (open: boolean) => void
  settlementWindow: ProviderSettlementWindow
  passThroughProcessorFees: boolean
  /** One line naming who this routes to, so the preparer knows before submitting. */
  approverSummary: string
  /** Due dates of the bills in this run, for the "pays late" warning. */
  billDueDates: string[]
  pending: boolean
  onSubmit: (scheduledFor: string | null) => void
}) {
  const [mode, setMode] = React.useState<"asap" | "date">("asap")
  const [date, setDate] = React.useState("")

  React.useEffect(() => {
    if (!open) return
    setMode("asap")
    setDate("")
  }, [open])

  const scheduledFor = mode === "date" && date ? date : null
  const releaseOn = scheduledFor ?? todayIso()
  const estimate = estimateSettlement({ initiatedOn: releaseOn, window: settlementWindow })
  const lateBills = billDueDates.filter((due) => due < estimate.vendorReceivesLatest)
  const dateInvalid = mode === "date" && (!date || date < todayIso())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit {money(run.total_debit_cents)} for approval</DialogTitle>
          <DialogDescription>{approverSummary}</DialogDescription>
        </DialogHeader>

        <section className="border bg-muted/20 px-4 py-3">
          <PaymentAmountBreakdown
            amounts={amountsOf(run)}
            passThroughProcessorFees={passThroughProcessorFees}
          />
        </section>

        <fieldset className="space-y-3">
          <legend className="microlabel text-muted-foreground">When should this be paid?</legend>
          <div className="flex">
            {(
              [
                { key: "asap", label: "As soon as approved" },
                { key: "date", label: "On a date" },
              ] as const
            ).map((option, index) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setMode(option.key)}
                aria-pressed={mode === option.key}
                className={cn(
                  "h-8 border border-border px-3 text-xs transition-colors",
                  index > 0 && "-ml-px",
                  mode === option.key
                    ? "relative z-10 bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {mode === "date" ? (
            <div className="space-y-1.5">
              <Label htmlFor="payment-run-schedule" className="text-xs">
                Release date
              </Label>
              <Input
                id="payment-run-schedule"
                type="date"
                min={todayIso()}
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="h-8 w-48 text-xs"
              />
            </div>
          ) : null}

          {mode === "asap" || date ? (
            <SettlementNote releaseOn={releaseOn} window={settlementWindow} />
          ) : null}

          {lateBills.length > 0 ? (
            <p className="border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
              <span className="font-medium">
                {lateBills.length} {lateBills.length === 1 ? "bill lands" : "bills land"} after{" "}
                {lateBills.length === 1 ? "its" : "their"} due date
              </span>{" "}
              on this schedule, at the slow end of the estimate.
            </p>
          ) : null}
        </fieldset>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(scheduledFor)} disabled={pending || dateInvalid}>
            {pending ? "Submitting…" : "Submit for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ApprovePaymentRunDialog({
  run,
  open,
  onOpenChange,
  settlementWindow,
  passThroughProcessorFees,
  pending,
  onDecide,
}: {
  run: PaymentRunListRow
  open: boolean
  onOpenChange: (open: boolean) => void
  settlementWindow: ProviderSettlementWindow
  passThroughProcessorFees: boolean
  pending: boolean
  onDecide: (decision: "approved" | "rejected", reason?: string) => void
}) {
  const [rejecting, setRejecting] = React.useState(false)
  const [reason, setReason] = React.useState("")

  React.useEffect(() => {
    if (!open) return
    setRejecting(false)
    setReason("")
  }, [open])

  const releaseOn = run.scheduled_for ?? todayIso()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Release {money(run.total_debit_cents)} from your bank?</DialogTitle>
          <DialogDescription>
            {run.payment_count} {run.payment_count === 1 ? "bill" : "bills"} ·{" "}
            {run.approvals.filter((approval) => approval.decision === "approved").length} of{" "}
            {run.required_approvals} approvals recorded
          </DialogDescription>
        </DialogHeader>

        <section className="border bg-muted/20 px-4 py-3">
          <PaymentAmountBreakdown
            amounts={amountsOf(run)}
            passThroughProcessorFees={passThroughProcessorFees}
          />
        </section>

        <div className="space-y-2">
          <p className="text-xs">
            {run.scheduled_for ? (
              <>
                Scheduled for release on{" "}
                <span className="font-medium">{readableDate(run.scheduled_for)}</span>.
              </>
            ) : (
              <>Releases as soon as approval completes.</>
            )}
          </p>
          <SettlementNote releaseOn={releaseOn} window={settlementWindow} />
        </div>

        <ul className="max-h-40 space-y-1 overflow-y-auto border-t pt-3 text-xs text-muted-foreground">
          {run.items.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-3">
              <span className="truncate">
                <span className="text-foreground">{item.billNumber}</span> · {item.vendorName} ·{" "}
                {item.projectName}
                {item.releasableAtSubmission ? "" : " · review release evidence"}
              </span>
              <span className="shrink-0 font-mono tabular-nums">{money(item.vendorAmountCents)}</span>
            </li>
          ))}
        </ul>

        {rejecting ? (
          <div className="space-y-1.5">
            <Label htmlFor="payment-run-reject-reason" className="text-xs">
              Why are you rejecting this run?
            </Label>
            <Textarea
              id="payment-run-reject-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="The preparer sees this and builds a corrected run."
            />
          </div>
        ) : null}

        <DialogFooter>
          {rejecting ? (
            <>
              <Button variant="outline" onClick={() => setRejecting(false)} disabled={pending}>
                Back
              </Button>
              <Button
                variant="destructive"
                onClick={() => onDecide("rejected", reason.trim())}
                disabled={pending || reason.trim().length < 8}
              >
                {pending ? "Rejecting…" : "Reject run"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setRejecting(true)} disabled={pending}>
                Reject
              </Button>
              <Button onClick={() => onDecide("approved")} disabled={pending}>
                {pending ? "Recording…" : `Approve ${money(run.total_debit_cents)}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
