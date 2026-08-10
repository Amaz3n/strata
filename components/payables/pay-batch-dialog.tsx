"use client"

import * as React from "react"
import { toast } from "sonner"

import {
  discardPayableBatchAction,
  getPayableBatchSetupAction,
  preparePayableApprovalAction,
  submitPayableBatchAction,
  type PayableBatchEligibleBill,
} from "@/app/(app)/payables/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { discountStillEarnable } from "@/lib/payments/early-pay-discount"
import { quoteApDisbursementFee, type ApFeePolicy } from "@/lib/payments/fee-engine"
import { estimateSettlement, type ProviderSettlementWindow } from "@/lib/payments/settlement-estimate"
import type { PaymentApprovalRouting } from "@/lib/services/payment-approvers"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { vendorLabel } from "@/components/payables/payables-ui"

type Setup = {
  fundingSources: Array<{ id: string; label: string; isDefault: boolean }>
  routing: PaymentApprovalRouting
  requiredApprovals: number
  requesterMayApprove: boolean
  settlementWindow: ProviderSettlementWindow
  feePolicy: ApFeePolicy
  eligibleBills: PayableBatchEligibleBill[]
}

function readableDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(`${iso}T00:00:00Z`))
}

/**
 * Turning a desk selection into one payment run, without leaving the desk.
 *
 * The run is the envelope an approver signs for, so the whole batch is prepared,
 * frozen and submitted in one act here. Fees are shown per payment rather than
 * as a single run charge, because each payable is its own ACH transfer to its
 * own vendor and the provider prices it that way — the single debit that
 * collects them is a collection detail, not a pricing one.
 */
