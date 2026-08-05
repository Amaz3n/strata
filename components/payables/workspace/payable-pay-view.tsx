"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  Banknote,
  CheckCircle2,
  Landmark,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"

import { preparePayableApprovalAction } from "@/app/(app)/payables/actions"
import {
  cancelPaymentRunAction,
  getPaymentRunSetupAction,
  submitPaymentRunAction,
} from "@/app/(app)/payables/payment-runs/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import {
  estimateSettlement,
  type ProviderSettlementWindow,
} from "@/lib/payments/settlement-estimate"
import type { PaymentApprovalRouting } from "@/lib/services/payment-approvers"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { cn } from "@/lib/utils"
import { vendorLabel } from "../payables-ui"
import { parseDollarsToCents } from "./payable-form"

type FundingSource = { id: string; label: string; isDefault: boolean }

function nameList(names: string[]) {
  if (names.length <= 2) return names.join(" or ")
  return `${names.slice(0, 2).join(", ")} or ${names.length - 2} other${names.length - 2 === 1 ? "" : "s"}`
}

/**
 * Say who this actually goes to. An org that designated approvers gets their
 * names; one that never did gets the honest generic answer.
 */
function approvalSentence(
  requiredApprovals: number,
  eligible: Array<{ name: string }>,
  routing: PaymentApprovalRouting | null,
) {
  const count =
    requiredApprovals === 1 ? "One approver" : `${requiredApprovals} approvers`
  if (!routing?.rosterConfigured || eligible.length === 0) {
    return `${count} — never you — must approve before money moves.`
  }
  return `${count} must approve before money moves. This goes to ${nameList(eligible.map((approver) => approver.name))}.`
}

type PayStep = "setup" | "review" | "submitted"

interface DraftRun {
  id: string
  totalDebitCents: number
  requiredApprovals: number
  vendorAmountCents: number
  processorFeeCents: number
  platformFeeCents: number
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

/** Bare `YYYY-MM-DD` in, readable date out — never routed through a local timezone. */
function readableDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(`${iso}T00:00:00Z`),
  )
}

/**
 * The in-pane payment flow: amount and funding source, then a review of the
 * frozen draft run (real fees, real approval count), then submission into the
 * maker/checker pipeline. The draft is cancelled whenever the user backs out,
 * so an abandoned flow never keeps a bill claimed by a phantom run.
 */
