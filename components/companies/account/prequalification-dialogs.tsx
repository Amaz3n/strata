"use client";

import { useEffect, useState } from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { ComplianceDocumentType } from "@/lib/types";
import type { PrequalificationTemplate } from "@/lib/validation/prequalification";
import { PrequalificationProgramEditor } from "@/components/companies/account/prequalification-program-editor";

export type PrequalDecision = "approved" | "approved_with_limits" | "declined";

export interface DecisionValues {
  decision: PrequalDecision;
  singleLimit: string;
  aggregateLimit: string;
  expiresAt: string;
  notes: string;
}

const DECISION_OPTIONS: Array<{
  value: PrequalDecision;
  label: string;
  detail: string;
}> = [
  {
    value: "approved",
    label: "Approve",
    detail: "No cap. Any commitment passes the prequalification check.",
  },
  {
    value: "approved_with_limits",
    label: "Approve with limits",
    detail: "Passes up to a dollar figure, then warns or blocks.",
  },
  {
    value: "declined",
    label: "Decline",
    detail: "Commitments will flag this vendor as not prequalified.",
  },
];

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function PrequalDecisionDialog({
  open,
  onOpenChange,
  companyName,
  submissionIssues,
  missingDocumentCount,
  validityDaysHint,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  submissionIssues: string[];
  missingDocumentCount: number;
  validityDaysHint?: number;
  pending: boolean;
  onSubmit: (values: DecisionValues) => void;
}) {
  const [decision, setDecision] = useState<PrequalDecision>("approved");
  const [singleLimit, setSingleLimit] = useState("");
  const [aggregateLimit, setAggregateLimit] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [notes, setNotes] = useState("");

  // A dialog that keeps the last decision's numbers invites approving one
  // vendor at another's limits.
  useEffect(() => {
    if (!open) return;
    setDecision("approved");
    setSingleLimit("");
    setAggregateLimit("");
    setExpiresAt("");
    setNotes("");
  }, [open]);

  const needsLimit = decision === "approved_with_limits";
  const limitMissing = needsLimit && !singleLimit && !aggregateLimit;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Decide {companyName}&apos;s prequalification</DialogTitle>
          <DialogDescription>
            The vendor is emailed the outcome, including any limits and notes you leave.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {submissionIssues.length > 0 ? (
            <Warning>
              Unanswered: {submissionIssues.join(", ")}. You can still decide.
            </Warning>
          ) : null}
          {missingDocumentCount > 0 ? (
            <Warning>
              {missingDocumentCount} required document
              {missingDocumentCount === 1 ? " is" : "s are"} still outstanding.
            </Warning>
          ) : null}

          <div
            role="radiogroup"
            aria-label="Decision"
            className="grid gap-2"
          >
            {DECISION_OPTIONS.map((option) => {
              const selected = decision === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setDecision(option.value)}
                  className={cn(
                    "border px-3 py-2.5 text-left transition-colors",
                    selected
                      ? option.value === "declined"
                        ? "border-destructive bg-destructive/5"
                        : "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/60",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-3.5 shrink-0 rounded-full border",
                        selected
                          ? option.value === "declined"
                            ? "border-[5px] border-destructive"
                            : "border-[5px] border-primary"
                          : "border-input",
                      )}
                    />
                    <span className="text-sm font-medium">{option.label}</span>
                  </div>
                  <p className="mt-0.5 pl-[1.375rem] text-xs text-muted-foreground">
                    {option.detail}
                  </p>
                </button>
              );
            })}
          </div>

          {needsLimit ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="decision-single">Per project ($)</Label>
                <Input
                  id="decision-single"
                  inputMode="decimal"
                  className="tabular-nums"
                  placeholder="No cap"
                  value={singleLimit}
                  onChange={(event) => setSingleLimit(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="decision-aggregate">Total at once ($)</Label>
                <Input
                  id="decision-aggregate"
                  inputMode="decimal"
                  className="tabular-nums"
                  placeholder="No cap"
                  value={aggregateLimit}
                  onChange={(event) => setAggregateLimit(event.target.value)}
                />
              </div>
            </div>
          ) : null}

          {decision !== "declined" ? (
            <div className="space-y-1.5">
              <Label htmlFor="decision-expiry">Valid until</Label>
              <Input
                id="decision-expiry"
                type="date"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {validityDaysHint
                  ? `Leave blank to use your org's ${validityDaysHint}-day validity period.`
                  : "Leave blank to use your org's validity period."}
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="decision-notes">Notes to the vendor</Label>
            <Textarea
              id="decision-notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={
                decision === "declined"
                  ? "What would change your answer?"
                  : "Scopes they are approved for, conditions, anything to flag."
              }
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={decision === "declined" ? "destructive" : "default"}
            disabled={pending || limitMissing}
            onClick={() =>
              onSubmit({ decision, singleLimit, aggregateLimit, expiresAt, notes })
            }
          >
            {pending
              ? "Saving…"
              : decision === "declined"
                ? "Decline"
                : decision === "approved_with_limits"
                  ? "Approve with limits"
                  : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PrequalInviteDialog({
  open,
  onOpenChange,
  mode,
  companyName,
  askedFor,
  lastInvitedAt,
  pending,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "request" | "resend";
  companyName: string;
  askedFor: string[];
  lastInvitedAt?: string | null;
  pending: boolean;
  onSend: (options: { message: string; sendEmail: boolean }) => void;
}) {
  const [message, setMessage] = useState("");
  const [sendEmail, setSendEmail] = useState(true);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setSendEmail(true);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "request" ? `Request a prequalification from ${companyName}` : "Resend the invitation"}
          </DialogTitle>
          <DialogDescription>
            {companyName} gets a secure link to complete this online. No project is needed — the
            link belongs to their account with you.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {askedFor.length > 0 ? (
            <div className="border bg-muted/40 px-3 py-2.5">
              <div className="microlabel mb-1">They will be asked for</div>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {askedFor.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {lastInvitedAt ? (
            <p className="text-xs text-muted-foreground">
              Last invited {new Date(lastInvitedAt).toLocaleDateString()}.
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="invite-message">Message</Label>
            <Textarea
              id="invite-message"
              rows={3}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Optional. Added to the email above the link."
            />
          </div>

          {mode === "request" ? (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={sendEmail}
                onCheckedChange={(checked) => setSendEmail(checked === true)}
              />
              <span>
                Email the invitation now
                <span className="block text-xs text-muted-foreground">
                  Leave this off to record the request and send the link yourself later.
                </span>
              </span>
            </label>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => onSend({ message, sendEmail })}>
            {pending
              ? "Sending…"
              : mode === "resend"
                ? "Send invitation"
                : sendEmail
                  ? "Request and send"
                  : "Record request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PrequalWaiveDialog({
  open,
  onOpenChange,
  companyName,
  pending,
  onWaive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  pending: boolean;
  onWaive: (values: { reason: string; expiresAt: string }) => void;
}) {
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  useEffect(() => {
    if (!open) return;
    setReason("");
    setExpiresAt("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Waive prequalification for {companyName}</DialogTitle>
          <DialogDescription>
            For vendors who do not need a package — a long-standing supplier, a sole trader doing
            small punch work, a utility with no alternative.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            A waiver satisfies the commitment and bid checks exactly as an approval does. It is
            recorded against this vendor with your name and reason, and replaces any open request.
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="waive-reason">Why this vendor does not need one</Label>
            <Textarea
              id="waive-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Sole supplier for this material; 12-year relationship; under $5k per job."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="waive-expiry">Review again on</Label>
            <Input
              id="waive-expiry"
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Optional. Leave blank to waive indefinitely; set a date and the waiver lapses like an
              approval would.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || !reason.trim()}
            onClick={() => onWaive({ reason, expiresAt })}
          >
            {pending ? "Saving…" : "Waive prequalification"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PrequalProgramDialog({
  open,
  onOpenChange,
  companyName,
  draft,
  orgTemplate,
  documentTypes,
  isRequestOpen,
  pending,
  onDraftChange,
  onSave,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  draft: PrequalificationTemplate;
  orgTemplate: PrequalificationTemplate;
  documentTypes: ComplianceDocumentType[];
  /** Saving writes to a live request rather than to the next one you send. */
  isRequestOpen: boolean;
  pending: boolean;
  onDraftChange: (next: PrequalificationTemplate) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What to ask {companyName}</DialogTitle>
          <DialogDescription>
            {isRequestOpen
              ? "Changes apply to the open request. The vendor sees them next time they open their link."
              : "Changes apply to the request you are about to send. Your org program is unchanged."}
          </DialogDescription>
        </DialogHeader>

        <PrequalificationProgramEditor
          value={draft}
          orgTemplate={orgTemplate}
          documentTypes={documentTypes}
          onChange={onDraftChange}
        />

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={onReset}>
            Reset to org program
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={onSave}>
              {pending ? "Saving…" : isRequestOpen ? "Save changes" : "Use this program"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
