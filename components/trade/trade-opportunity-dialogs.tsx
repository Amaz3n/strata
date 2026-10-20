"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  closeTradeOpportunityAction,
  logOpportunityContactAction,
  recordQuoteAcceptanceAction,
  setOpportunityFollowUpAction,
  startTradeJobFromQuoteAction,
  updateOpportunityCustomerAction,
} from "@/app/(app)/pipeline/[dealId]/trade-actions";
import type { ActionResult } from "@/lib/action-result";
import { ACTIVITY_KINDS, ACTIVITY_LABELS, type ActivityKind } from "@/lib/sales/activity";
import {
  DECLINE_REASON_CODES,
  DECLINE_REASON_LABELS,
  LOST_REASON_LABELS,
  QUOTE_LOST_REASON_CODES,
} from "@/lib/sales/lost-reasons";
import type { TradeOpportunityDetail } from "@/lib/services/trade-quotes";
import { isTradeBillingBasis } from "@/lib/trade/workspace";
import { formatMoneyCents } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

const SELECT_CLASS = "h-9 w-full border border-input bg-background px-3 text-sm";

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** Runs one mutation: disables the submit while pending, keeps the error inline, closes and refreshes on success. */
function useMutation(onOpenChange: (open: boolean) => void) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(send: () => Promise<ActionResult<unknown>>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await send();
      if (!result.success) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      after?.();
      router.refresh();
    });
  }
  return { pending, error, setError, run };
}

