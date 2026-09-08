"use client";

import { useState, type ReactNode } from "react";
import { format } from "date-fns";
import { ArrowRight } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers";
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds";
import type { PayableRunMembership } from "@/lib/services/org-payables";
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations";
import type { VendorBillSummary } from "@/lib/services/vendor-bills";
import { cn } from "@/lib/utils";
import { PayableHoldsPanel } from "./payable-holds";
import { VendorPaymentInviteButton } from "./vendor-payment-invite";
import type { PayableStage } from "./payable-form";

interface PayableActionBandProps {
  bill: VendorBillSummary;
  stage: PayableStage;
  isPending: boolean;
  blocked: boolean;
  evaluation?: PaymentHoldEvaluation;
  onHoldOverridden: (evaluation: PaymentHoldEvaluation) => void;
  mayDecideApproval: boolean;
  approvalWaitingLabel?: string;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onReopen: () => void;
  canPayElectronically: boolean;
  railOpen: boolean;
  readiness?: CompanyPaymentReadinessStatus;
  onPayElectronically: () => void;
  recordPaymentOpen: boolean;
  onToggleRecordPayment: () => void;
  /** The external-payment form, owned by the workspace that holds its state. */
  recordPaymentForm: ReactNode;
  runMembership?: PayableRunMembership;
  /**
   * Undo a payment recorded by hand. Absent when the viewer cannot release
   * payments, or when the payment came off the rail — that money returns
   * through the provider, not by editing Arc's copy of the story.
   */
  onReverseManualPayment?: (paymentId: string, reason: string) => void;
  awaitingViewerApproval: boolean;
  onReviewRun: () => void;
  onVendorInvited: () => void;
}

/** A quiet single line: the band states a fact and offers nothing. */
function StatusLine({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl bg-muted/40 px-4 py-3 text-sm leading-6 text-muted-foreground">
      {children}
    </div>
  );
}

/** The band with something to do in it. */
function ActionZone({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4 rounded-xl bg-muted/35 p-4 [&_button]:rounded-lg">
      {children}
    </div>
  );
}

/**
 * The one open question, and nothing else.
 *
 * At any moment a payable is asking for exactly one decision — approve it, pay
 * it, release the run — or for none at all. This band renders that question and
 * disappears when there isn't one, rather than keeping a paragraph on screen to
 * explain that no action is available. Reference material lives in the tabs
 * below; only what the viewer can act on now belongs here.
 */