export function PayBatchDialog({
  open,
  onOpenChange,
  bills,
  onSubmitted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  bills: VendorBillSummary[]
  onSubmitted: () => void
}) {
  const [setup, setSetup] = React.useState<Setup | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [fundingSourceId, setFundingSourceId] = React.useState("")
  const [pending, setPending] = React.useState(false)

  const scheduledPreferences = React.useMemo(
    () => bills.map((bill) => bill.payment_schedule === "scheduled" ? bill.scheduled_payment_date ?? null : null),
    [bills],
  )
  const scheduledDates = React.useMemo(
    () => [...new Set(scheduledPreferences.filter((date): date is string => Boolean(date)))],
    [scheduledPreferences],
  )
  const hasScheduleConflict = scheduledDates.length > 1
    || (scheduledDates.length === 1 && scheduledPreferences.some((date) => date === null))
  const scheduledFor = !hasScheduleConflict ? scheduledDates[0] ?? null : null

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    getPayableBatchSetupAction()
      .then((result) => {
        if (cancelled) return
        if (!result.success) {
          setLoadError(result.error)
          return
        }
        setSetup(result.data)
        const billFundingIds = [...new Set(bills.map((bill) => bill.preferred_funding_source_id).filter(Boolean))]
        const preferred = billFundingIds.length === 1
          ? result.data.fundingSources.find((source) => source.id === billFundingIds[0])
          : result.data.fundingSources.find((source) => source.isDefault) ?? result.data.fundingSources[0]
        setFundingSourceId((current) => current || preferred?.id || "")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bills, open])

  const settlement = React.useMemo(
    () =>
      setup
        ? estimateSettlement({ initiatedOn: scheduledFor ?? new Date().toISOString().slice(0, 10), window: setup.settlementWindow })
        : null,
    [scheduledFor, setup],
  )

  const lines = React.useMemo(() => {
    const discountByBillId = new Map((setup?.eligibleBills ?? []).map((entry) => [entry.id, entry.discount]))
    const today = new Date().toISOString().slice(0, 10)
    return bills.map((bill) => {
      const amountCents = payableOutstandingCents(bill)
      const fee = setup
        ? quoteApDisbursementFee({ vendorAmountCents: amountCents, policy: setup.feePolicy })
        : null
      const discount = discountByBillId.get(bill.id) ?? null
      // A discount counts only if the vendor still RECEIVES the money in time
      // — the rail's settlement window, not the release date, decides that.
      const earnableDiscount = discount && settlement && discountStillEarnable({
        discountByDate: discount.byDate,
        releaseDate: today,
        vendorReceivesLatest: settlement.vendorReceivesLatest,
      })
        ? discount
        : null
      return {
        bill,
        amountCents,
        processorFeeCents: fee?.processorFeeCents ?? 0,
        platformFeeCents: fee?.platformFeeCents ?? 0,
        discount: earnableDiscount,
      }
    })
  }, [bills, setup, settlement])

  const vendorTotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const processorFeeCents = lines.reduce((sum, line) => sum + line.processorFeeCents, 0)
  const platformFeeCents = lines.reduce((sum, line) => sum + line.platformFeeCents, 0)
  const discountAvailableCents = lines.reduce((sum, line) => sum + (line.discount?.amountCents ?? 0), 0)

  const preferredApproverIds = [...new Set(bills.flatMap((bill) => bill.preferred_approver_ids ?? []))]
  const approverNames = setup?.routing.approvers
    .filter((approver) => preferredApproverIds.length === 0 || preferredApproverIds.includes(approver.userId))
    .map((approver) => approver.name)
    .filter(Boolean) ?? []

  const submit = async () => {
    if (!fundingSourceId || lines.length === 0 || pending) return
    setPending(true)
    let runId: string | null = null
    try {
      const prepared = await preparePayableApprovalAction({
        bills: lines.map((line) => ({ bill_id: line.bill.id, amount_cents: line.amountCents })),
        funding_source_id: fundingSourceId,
        idempotency_key: crypto.randomUUID(),
      })
      if (!prepared.success) {
        toast.error(prepared.error)
        return
      }
      runId = prepared.data.runId

      const submitted = await submitPayableBatchAction({ run_id: prepared.data.runId, scheduled_for: scheduledFor })
      if (!submitted.success) {
        // A prepared-but-unsubmitted run would hold every one of these bills
        // hostage — they read as "in a run" and cannot be selected again.
        await discardPayableBatchAction(prepared.data.runId)
        toast.error(submitted.error)
        return
      }

      toast.success(
        setup?.requesterMayApprove
          ? `${lines.length} ${lines.length === 1 ? "payment is" : "payments are"} ready for your approval`
          : `${lines.length} ${lines.length === 1 ? "payment" : "payments"} submitted for approval`,
        { description: approverNames.length > 0 ? `Routed to ${approverNames.join(", ")}.` : undefined },
      )
      onOpenChange(false)
      onSubmitted()
    } catch (error) {
      if (runId) await discardPayableBatchAction(runId).catch(() => undefined)
      toast.error(error instanceof Error ? error.message : "Unable to submit these payments")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Pay {lines.length} {lines.length === 1 ? "payable" : "payables"} with Arc Pay
          </DialogTitle>
          <DialogDescription>
            One approval covers all of them. Nothing moves until it clears.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading payment settings…
          </div>
        ) : loadError ? (
          <div role="alert" className="border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {loadError}
          </div>
        ) : setup && setup.fundingSources.length === 0 ? (
          <div className="border border-warning bg-warning/10 px-4 py-3 text-sm">
            No verified funding account yet. Add one in Settings before paying with Arc Pay.
          </div>
        ) : (
          <div className="space-y-4">
            <ul className="max-h-52 divide-y overflow-y-auto border">
              {lines.map((line) => (
                <li key={line.bill.id} className="px-3 py-2 text-xs">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">
                      <span className="text-foreground">{line.bill.bill_number ?? "Payable"}</span>{" "}
                      <span className="text-muted-foreground">· {vendorLabel(line.bill)}</span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {formatMoneyFromCents(line.amountCents)}
                    </span>
                  </div>
                  {line.discount ? (
                    <div className="mt-0.5 flex items-baseline justify-between gap-3 text-success">
                      <span>Early-pay discount if received by {readableDate(line.discount.byDate)}</span>
                      <span className="shrink-0 font-mono tabular-nums">
                        &minus;{formatMoneyFromCents(line.discount.amountCents)}
                      </span>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>

            <div className="space-y-1.5">
              <Label htmlFor="batch-funding">Debited from</Label>
              <Select value={fundingSourceId} onValueChange={setFundingSourceId}>
                <SelectTrigger id="batch-funding" className="w-full">
                  <SelectValue placeholder="Choose a funding bank" />
                </SelectTrigger>
                <SelectContent>
                  {setup?.fundingSources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {hasScheduleConflict ? (
              <div className="border border-warning bg-warning/10 px-3 py-2.5 text-xs text-warning">
                These payables have different payment schedules. Submit them in separate batches so each approved release date is preserved.
              </div>
            ) : scheduledFor ? (
              <p className="text-xs text-muted-foreground">Scheduled payment date: {readableDate(scheduledFor)}.</p>
            ) : null}

            <div className="border">
              <div className="flex items-baseline justify-between bg-muted/20 px-3 py-2.5">
                <span className="text-sm font-medium">Debited</span>
                <span className="font-mono text-base font-semibold tabular-nums">
                  {formatMoneyFromCents(vendorTotalCents)}
                </span>
              </div>
              <div className="border-t px-3 py-2.5">
                <p className="microlabel">
                  Priced per payment · {lines.length} {lines.length === 1 ? "transfer" : "transfers"} · one Arc fee debit
                </p>
                <div className="mt-2 flex items-baseline justify-between text-sm text-muted-foreground">
                  <span>Provider processing cost</span>
                  <span className="font-mono tabular-nums">{formatMoneyFromCents(processorFeeCents)}</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between text-sm text-muted-foreground">
                  <span>
                    Arc fee
                    {platformFeeCents === 0 ? (
                      <span className="ml-2 text-xs text-muted-foreground/80">No Arc markup</span>
                    ) : null}
                  </span>
                  <span className="font-mono tabular-nums">{formatMoneyFromCents(platformFeeCents)}</span>
                </div>
              </div>
            </div>

            {discountAvailableCents > 0 ? (
              <p className="text-xs text-success">
                Capture{" "}
                <span className="font-mono tabular-nums">{formatMoneyFromCents(discountAvailableCents)}</span>{" "}
                in early-pay discounts by paying today.
              </p>
            ) : null}

            {settlement ? (
              <p className="text-xs text-muted-foreground">
                Vendors should be credited{" "}
                <span className="text-foreground">
                  {readableDate(settlement.vendorReceivesEarliest)}&ndash;{readableDate(settlement.vendorReceivesLatest)}
                </span>{" "}
                once approved.
              </p>
            ) : null}

            {setup?.requesterMayApprove ? (
              <p className="text-xs text-muted-foreground">
                After submitting, review and approve this run yourself. Step-up verification is still required before money moves.
              </p>
            ) : approverNames.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Goes to {approverNames.join(", ")} for approval. You cannot approve a payment you prepared.
              </p>
            ) : (
              <p className="text-xs text-warning">
                No payment approvers are configured yet, so this cannot be approved until someone is named in Settings.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || loading || !fundingSourceId || lines.length === 0 || hasScheduleConflict}
            onClick={() => void submit()}
          >
            {pending
              ? "Submitting…"
              : `${setup?.requesterMayApprove ? "Submit for my approval" : "Submit for approval"} · ${formatMoneyFromCents(vendorTotalCents)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