function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  error,
  pending,
  submitLabel,
  pendingLabel,
  onSubmit,
  children,
  extraAction,
}: DialogProps & {
  title: string;
  description: string;
  error: string | null;
  pending: boolean;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: () => void;
  children: ReactNode;
  extraAction?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {children}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {extraAction}
            <Button type="submit" disabled={pending}>
              {pending ? pendingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function dateInputValue(iso: string | null) {
  if (!iso) return "";
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A date picked on a calendar means the end of that working day, in the person's own zone. */
export function localDateToIso(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 17).toISOString();
}

export function FollowUpDialog({
  open,
  onOpenChange,
  prospectId,
  followUpAt,
}: DialogProps & { prospectId: string; followUpAt: string | null }) {
  const { pending, error, setError, run } = useMutation(onOpenChange);
  const [date, setDate] = useState(dateInputValue(followUpAt));
  const [note, setNote] = useState("");
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Follow up"
      description="Pick the day to check in with the customer."
      error={error}
      pending={pending}
      submitLabel="Set follow-up"
      pendingLabel="Saving…"
      onSubmit={() => {
        if (!date) {
          setError("Pick a date, or clear the follow-up.");
          return;
        }
        run(() =>
          setOpportunityFollowUpAction({ prospect_id: prospectId, at: localDateToIso(date), note }),
        );
      }}
      extraAction={
        followUpAt ? (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              run(() => setOpportunityFollowUpAction({ prospect_id: prospectId, at: null, note: "" }))
            }
          >
            Clear
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-2">
        <Label htmlFor="followup-date">Date</Label>
        <Input id="followup-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="followup-note">Note</Label>
        <Textarea
          id="followup-note"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Ask about the panel upgrade"
        />
      </div>
    </DialogShell>
  );
}

export function LogContactDialog({
  open,
  onOpenChange,
  prospectId,
}: DialogProps & { prospectId: string }) {
  const { pending, error, run } = useMutation(onOpenChange);
  const [kind, setKind] = useState<ActivityKind>("call");
  const [note, setNote] = useState("");
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Log contact"
      description="Record that you spoke with the customer."
      error={error}
      pending={pending}
      submitLabel="Log contact"
      pendingLabel="Saving…"
      onSubmit={() =>
        run(
          () => logOpportunityContactAction(prospectId, { kind, note }),
          () => setNote(""),
        )
      }
    >
      <div className="space-y-2">
        <Label htmlFor="contact-kind">How</Label>
        <select
          id="contact-kind"
          className={SELECT_CLASS}
          value={kind}
          onChange={(e) => {
            const next = ACTIVITY_KINDS.find((item) => item === e.target.value);
            if (next) setKind(next);
          }}
        >
          {ACTIVITY_KINDS.map((item) => (
            <option key={item} value={item}>
              {ACTIVITY_LABELS[item]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="contact-note">Note</Label>
        <Textarea id="contact-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </div>
    </DialogShell>
  );
}

export function CustomerDialog({
  open,
  onOpenChange,
  prospectId,
  customer,
}: DialogProps & { prospectId: string; customer: NonNullable<TradeOpportunityDetail["contact"]> | null }) {
  const { pending, error, run } = useMutation(onOpenChange);
  const [name, setName] = useState(customer?.name ?? "");
  const [company, setCompany] = useState(customer?.company ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Customer"
      description="Who the quote goes to. Sending needs an email address."
      error={error}
      pending={pending}
      submitLabel="Save customer"
      pendingLabel="Saving…"
      onSubmit={() => run(() => updateOpportunityCustomerAction({ prospect_id: prospectId, name, company, email, phone }))}
    >
      <div className="space-y-2">
        <Label htmlFor="customer-name">Name</Label>
        <Input id="customer-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="customer-company">Company</Label>
        <Input id="customer-company" value={company} maxLength={200} onChange={(e) => setCompany(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="customer-email">Email</Label>
        <Input id="customer-email" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="customer-phone">Phone</Label>
        <Input id="customer-phone" type="tel" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
      </div>
    </DialogShell>
  );
}

export function AcceptanceDialog({
  open,
  onOpenChange,
  estimateId,
  defaultName,
}: DialogProps & { estimateId: string; defaultName: string }) {
  const { pending, error, setError, run } = useMutation(onOpenChange);
  const [by, setBy] = useState(defaultName);
  const [note, setNote] = useState("");
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Record acceptance"
      description="The customer said yes outside the review link: by phone, email or a signed copy."
      error={error}
      pending={pending}
      submitLabel="Record acceptance"
      pendingLabel="Saving…"
      onSubmit={() => {
        if (by.trim().length < 2) {
          setError("Who accepted it?");
          return;
        }
        run(() => recordQuoteAcceptanceAction({ estimate_id: estimateId, accepted_by: by, note }));
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="accept-by">Accepted by</Label>
        <Input id="accept-by" value={by} maxLength={200} onChange={(e) => setBy(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="accept-note">Note</Label>
        <Textarea
          id="accept-note"
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Confirmed by email on Tuesday"
        />
      </div>
    </DialogShell>
  );
}

export function CloseDialog({
  open,
  onOpenChange,
  prospectId,
  outcome,
}: DialogProps & { prospectId: string; outcome: "lost" | "declined" }) {
  const { pending, error, run } = useMutation(onOpenChange);
  const [reason, setReason] = useState<string>(outcome === "lost" ? QUOTE_LOST_REASON_CODES[0] : DECLINE_REASON_CODES[0]);
  const [note, setNote] = useState("");
  const options =
    outcome === "lost"
      ? QUOTE_LOST_REASON_CODES.map((code) => ({ code, label: LOST_REASON_LABELS[code] }))
      : DECLINE_REASON_CODES.map((code) => ({ code, label: DECLINE_REASON_LABELS[code] }));
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={outcome === "lost" ? "Mark lost" : "Decline this job"}
      description={
        outcome === "lost"
          ? "The customer went another way. The reason feeds your win rate."
          : "You are choosing not to price this work."
      }
      error={error}
      pending={pending}
      submitLabel={outcome === "lost" ? "Mark lost" : "Decline"}
      pendingLabel="Saving…"
      onSubmit={() => {
        const lost = QUOTE_LOST_REASON_CODES.find((code) => code === reason);
        const declined = DECLINE_REASON_CODES.find((code) => code === reason);
        if (outcome === "lost" && lost)
          run(() => closeTradeOpportunityAction({ prospect_id: prospectId, outcome, reason_code: lost, note }));
        else if (outcome === "declined" && declined)
          run(() => closeTradeOpportunityAction({ prospect_id: prospectId, outcome, reason_code: declined, note }));
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="close-reason">Reason</Label>
        <select
          id="close-reason"
          className={SELECT_CLASS}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="close-note">Note</Label>
        <Textarea id="close-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </div>
    </DialogShell>
  );
}

export function StartJobSheet({
  open,
  onOpenChange,
  data,
}: DialogProps & { data: TradeOpportunityDetail }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const draft = data.jobDraft;
  const [name, setName] = useState(draft.name);
  const [basis, setBasis] = useState(draft.billing_basis);
  const [retainage, setRetainage] = useState(draft.retainage_percent);
  const [terms, setTerms] = useState(draft.payment_terms_days);
  const [certifies, setCertifies] = useState(draft.customer_certifies);
  const [reviewBeforeSend, setReviewBeforeSend] = useState(draft.review_before_send);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const noun = draft.customer_kind === "company" ? "builder" : "customer";

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await startTradeJobFromQuoteAction({
        prospect_id: data.opportunity.id,
        name,
        billing_basis: basis,
        retainage_percent: retainage,
        payment_terms_days: terms,
        customer_certifies: basis === "progress" && certifies,
        review_before_send: reviewBeforeSend,
        start_date: start || undefined,
        end_date: end || undefined,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      router.push(`/projects/${result.data.id}`);
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        aria-labelledby="start-job-title"
        className="overflow-y-auto p-6 sm:max-w-lg"
        mobileFullscreen
      >
        <SheetHeader>
          <SheetTitle id="start-job-title">Start job</SheetTitle>
          <SheetDescription>
            The customer, address, scope and accepted price carry over from the quote.
          </SheetDescription>
        </SheetHeader>
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="start-job-name">Job name</Label>
            <Input
              id="start-job-name"
              value={name}
              required
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex items-baseline justify-between border-y py-2 text-sm">
            <span className="text-muted-foreground">Contract amount</span>
            <span className="font-medium tabular-nums">{formatMoneyCents(data.opportunity.move.valueCents)}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="start-job-billing">How you bill</Label>
              <select
                id="start-job-billing"
                className={SELECT_CLASS}
                value={basis}
                onChange={(e) => {
                  if (isTradeBillingBasis(e.target.value)) setBasis(e.target.value);
                }}
              >
                <option value="progress">Pay applications (SOV)</option>
                <option value="invoices">Fixed price invoices</option>
                <option value="time_and_materials">Time & materials</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="start-job-terms">Payment terms</Label>
              <select
                id="start-job-terms"
                className={SELECT_CLASS}
                value={terms}
                onChange={(e) => setTerms(Number(e.target.value))}
              >
                <option value={0}>Due on receipt</option>
                <option value={15}>Net 15</option>
                <option value={30}>Net 30</option>
                <option value={45}>Net 45</option>
                <option value={60}>Net 60</option>
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="start-job-retainage">Retainage the {noun} holds (%)</Label>
            <Input
              id="start-job-retainage"
              type="number"
              min="0"
              max="50"
              step="0.5"
              className="tabular-nums"
              value={retainage}
              onChange={(e) => setRetainage(Number(e.target.value) || 0)}
            />
          </div>
          {basis === "progress" && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={certifies} onCheckedChange={(checked) => setCertifies(checked === true)} />
              <span>The {noun} certifies each pay application before it is invoiced</span>
            </label>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={reviewBeforeSend}
              onCheckedChange={(checked) => setReviewBeforeSend(checked === true)}
            />
            <span>Approve each invoice in the office before it goes out</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="start-job-start">Start</Label>
              <Input id="start-job-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="start-job-end">Finish</Label>
              <Input id="start-job-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Starting…" : "Start job"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