export function PayablePayView({
  bill,
  open,
  balanceCents,
  onClose,
  onSubmitted,
}: {
  bill: VendorBillSummary
  open: boolean
  balanceCents: number
  onClose: () => void
  onSubmitted: () => void
}) {
  const [isPending, startTransition] = useTransition()

  const [step, setStep] = useState<PayStep>("setup")
  const [fundingSources, setFundingSources] = useState<FundingSource[] | null>(
    null,
  )
  const [setupError, setSetupError] = useState<string | null>(null)
  const [billEligible, setBillEligible] = useState(true)
  const [routing, setRouting] = useState<PaymentApprovalRouting | null>(null)
  const [fundingSourceId, setFundingSourceId] = useState("")
  const [amount, setAmount] = useState("")
  const [draft, setDraft] = useState<DraftRun | null>(null)
  const [scheduleMode, setScheduleMode] = useState<"asap" | "date">("asap")
  const [scheduleDate, setScheduleDate] = useState("")
  const [settlementWindow, setSettlementWindow] = useState<ProviderSettlementWindow | null>(null)

  // Fresh flow every time the pane opens or the bill changes.
  useEffect(() => {
    if (!open) return
    setStep("setup")
    setDraft(null)
    setAmount((balanceCents / 100).toFixed(2))
    setScheduleMode("asap")
    setScheduleDate("")
  }, [open, bill.id, balanceCents])

  // Closing the pane by any route (back, Escape, switching bills) discards an
  // un-submitted draft so the bill is never left claimed by a phantom run.
  useEffect(() => {
    if (open || !draft || step === "submitted") return
    const draftId = draft.id
    setDraft(null)
    setStep("setup")
    cancelPaymentRunAction(draftId).then((result) => {
      if (!result.success) toast.error(result.error)
    })
  }, [open, draft, step])

  // Funding sources load when the flow is actually opened, never before.
  useEffect(() => {
    if (!open || fundingSources !== null) return
    let cancelled = false
    getPaymentRunSetupAction().then((result) => {
      if (cancelled) return
      if (!result.success) {
        setSetupError(result.error)
        return
      }
      setSetupError(null)
      setFundingSources(result.data.fundingSources)
      setRouting(result.data.routing)
      setSettlementWindow(result.data.settlementWindow)
      // Eligibility is advisory here — the destination account is resolved
      // server-side when the run is prepared, never named by the client.
      setBillEligible(
        result.data.eligibleBills.some((candidate) => candidate.id === bill.id),
      )
      setFundingSourceId(
        (current) =>
          current ||
          (
            result.data.fundingSources.find((source) => source.isDefault) ??
            result.data.fundingSources[0]
          )?.id ||
          "",
      )
    })
    return () => {
      cancelled = true
    }
  }, [open, fundingSources, bill.id])

  const amountCents = parseDollarsToCents(amount)
  const amountValid =
    amountCents != null && amountCents > 0 && amountCents <= balanceCents

  const reviewPayment = () => {
    if (!amountValid || !fundingSourceId || amountCents == null) return
    startTransition(async () => {
      const result = await preparePayableApprovalAction({
        bill_id: bill.id,
        amount_cents: amountCents,
        funding_source_id: fundingSourceId,
        idempotency_key: crypto.randomUUID(),
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      setDraft({
        id: result.data.runId,
        totalDebitCents: result.data.totalDebitCents,
        requiredApprovals: result.data.requiredApprovals,
        vendorAmountCents: result.data.vendorAmountCents,
        processorFeeCents: result.data.processorFeeCents,
        platformFeeCents: result.data.platformFeeCents,
      })
      setStep("review")
    })
  }

  const discardDraft = () => {
    const current = draft
    setDraft(null)
    setStep("setup")
    if (!current) return
    startTransition(async () => {
      const result = await cancelPaymentRunAction(current.id)
      if (!result.success) toast.error(result.error)
    })
  }

  const submitRun = () => {
    if (!draft) return
    startTransition(async () => {
      const result = await submitPaymentRunAction({
        run_id: draft.id,
        scheduled_for: scheduledFor,
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      setStep("submitted")
      onSubmitted()
    })
  }

  // The open=false effect above discards any un-submitted draft.
  const closeFlow = () => onClose()

  const fundingLabel =
    fundingSources?.find((source) => source.id === fundingSourceId)?.label ??
    "Bank account"
  const scheduledFor = scheduleMode === "date" && scheduleDate ? scheduleDate : null
  const scheduleInvalid = scheduleMode === "date" && (!scheduleDate || scheduleDate < todayIso())
  const settlement = settlementWindow
    ? estimateSettlement({ initiatedOn: scheduledFor ?? todayIso(), window: settlementWindow })
    : null
  const paysLate = Boolean(
    settlement && bill.due_date && bill.due_date < settlement.vendorReceivesLatest,
  )

  // Designated approvers who could actually decide *this* run: still permitted,
  // not the preparer (a preparer never approves their own run), and with a
  // personal ceiling that covers the debit.
  const eligibleApprovers = (routing?.approvers ?? []).filter(
    (approver) =>
      approver.permitted &&
      approver.userId !== routing?.viewerUserId &&
      (approver.approvalLimitCents == null ||
        !draft ||
        draft.totalDebitCents <= approver.approvalLimitCents),
  )
  const shortHandedApprovers = Boolean(
    draft &&
    routing?.rosterConfigured &&
    eligibleApprovers.length < draft.requiredApprovals,
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={closeFlow}
          title="Back to bill"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold leading-tight">
            Pay {vendorLabel(bill)}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {bill.bill_number ? `Bill ${bill.bill_number} · ` : ""}
            {formatMoneyFromCents(balanceCents)} outstanding
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-lg space-y-6 px-4 py-8 sm:px-6">
          {setupError ? (
            <div className="border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {setupError}
            </div>
          ) : null}

          {step === "setup" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="pay-amount" className="microlabel">
                  Amount
                </Label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-lg text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="pay-amount"
                    value={amount}
                    inputMode="decimal"
                    onChange={(event) => setAmount(event.target.value)}
                    className="h-14 pl-9 font-mono text-2xl font-medium tabular-nums"
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {amountCents != null && amountCents > balanceCents
                      ? "More than the outstanding balance"
                      : amountCents != null &&
                          amountCents < balanceCents &&
                          amountCents > 0
                        ? "Partial payment — the rest stays outstanding"
                        : "Full outstanding balance"}
                  </span>
                  {amountCents !== balanceCents ? (
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => setAmount((balanceCents / 100).toFixed(2))}
                    >
                      Pay full balance
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pay-funding" className="microlabel">
                  Pay from
                </Label>
                {fundingSources !== null && fundingSources.length === 0 ? (
                  <div className="border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
                    No verified bank account yet.{" "}
                    <Link
                      href="/settings"
                      className="font-medium text-primary hover:underline"
                    >
                      Set one up in Settings → Vendor payments
                    </Link>
                    .
                  </div>
                ) : (
                  <Select
                    value={fundingSourceId}
                    onValueChange={setFundingSourceId}
                  >
                    <SelectTrigger id="pay-funding" className="h-11 w-full">
                      <span className="flex items-center gap-2">
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                        <SelectValue
                          placeholder={
                            fundingSources === null
                              ? "Loading accounts…"
                              : "Select bank account"
                          }
                        />
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {(fundingSources ?? []).map((source) => (
                        <SelectItem key={source.id} value={source.id}>
                          {source.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="space-y-1.5">
                <p className="microlabel">Pay to</p>
                <div className="flex items-center justify-between gap-3 border bg-muted/20 px-3 py-2.5 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <Banknote className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">
                      {vendorLabel(bill)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    ACH · verified account
                  </span>
                </div>
              </div>

              {!billEligible && fundingSources !== null ? (
                <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
                  This bill is not payment-ready right now — it may be on hold,
                  already in a run, or the vendor's account may need attention.
                  You can still try; every check runs again on review.
                </div>
              ) : null}

              <Button
                className="h-11 w-full"
                disabled={isPending || !amountValid || !fundingSourceId}
                onClick={reviewPayment}
              >
                {isPending ? "Preparing…" : "Review payment"}
              </Button>

              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Continuing approves this bill&apos;s coding, runs every release
                check, and freezes these exact amounts. Nothing moves until
                {eligibleApprovers.length > 0
                  ? ` ${nameList(eligibleApprovers.map((approver) => approver.name))} approves`
                  : " an approver signs off"}
                .
              </p>
            </>
          ) : null}

          {step === "review" && draft ? (
            <>
              <div className="border">
                <div className="flex items-baseline justify-between border-b px-4 py-3">
                  <span className="text-sm">{vendorLabel(bill)} receives</span>
                  <span className="font-mono text-lg font-medium tabular-nums">
                    {formatMoneyFromCents(draft.vendorAmountCents)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between bg-muted/20 px-4 py-3">
                  <span className="text-sm font-medium">
                    Debited from {fundingLabel}
                  </span>
                  <span className="font-mono text-lg font-semibold tabular-nums">
                    {formatMoneyFromCents(draft.totalDebitCents)}
                  </span>
                </div>
                {/*
                  Below the debit, never added to it. Provider cost and Arc's own
                  fee are still never lumped — the preparer is about to ask
                  someone else to sign for this, and both of them need to see
                  which part is Arc's — but they ride their own debit, so putting
                  them inside the debit total would describe a movement of money
                  that does not happen.
                */}
                <div className="border-t px-4 py-3">
                  <p className="microlabel">Collected separately · one Arc fee debit per run</p>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="text-sm text-muted-foreground">
                      Provider processing cost
                      <span className="ml-2 text-xs text-muted-foreground/80">At cost</span>
                    </span>
                    <span className="font-mono text-sm tabular-nums text-muted-foreground">
                      {formatMoneyFromCents(draft.processorFeeCents)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between">
                    <span className="text-sm text-muted-foreground">
                      Arc fee
                      {draft.platformFeeCents === 0 ? (
                        <span className="ml-2 text-xs text-muted-foreground/80">
                          No Arc markup
                        </span>
                      ) : null}
                    </span>
                    <span className="font-mono text-sm tabular-nums text-muted-foreground">
                      {formatMoneyFromCents(draft.platformFeeCents)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <p className="microlabel">When should this be paid?</p>
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
                      onClick={() => setScheduleMode(option.key)}
                      aria-pressed={scheduleMode === option.key}
                      className={cn(
                        "h-8 border border-border px-3 text-xs transition-colors",
                        index > 0 && "-ml-px",
                        scheduleMode === option.key
                          ? "relative z-10 bg-accent font-medium text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {scheduleMode === "date" ? (
                  <Input
                    type="date"
                    aria-label="Release date"
                    min={todayIso()}
                    value={scheduleDate}
                    onChange={(event) => setScheduleDate(event.target.value)}
                    className="h-8 w-48 text-xs"
                  />
                ) : null}
                {settlement && (scheduleMode === "asap" || scheduleDate) ? (
                  <p className="text-xs text-muted-foreground">
                    Released{" "}
                    {readableDate(scheduledFor ?? todayIso())} ·{" "}
                    {vendorLabel(bill)}&rsquo;s bank should credit them{" "}
                    <span className="text-foreground">
                      {readableDate(settlement.vendorReceivesEarliest)}&ndash;
                      {readableDate(settlement.vendorReceivesLatest)}
                    </span>
                    . Estimated from the rail&rsquo;s normal{" "}
                    {settlement.maxBusinessDays} business-day window; bank
                    holidays and returns can push it later.
                  </p>
                ) : null}
                {paysLate ? (
                  <p className="border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
                    <span className="font-medium">
                      This lands after the bill&rsquo;s due date
                    </span>{" "}
                    at the slow end of the estimate.
                  </p>
                ) : null}
              </div>

              <div className="space-y-2 text-xs text-muted-foreground">
                <p className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Release checks passed and these amounts are frozen. Any change
                  to the payment invalidates them and starts over.
                </p>
                <p className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {approvalSentence(
                    draft.requiredApprovals,
                    eligibleApprovers,
                    routing,
                  )}
                </p>
                {shortHandedApprovers ? (
                  <p className="flex items-start gap-2 text-warning">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Not enough designated approvers can decide this run. Ask an
                    administrator to designate another approver in Settings →
                    Vendor payments.
                  </p>
                ) : null}
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-11 flex-1"
                  disabled={isPending}
                  onClick={discardDraft}
                >
                  Back
                </Button>
                <Button
                  className="h-11 flex-1"
                  disabled={isPending || scheduleInvalid}
                  onClick={submitRun}
                >
                  {isPending ? "Submitting…" : "Send for approval"}
                </Button>
              </div>
            </>
          ) : null}

          {step === "submitted" && draft ? (
            <div className="space-y-6 pt-6 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
              <div className="space-y-1">
                <h3 className="text-lg font-semibold">Sent for approval</h3>
                <p className="text-sm text-muted-foreground">
                  {formatMoneyFromCents(draft.vendorAmountCents)} to{" "}
                  {vendorLabel(bill)} is awaiting{" "}
                  {draft.requiredApprovals === 1
                    ? "approval"
                    : `${draft.requiredApprovals} approvals`}
                  {eligibleApprovers.length > 0
                    ? ` from ${nameList(eligibleApprovers.map((approver) => approver.name))}`
                    : ""}
                  . Once approved and released, the vendor is paid by ACH and
                  this bill updates on its own.
                </p>
              </div>
              <div className="flex flex-col items-center gap-2">
                <Button className="h-10 w-full sm:w-64" onClick={onClose}>
                  Done
                </Button>
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground"
                >
                  <Link href="/payables/payment-runs">
                    Track in payment runs
                  </Link>
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
