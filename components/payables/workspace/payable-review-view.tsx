"use client";

import { useEffect, useState, useTransition } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Landmark,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import {
  decidePayableApprovalAction,
  getPayableApprovalDetailAction,
} from "@/app/(app)/payables/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers";
import { estimateSettlement } from "@/lib/payments/settlement-estimate";
import { usePaymentStepUp } from "@/components/payments/payment-step-up";
import type {
  PayableApprovalDetail,
  PayableApprovalOutcome,
} from "@/lib/services/payable-approvals";
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds";
import type { VendorBillSummary } from "@/lib/services/vendor-bills";
import { cn } from "@/lib/utils";
import { vendorLabel } from "../payables-ui";

type ReviewStep = "review" | "confirm" | "reject" | "done";
/** A release that did not happen is not a success, and must not look like one. */
type ReviewOutcomeTone = "success" | "warning";

/** Bare `YYYY-MM-DD` in, readable date out — never routed through a local timezone. */
function readableDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${iso}T00:00:00Z`));
}

/**
 * What the approver is told once their decision lands.
 *
 * Approval and release are two different things, and the screen used to have
 * one line for every way they came apart — a run scheduled for next Tuesday, a
 * release queued because approving and releasing are separate roles, and a real
 * gate — all read "release is still gated" over a raw error message. Only the
 * last of those is a problem, and only it says so.
 */
function outcomeCopy(
  outcome: PayableApprovalOutcome,
  detail: PayableApprovalDetail,
  vendorName: string,
): { title: string; body: string; tone: ReviewOutcomeTone } {
  switch (outcome.result) {
    case "released":
      return {
        tone: "success",
        title: "Payment released",
        body:
          detail.items.length > 1
            ? `${formatMoneyFromCents(detail.totalDebitCents)} is on its way to ${detail.items.length} vendors. Each bill updates itself as the provider confirms each stage.`
            : `${formatMoneyFromCents(detail.vendorAmountCents)} is on its way to ${vendorName}. The bill updates itself as the provider confirms each stage.`,
      };
    case "rejected":
      return {
        tone: "success",
        title: "Payment rejected",
        body: `${vendorName} was not paid. The preparer has been notified with your reason.`,
      };
    case "recorded":
      return {
        tone: "success",
        title: "Approval recorded",
        body: "Your approval is on the record. This payment still needs another approver before it goes out.",
      };
    case "scheduled":
      return {
        tone: "success",
        title: "Approved — releases on schedule",
        body: `Fully approved. ${formatMoneyFromCents(detail.totalDebitCents)} goes out on ${readableDate(outcome.scheduledFor)}, the date the preparer chose. Nothing else is needed from you.`,
      };
    case "release_queued":
      return {
        tone: "success",
        title: "Approved — release is on its way",
        body: outcome.reason,
      };
    case "approved_release_pending":
      return {
        tone: "warning",
        title: "Approved — release is still gated",
        body: `${outcome.reason} The approval stands and Arc keeps retrying the release.`,
      };
  }
}

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
  bill: VendorBillSummary;
  open: boolean;
  holds?: PaymentHoldEvaluation;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [detail, setDetail] = useState<PayableApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<ReviewStep>("review");
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<{
    title: string;
    body: string;
    tone: ReviewOutcomeTone;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  const { requireStepUp, stepUpPrompt } = usePaymentStepUp();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setStep("review");
    setReason("");
    setOutcome(null);
    getPayableApprovalDetailAction(bill.id)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        setDetail(result.data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, bill.id]);

  const decide = (decision: "approved" | "rejected") => {
    if (!detail?.contentHash) return;
    startTransition(async () => {
      const result = await decidePayableApprovalAction({
        run_id: detail.runId,
        decision,
        content_hash: detail.contentHash!,
        ...(decision === "rejected" ? { reason: reason.trim() } : {}),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const data = result.data;
      setOutcome(outcomeCopy(data, detail, vendorLabel(bill)));
      setStep("done");
      onDecided();
    });
  };

  // A run with several payables makes the item-level figures misleading on their
  // own: the approver is signing for the whole envelope, so the summary reports
  // the run and the per-payable lines carry the detail.
  const isBatch = (detail?.items.length ?? 0) > 1;
  const runProcessorFeeCents =
    detail?.items.reduce((sum, item) => sum + item.processorFeeCents, 0) ?? 0;
  const runPlatformFeeCents =
    detail?.items.reduce((sum, item) => sum + item.platformFeeCents, 0) ?? 0;
  const releasedAmountCents = isBatch
    ? (detail?.totalDebitCents ?? 0)
    : (detail?.vendorAmountCents ?? 0);

  const blockingHolds =
    holds?.holds.filter((hold) => hold.level === "block" && !hold.overridden) ??
    [];
  const overriddenHolds = holds?.holds.filter((hold) => hold.overridden) ?? [];
  // An unscheduled run releases the moment approval completes, so today is the
  // right anchor for the estimate the approver is looking at.
  const settlement = detail
    ? estimateSettlement({
        initiatedOn:
          detail.scheduledFor ?? new Date().toISOString().slice(0, 10),
        window: detail.settlementWindow,
      })
    : null;

  return (
    <div className="flex h-full flex-col">
      {stepUpPrompt}
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
              {outcome.tone === "warning" ? (
                <TriangleAlert className="mx-auto h-10 w-10 text-warning" />
              ) : (
                <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
              )}
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
                  <span className="text-sm">
                    {isBatch
                      ? `${detail.items.length} vendors receive`
                      : `${vendorLabel(bill)} receives`}
                  </span>
                  <span className="font-mono text-lg font-medium tabular-nums">
                    {formatMoneyFromCents(releasedAmountCents)}
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
                {/*
                  Both fee lines always render, including at zero — a fee that
                  only appears when it is non-zero teaches people not to look for
                  it. They sit below the debit rather than inside it: the approver
                  is signing for money leaving the bank, and these do not.
                */}
                <div className="border-t px-4 py-3">
                  <p className="microlabel">
                    {isBatch
                      ? `Priced per payment · ${detail.items.length} payments · one Arc fee debit per run`
                      : "Collected separately · one Arc fee debit per run"}
                  </p>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="text-sm text-muted-foreground">
                      Provider processing cost
                    </span>
                    <span className="font-mono text-sm tabular-nums text-muted-foreground">
                      {formatMoneyFromCents(
                        isBatch
                          ? runProcessorFeeCents
                          : detail.processorFeeCents,
                      )}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between">
                    <span className="text-sm text-muted-foreground">
                      Arc fee
                      {(isBatch
                        ? runPlatformFeeCents
                        : detail.platformFeeCents) === 0 ? (
                        <span className="ml-2 text-xs text-muted-foreground/80">
                          No Arc markup
                        </span>
                      ) : null}
                    </span>
                    <span className="font-mono text-sm tabular-nums text-muted-foreground">
                      {formatMoneyFromCents(
                        isBatch ? runPlatformFeeCents : detail.platformFeeCents,
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {/*
                When the money actually lands. The approver is releasing on a date
                the preparer chose, so both the release and the vendor-receipt
                estimate belong in front of them before they decide.
              */}
              <div className="border bg-muted/10 px-4 py-3 text-xs">
                <p>
                  {detail.scheduledFor ? (
                    <>
                      Scheduled for release on{" "}
                      <span className="font-medium">
                        {readableDate(detail.scheduledFor)}
                      </span>
                      .
                    </>
                  ) : (
                    <>Releases as soon as approval completes.</>
                  )}
                </p>
                {settlement ? (
                  <p className="mt-1 text-muted-foreground">
                    {vendorLabel(bill)}&rsquo;s bank should credit them{" "}
                    <span className="text-foreground">
                      {readableDate(settlement.vendorReceivesEarliest)}&ndash;
                      {readableDate(settlement.vendorReceivesLatest)}
                    </span>
                    . Estimated from the rail&rsquo;s normal{" "}
                    {settlement.maxBusinessDays} business-day window.
                  </p>
                ) : null}
              </div>

              {/*
                Every payable in the run. The signature binds to the frozen set,
                so an approver who can only see the payable they happened to open
                is signing for money they were never shown.
              */}
              {detail.items.length > 1 ? (
                <div className="border">
                  <div className="flex items-baseline justify-between gap-2 border-b bg-muted/20 px-4 py-2">
                    <span className="text-xs font-medium">
                      {detail.items.length} payments in this run
                    </span>
                    <span className="text-xs text-muted-foreground">
                      One ACH transfer each
                    </span>
                  </div>
                  <ul className="max-h-56 divide-y overflow-y-auto">
                    {detail.items.map((item) => (
                      <li
                        key={item.billId}
                        className="flex items-baseline justify-between gap-3 px-4 py-2 text-xs"
                      >
                        <span className="min-w-0 truncate">
                          <span className="text-foreground">
                            {item.billNumber ?? "Payable"}
                          </span>{" "}
                          <span className="text-muted-foreground">
                            · {item.vendorName}
                            {item.projectName ? ` · ${item.projectName}` : ""}
                          </span>
                          {item.releasableAtSubmission ? null : (
                            <span className="text-warning">
                              {" "}
                              · review release evidence
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums">
                          {formatMoneyFromCents(item.vendorAmountCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

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
                Open Invoice to check the bill and its supporting documents.
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
                    {isBatch
                      ? `Approve ${detail.items.length} payments totaling ${formatMoneyFromCents(detail.totalDebitCents)}?`
                      : `Approve payment of ${formatMoneyFromCents(detail.vendorAmountCents)} to ${vendorLabel(bill)}?`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatMoneyFromCents(detail.totalDebitCents)} will be
                    debited from {detail.fundingLabel}
                    {detail.requiredApprovals > detail.approvalCount + 1
                      ? ". Another approver is still required after you."
                      : detail.scheduledFor
                        ? ` on ${readableDate(detail.scheduledFor)}, the release date this run was approved for. ACH payments cannot be recalled once sent.`
                        : " as soon as you confirm. ACH payments cannot be recalled once sent."}
                  </p>
                  {/*
                    The server requires a genuine second factor verified in the
                    last ten minutes. It is asked for on the press, not before —
                    a code box in front of an unread decision helps nobody.
                  */}
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
                      onClick={() =>
                        void requireStepUp(() => decide("approved"))
                      }
                    >
                      {isPending
                        ? "Approving…"
                        : detail.requiredApprovals > detail.approvalCount + 1
                          ? "Confirm approval"
                          : detail.scheduledFor
                            ? "Approve scheduled payment"
                            : "Confirm & release"}
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
                      onClick={() =>
                        void requireStepUp(() => decide("rejected"))
                      }
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
  );
}
