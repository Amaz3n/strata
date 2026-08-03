"use client"

import { useEffect, useState, useTransition } from "react"
import {
  ArrowLeft,
  CheckCircle2,
  Landmark,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"

import {
  decidePayableApprovalAction,
  getPayableApprovalDetailAction,
} from "@/app/(app)/payables/actions"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { PayableApprovalDetail } from "@/lib/services/payable-approvals"
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { cn } from "@/lib/utils"
import { vendorLabel } from "../payables-ui"

type ReviewStep = "review" | "confirm" | "reject" | "done"

/**
 * The approver's side of a payable payment. It deliberately shows the bill's own
 * facts next to the frozen money facts — approving is supposed to be an act of
 * reading, not a button you hit from a list — and puts an explicit confirmation
 * between the decision and the release.
 */
export function PayableReviewView({
  bill,
  open,
  holds,
  onClose,
  onDecided,
}: {
  bill: VendorBillSummary
  open: boolean
  holds?: PaymentHoldEvaluation
  onClose: () => void
  onDecided: () => void
}) {
  const [detail, setDetail] = useState<PayableApprovalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState<ReviewStep>("review")
  const [reason, setReason] = useState("")
  const [outcome, setOutcome] = useState<{
    title: string
    body: string
  } | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setStep("review")
    setReason("")
    setOutcome(null)
    getPayableApprovalDetailAction(bill.id)
      .then((result) => {
        if (cancelled) return
        if (!result.success) {
          toast.error(result.error)
          return
        }
        setDetail(result.data)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, bill.id])

  const decide = (decision: "approved" | "rejected") => {
    if (!detail?.contentHash) return
    startTransition(async () => {
      const result = await decidePayableApprovalAction({
        run_id: detail.runId,
        decision,
        content_hash: detail.contentHash!,
        ...(decision === "rejected" ? { reason: reason.trim() } : {}),
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      const data = result.data
      setOutcome(
        data.result === "released"
          ? {
              title: "Payment released",
              body: `${formatMoneyFromCents(detail.vendorAmountCents)} is on its way to ${vendorLabel(bill)}. The bill updates itself as the provider confirms each stage.`,
            }
          : data.result === "rejected"
            ? {
                title: "Payment rejected",
                body: `${vendorLabel(bill)} was not paid. The preparer has been notified with your reason.`,
              }
            : data.result === "recorded"
              ? {
                  title: "Approval recorded",
                  body: "Your approval is on the record. This payment still needs another approver before it goes out.",
                }
              : {
                  title: "Approved — release is still gated",
                  body: data.reason,
                },
      )
      setStep("done")
      onDecided()
    })
  }

  const blockingHolds =
    holds?.holds.filter((hold) => hold.level === "block" && !hold.overridden) ??
    []
  const overriddenHolds = holds?.holds.filter((hold) => hold.overridden) ?? []

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          title="Back to bill"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold leading-tight">
            Review payment
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {vendorLabel(bill)}
            {bill.bill_number ? ` · invoice ${bill.bill_number}` : ""}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-lg space-y-6 px-4 py-8 sm:px-6">
          {loading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Loading payment…
            </p>
          ) : !detail ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              This payable has no payment waiting for approval.
            </p>
          ) : step === "done" && outcome ? (
            <div className="space-y-6 pt-6 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
              <div className="space-y-1">
                <h3 className="text-lg font-semibold">{outcome.title}</h3>
                <p className="text-sm text-muted-foreground">{outcome.body}</p>
              </div>
              <Button className="h-10 w-full sm:w-64" onClick={onClose}>
                Done
              </Button>
            </div>
          ) : (
            <>
              {/* What is being released */}
              <div className="border">
                <div className="flex items-baseline justify-between border-b px-4 py-3">
                  <span className="text-sm">{vendorLabel(bill)} receives</span>
                  <span className="font-mono text-lg font-medium tabular-nums">
                    {formatMoneyFromCents(detail.vendorAmountCents)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between border-b px-4 py-3">
                  <span className="text-sm text-muted-foreground">
                    Processing cost
                  </span>
                  <span className="font-mono text-sm tabular-nums text-muted-foreground">
                    {formatMoneyFromCents(detail.feeCents)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between bg-muted/20 px-4 py-3">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Landmark className="h-4 w-4 text-muted-foreground" />
                    Debited from {detail.fundingLabel}
                  </span>
                  <span className="font-mono text-lg font-semibold tabular-nums">
                    {formatMoneyFromCents(detail.totalDebitCents)}
                  </span>
                </div>
              </div>

              {/* The bill it pays */}
              <dl className="divide-y border text-sm">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <dt className="text-muted-foreground">Bill total</dt>
                  <dd className="font-mono tabular-nums">
                    {formatMoneyFromCents(bill.total_cents ?? 0)}
                  </dd>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5">
                  <dt className="text-muted-foreground">Project</dt>
                  <dd className="truncate">{bill.project_name ?? "—"}</dd>
                </div>
                {bill.commitment_title ? (
                  <div className="flex items-center justify-between px-4 py-2.5">
                    <dt className="text-muted-foreground">Commitment</dt>
                    <dd className="truncate">{bill.commitment_title}</dd>
                  </div>
                ) : null}
                <div className="flex items-center justify-between px-4 py-2.5">
                  <dt className="text-muted-foreground">Prepared by</dt>
                  <dd>{detail.submittedByName}</dd>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5">
                  <dt className="text-muted-foreground">Approvals</dt>
                  <dd className="tabular-nums">
                    {detail.approvalCount} of {detail.requiredApprovals}
                  </dd>
                </div>
              </dl>

              {blockingHolds.length > 0 ? (
                <div className="space-y-1 border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {blockingHolds.map((hold) => (
                    <p key={hold.kind}>Hold: {hold.message}</p>
                  ))}
                </div>
              ) : null}
              {overriddenHolds.length > 0 ? (
                <div className="space-y-1 border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
                  {overriddenHolds.map((hold) => (
                    <p key={hold.kind}>
                      <span className="font-medium">Overridden hold:</span>{" "}
                      {hold.message}
                      {hold.overrideReason ? ` — ${hold.overrideReason}` : ""}
                    </p>
                  ))}
                </div>
              ) : null}

              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                The invoice and its documents are in the pane beside this one.
                These amounts were frozen when the payment was prepared; if
                anything about the bill changed since, approval is invalidated
                and it comes back here.
              </p>

              {!detail.viewerMayDecide ? (
                <div className="flex items-start gap-2 border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {detail.blockedReason
                    ? `${detail.blockedReason}.`
                    : `This payment is ${detail.status.replaceAll("_", " ")} and no longer needs a decision.`}
                </div>
              ) : step === "review" ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="h-11 flex-1"
                    onClick={() => setStep("reject")}
                  >
                    Reject
                  </Button>
                  <Button
                    className="h-11 flex-1"
                    onClick={() => setStep("confirm")}
                  >
                    Approve payment
                  </Button>
                </div>
              ) : step === "confirm" ? (
                <div className="space-y-3 border border-primary/30 bg-primary/5 p-4">
                  <p className="text-sm font-medium">
                    Release {formatMoneyFromCents(detail.vendorAmountCents)} to{" "}
                    {vendorLabel(bill)}?
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatMoneyFromCents(detail.totalDebitCents)} will be
                    debited from {detail.fundingLabel}
                    {detail.requiredApprovals > detail.approvalCount + 1
                      ? ". Another approver is still required after you."
                      : " as soon as you confirm. ACH payments cannot be recalled once sent."}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="h-10 flex-1"
                      disabled={isPending}
                      onClick={() => setStep("review")}
                    >
                      Back
                    </Button>
                    <Button
                      className="h-10 flex-1"
                      disabled={isPending}
                      onClick={() => decide("approved")}
                    >
                      {isPending ? "Releasing…" : "Confirm & release"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 border p-4">
                  <Label htmlFor="reject-reason" className="microlabel">
                    Why are you rejecting this?
                  </Label>
                  <Textarea
                    id="reject-reason"
                    rows={3}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="The preparer sees this."
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="h-10 flex-1"
                      disabled={isPending}
                      onClick={() => setStep("review")}
                    >
                      Back
                    </Button>
                    <Button
                      className={cn("h-10 flex-1")}
                      variant="destructive"
                      disabled={isPending || reason.trim().length < 8}
                      onClick={() => decide("rejected")}
                    >
                      {isPending ? "Rejecting…" : "Reject payment"}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