export function PayableActionBand({
  bill,
  stage,
  isPending,
  blocked,
  evaluation,
  onHoldOverridden,
  mayDecideApproval,
  approvalWaitingLabel,
  onApprove,
  onReject,
  onReopen,
  canPayElectronically,
  railOpen,
  readiness,
  onPayElectronically,
  recordPaymentOpen,
  onToggleRecordPayment,
  recordPaymentForm,
  runMembership,
  onReverseManualPayment,
  awaitingViewerApproval,
  onReviewRun,
  onVendorInvited,
}: PayableActionBandProps) {
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseReason, setReverseReason] = useState("");

  const holds = evaluation ? (
    <PayableHoldsPanel
      billId={bill.id}
      evaluation={evaluation}
      onOverridden={onHoldOverridden}
    />
  ) : null;

  if (stage === "review") {
    if (!mayDecideApproval) {
      return (
        <StatusLine>
          {approvalWaitingLabel ?? "Waiting for a designated approver."}
        </StatusLine>
      );
    }
    return (
      <ActionZone>
        {holds}
        {rejecting ? (
          <div className="space-y-2">
            <Label className="microlabel" htmlFor="rejection-reason">
              Why is this being rejected?
            </Label>
            <Textarea
              id="rejection-reason"
              rows={3}
              className="bg-background"
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
              placeholder="Wrong contract, quantities don't match the delivery ticket, missing backup…"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="destructive"
                className="h-9"
                disabled={isPending || rejectionReason.trim().length < 8}
                onClick={() => onReject(rejectionReason)}
              >
                {isPending ? "Rejecting…" : "Reject payable"}
              </Button>
              <Button
                variant="ghost"
                className="h-9"
                disabled={isPending}
                onClick={() => {
                  setRejecting(false);
                  setRejectionReason("");
                }}
              >
                Cancel
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                The vendor is sent this.
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {/*
              Approving the obligation is its own act, separate from releasing
              the money. Jumping straight into the payment pane made the preparer
              the approver of record without ever asking them to be.
            */}
            <Button
              className="group h-10 gap-6"
              disabled={isPending || blocked}
              onClick={onApprove}
            >
              <span>
                {blocked ? "Blocked by payment holds" : "Approve bill"}
              </span>
              {!blocked ? (
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              ) : null}
            </Button>
            <Button
              variant="ghost"
              className="h-10 shrink-0 text-muted-foreground"
              disabled={isPending}
              onClick={() => setRejecting(true)}
            >
              Reject
            </Button>
          </div>
        )}
      </ActionZone>
    );
  }

  if (stage === "rejected") {
    return (
      <ActionZone>
        <div className="flex items-start justify-between gap-4">
          <p className="min-w-0 text-[13px]">
            <span className="font-medium text-destructive">Rejected.</span>{" "}
            <span className="text-muted-foreground">
              {bill.rejection_reason ?? "No reason was recorded."}
            </span>
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={isPending}
            onClick={onReopen}
          >
            {isPending ? "Reopening…" : "Reopen for review"}
          </Button>
        </div>
      </ActionZone>
    );
  }

  if (stage === "in_run" && runMembership) {
    if (!awaitingViewerApproval) {
      return (
        <StatusLine>
          {runMembership.preparedByViewer
            ? "You submitted this payment — it is with your designated approvers now."
            : `In a payment run · ${runMembership.runStatus.replaceAll("_", " ")} · cannot be edited or paid another way.`}
        </StatusLine>
      );
    }
    return (
      <ActionZone>
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 text-[13px]">
            <span className="font-medium">Waiting for your approval.</span>{" "}
            <span className="text-muted-foreground">
              {formatMoneyFromCents(runMembership.totalDebitCents)} debit across
              the run.
            </span>
          </p>
          <Button size="sm" className="shrink-0" onClick={onReviewRun}>
            Review payment run
          </Button>
        </div>
      </ActionZone>
    );
  }

  if (stage === "payable") {
    const showInvite =
      railOpen &&
      !canPayElectronically &&
      bill.company_id &&
      (readiness === "not_started" || readiness === "invited" || !readiness);
    return (
      <ActionZone>
        {holds}
        <div className="flex flex-col gap-2 sm:flex-row">
          {canPayElectronically ? (
            <Button
              className="h-10 gap-6"
              disabled={isPending || blocked}
              onClick={onPayElectronically}
            >
              <span>
                {blocked ? "Blocked by payment holds" : "Prepare payment"}
              </span>
              {!blocked ? <ArrowRight className="h-4 w-4" /> : null}
            </Button>
          ) : null}
          <Button
            variant={canPayElectronically ? "ghost" : "default"}
            className={cn("h-10", canPayElectronically ? "shrink-0" : "flex-1")}
            disabled={isPending || blocked}
            onClick={onToggleRecordPayment}
          >
            {canPayElectronically
              ? "Record payment…"
              : blocked
                ? "Blocked by payment holds"
                : "Record payment"}
          </Button>
        </div>

        {railOpen && !canPayElectronically ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {readiness === "verifying"
              ? "This vendor is verifying their bank account — ACH unlocks when that completes."
              : readiness === "suspended"
                ? "This vendor's Arc Pay access is suspended, so it cannot go out by ACH."
                : readiness === "revoked"
                  ? "This vendor's Arc Pay access was revoked, so it cannot go out by ACH."
                  : "This vendor has no bank details on file, so it cannot go out by ACH."}
            {showInvite && bill.company_id ? (
              <VendorPaymentInviteButton
                companyId={bill.company_id}
                readiness={readiness}
                onInvited={onVendorInvited}
              />
            ) : null}
          </p>
        ) : null}

        <Dialog
          open={recordPaymentOpen}
          onOpenChange={(open) => {
            if (open !== recordPaymentOpen) onToggleRecordPayment();
          }}
        >
          <DialogContent className="max-h-[90dvh] overflow-y-auto rounded-2xl sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Record payment</DialogTitle>
              <DialogDescription>
                Record a payment made outside Arc. This does not send money.
              </DialogDescription>
            </DialogHeader>
            {recordPaymentForm}
          </DialogContent>
        </Dialog>
      </ActionZone>
    );
  }

  if (stage === "paid") {
    // `payments` arrives newest-first (hydrateVendorBills orders by
    // `received_at` descending), so the most recent payment is the head.
    const last = bill.payments[0];
    if (!last) return null;
    const paidOn = last.received_at ? new Date(last.received_at) : null;
    const reversible =
      Boolean(onReverseManualPayment) &&
      (last.provider ?? "manual") === "manual";
    const summary = (
      <>
        Paid {formatMoneyFromCents(last.amount_cents)}
        {last.method ? ` by ${last.method}` : ""}
        {paidOn && !Number.isNaN(paidOn.getTime())
          ? ` on ${format(paidOn, "MMM d, yyyy")}`
          : ""}
        {last.reference ? ` · ref ${last.reference}` : ""}
      </>
    );

    if (!reversible) return <StatusLine>{summary}</StatusLine>;

    return (
      <div className="rounded-xl bg-muted/40 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{summary}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={isPending}
            onClick={() => setReverseOpen((open) => !open)}
          >
            {reverseOpen ? "Cancel" : "Reverse payment"}
          </Button>
        </div>
        {reverseOpen ? (
          <div className="mt-3 space-y-2 border-t pt-3">
            <Label htmlFor="reverse-payment-reason" className="text-xs">
              Why is this payment being reversed?
            </Label>
            <Textarea
              id="reverse-payment-reason"
              value={reverseReason}
              onChange={(event) => setReverseReason(event.target.value)}
              placeholder="Recorded against the wrong payable; the check was never sent."
              rows={2}
            />
            <p className="text-xs text-muted-foreground">
              This reopens the payable for{" "}
              {formatMoneyFromCents(last.amount_cents)} and voids the payment in
              your accounting system. It does not move money.
            </p>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={isPending || reverseReason.trim().length < 8}
              onClick={() => {
                onReverseManualPayment?.(last.id, reverseReason.trim());
                setReverseOpen(false);
                setReverseReason("");
              }}
            >
              Reverse {formatMoneyFromCents(last.amount_cents)}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  // Drafts and vendor credits have no decision waiting on them here.
  return null;
}
