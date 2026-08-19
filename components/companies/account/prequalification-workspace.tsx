"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  requestPrequalificationAction,
  reviewPrequalificationAction,
  sendPrequalificationInviteAction,
  setPrequalificationTemplateAction,
  waivePrequalificationAction,
} from "@/app/(app)/directory/[id]/prequalification/actions";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, MoreHorizontal } from "@/components/icons";
import { formatDate, formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import {
  daysUntil,
  expiryTone,
  isPrequalificationReviewable,
  prequalificationStatusMeta,
} from "@/components/companies/account/prequalification-status";
import {
  PrequalDecisionDialog,
  PrequalInviteDialog,
  PrequalProgramDialog,
  PrequalWaiveDialog,
  type DecisionValues,
} from "@/components/companies/account/prequalification-dialogs";
import { useToast } from "@/hooks/use-toast";
import { unwrapAction } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import type { ComplianceDocumentType } from "@/lib/types";
import type {
  PrequalificationDocumentSlot,
  PrequalificationPackage,
} from "@/lib/services/prequalification";
import {
  PREQUAL_FIELD_KEYS,
  PREQUAL_FIELD_LABELS,
  prequalFieldMode,
  type PrequalFieldKey,
  type PrequalificationTemplate,
} from "@/lib/validation/prequalification";

/** Whether an expectation has been met, and how loudly to say so. */
type RowState = "met" | "waiting" | "short";

interface ExpectationRow {
  key: string;
  label: string;
  required: boolean;
  state: RowState;
  value: ReactNode;
}

interface ExpectationGroup {
  key: string;
  title: string;
  rows: ExpectationRow[];
}

function dollarsToCents(value: string): number | null {
  const trimmed = value.replaceAll(",", "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function StatusChip({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn("inline-flex items-center border px-2 py-0.5 text-xs font-medium", className)}
    >
      {label}
    </span>
  );
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="microlabel">{label}</div>
      <div className={cn("mt-0.5 font-mono text-sm tabular-nums", tone ?? "text-foreground")}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

const STATE_DOT: Record<RowState, string> = {
  met: "bg-success",
  waiting: "border border-border bg-transparent",
  short: "bg-destructive",
};

/**
 * One expectation and what came back against it. Everything the builder is
 * owed reads down a single column, so the question and its answer never sit on
 * different screens.
 */
function Expectation({ row }: { row: ExpectationRow }) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5">
      <span
        aria-hidden
        className={cn("mt-[0.4375rem] size-2 shrink-0 rounded-full", STATE_DOT[row.state])}
      />
      <span className="min-w-0 flex-1 text-sm leading-5">{row.label}</span>
      <span
        className={cn(
          "text-[11px] uppercase leading-5 tracking-wide",
          row.required ? "text-muted-foreground" : "text-muted-foreground/60",
        )}
      >
        {row.required ? "Required" : "Optional"}
      </span>
      <span
        className={cn(
          "w-full pl-5 text-sm leading-5 sm:w-64 sm:pl-0 sm:text-right",
          row.state === "short"
            ? "text-destructive"
            : row.state === "waiting"
              ? "text-muted-foreground"
              : "text-foreground",
        )}
      >
        {row.value}
      </span>
    </li>
  );
}

function answerText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function fieldAnswer(
  key: PrequalFieldKey,
  current: PrequalificationPackage["current"],
): string | null {
  if (!current) return null;
  if (key === "trades") return current.trades?.length ? current.trades.join(", ") : null;
  if (key === "emr") return current.emr != null ? current.emr.toFixed(2) : null;
  if (key === "years_in_business") {
    return current.years_in_business != null ? `${current.years_in_business} years` : null;
  }
  const cents = current[key];
  return typeof cents === "number" ? formatMoneyFromCents(cents) : null;
}

function documentAnswer(slot: PrequalificationDocumentSlot): {
  state: RowState;
  value: string;
} {
  if (!slot.document) {
    return {
      state: slot.is_required ? "short" : "waiting",
      value: slot.is_required ? "Not received" : "Not provided",
    };
  }
  const detail = [
    slot.document.file_name,
    slot.document.expiry_date ? `expires ${formatDate(slot.document.expiry_date)}` : null,
    slot.document.from_this_package ? null : "already on file",
  ]
    .filter(Boolean)
    .join(" · ");

  switch (slot.document.status) {
    case "approved":
      return { state: "met", value: detail || "Approved" };
    case "pending_review":
      return { state: "waiting", value: `Awaiting review${detail ? ` · ${detail}` : ""}` };
    case "rejected":
      return { state: "short", value: "Rejected" };
    case "expired":
      return { state: "short", value: "Expired" };
    default:
      return { state: "waiting", value: detail || slot.document.status };
  }
}

/** One-line-per-item summary of a program, for the invite dialog. */
function describeProgram(
  template: PrequalificationTemplate,
  documentTypes: ComplianceDocumentType[],
): string[] {
  const items: string[] = [];
  const fields = PREQUAL_FIELD_KEYS.filter((key) => prequalFieldMode(template, key) !== "off");
  if (fields.length > 0) items.push(`${fields.length} company details`);
  if (template.questions.length > 0) {
    items.push(
      `${template.questions.length} question${template.questions.length === 1 ? "" : "s"}`,
    );
  }
  if (template.references_required > 0) items.push(`${template.references_required} references`);
  for (const document of template.documents) {
    const name = documentTypes.find((type) => type.id === document.document_type_id)?.name;
    if (name) items.push(`${name}${document.is_required ? "" : " (optional)"}`);
  }
  return items;
}

export function PrequalificationWorkspace({
  companyId,
  companyName,
  data,
  documentTypes,
  canEdit,
  canReview,
}: {
  companyId: string;
  companyName: string;
  data: PrequalificationPackage;
  documentTypes: ComplianceDocumentType[];
  canEdit: boolean;
  canReview: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  const [decisionOpen, setDecisionOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [programOpen, setProgramOpen] = useState(false);
  /** The working copy inside the editor; discarded on cancel. */
  const [draft, setDraft] = useState<PrequalificationTemplate | null>(null);
  /**
   * A program tailored for a request that has not been sent yet. There is no
   * row to write it to, so it waits here and rides along with the send.
   */
  const [tailored, setTailored] = useState<PrequalificationTemplate | null>(null);

  const { template, orgTemplate, current, documents, history, exposure } = data;
  const status = prequalificationStatusMeta(current?.status);
  const expiryDays = daysUntil(current?.expires_at);
  const reviewable = isPrequalificationReviewable(current?.status);
  const waived = current?.status === "waived";
  const responded = Boolean(current?.submitted_at);
  const approved =
    current?.status === "approved" || current?.status === "approved_with_limits";

  const programEditable = canEdit && (!current || current.status === "requested");
  const effectiveTemplate = tailored ?? template;

  /**
   * The whole tab in one list: every expectation, in the order it was asked,
   * carrying whatever came back against it.
   */
  const groups = useMemo<ExpectationGroup[]>(() => {
    if (waived) return [];
    const result: ExpectationGroup[] = [];

    const rowFor = (
      key: string,
      label: string,
      required: boolean,
      answer: string | null,
    ): ExpectationRow => ({
      key,
      label,
      required,
      state: answer ? "met" : !responded ? "waiting" : required ? "short" : "waiting",
      value: answer ?? (responded ? (required ? "Not answered" : "Skipped") : "Awaiting"),
    });

    const fields = PREQUAL_FIELD_KEYS.filter(
      (key) => prequalFieldMode(effectiveTemplate, key) !== "off",
    );
    if (fields.length > 0) {
      result.push({
        key: "company",
        title: "Company details",
        rows: fields.map((key) =>
          rowFor(
            key,
            PREQUAL_FIELD_LABELS[key],
            prequalFieldMode(effectiveTemplate, key) === "required",
            fieldAnswer(key, current),
          ),
        ),
      });
    }

    for (const question of effectiveTemplate.questions) {
      const group = result.find((entry) => entry.key === `section:${question.section}`);
      const row = rowFor(
        question.id,
        question.label,
        question.required,
        answerText(current?.questionnaire?.[question.id]),
      );
      if (group) group.rows.push(row);
      else
        result.push({
          key: `section:${question.section}`,
          title: question.section,
          rows: [row],
        });
    }

    if (documents.length > 0) {
      result.push({
        key: "documents",
        title: "Documents",
        rows: documents.map((slot) => {
          const answer = documentAnswer(slot);
          return {
            key: slot.document_type_id,
            label: slot.document_type_name,
            required: slot.is_required,
            state: answer.state,
            value: answer.value,
          };
        }),
      });
    } else if (effectiveTemplate.documents.length > 0) {
      // Slots only exist once a request carries the program; before that, the
      // plan still has to be visible.
      result.push({
        key: "documents",
        title: "Documents",
        rows: effectiveTemplate.documents.map((document) => ({
          key: document.document_type_id,
          label:
            documentTypes.find((type) => type.id === document.document_type_id)?.name ??
            "Document",
          required: document.is_required,
          state: "waiting" as const,
          value: "Awaiting",
        })),
      });
    }

    return result;
  }, [waived, effectiveTemplate, current, documents, documentTypes, responded]);

  const references = (current?.references_data ?? []) as Array<Record<string, unknown>>;
  const referencesRequired = effectiveTemplate.references_required;

  const legacyAnswers = useMemo(() => {
    if (!current) return [];
    const known = new Set(effectiveTemplate.questions.map((question) => question.id));
    return Object.entries(current.questionnaire ?? {}).filter(([key]) => !known.has(key));
  }, [current, effectiveTemplate]);

  const runAction = (label: string, fn: () => Promise<void>) =>
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (error) {
        toast({
          title: label,
          description: error instanceof Error ? error.message : "Something went wrong",
        });
      }
    });

  const openProgramEditor = () => {
    setDraft(tailored ?? template);
    setProgramOpen(true);
  };

  const saveProgram = () => {
    if (!draft) return;
    if (!current) {
      setTailored(draft);
      setDraft(null);
      setProgramOpen(false);
      toast({
        title: "Tailored for this vendor",
        description: `Used when you send the request to ${companyName}.`,
      });
      return;
    }
    runAction("Unable to update what we ask for", async () => {
      unwrapAction(await setPrequalificationTemplateAction(companyId, current.id, draft));
      setProgramOpen(false);
      setDraft(null);
      toast({ title: "Updated" });
    });
  };

  const adoptOrgProgram = () =>
    runAction("Unable to update what we ask for", async () => {
      if (!current) {
        setTailored(null);
        return;
      }
      unwrapAction(await setPrequalificationTemplateAction(companyId, current.id, null));
      setDraft(null);
      toast({ title: "Using your current org program" });
    });

  const sendRequest = ({ message, sendEmail }: { message: string; sendEmail: boolean }) =>
    runAction("Unable to request prequalification", async () => {
      const result = unwrapAction(
        await requestPrequalificationAction(companyId, {
          send_invite: sendEmail,
          message: message || undefined,
          template: tailored ?? undefined,
        }),
      );
      setInviteOpen(false);
      setTailored(null);
      const invite = result.invite;
      toast({
        title: "Prequalification requested",
        description: !sendEmail
          ? "Recorded. Send the vendor their link when you are ready."
          : invite?.sent
            ? `Invitation sent to ${invite.email}`
            : (invite?.reason ?? "Recorded, but the invitation could not be sent."),
      });
    });

  const resendInvite = ({ message }: { message: string }) =>
    runAction("Unable to send invitation", async () => {
      const invite = unwrapAction(
        await sendPrequalificationInviteAction(companyId, {
          send_invite: true,
          message: message || undefined,
        }),
      );
      setInviteOpen(false);
      toast({
        title: invite.sent ? "Invitation sent" : "Invitation not sent",
        description: invite.sent ? `Sent to ${invite.email}` : invite.reason,
      });
    });

  const decide = (values: DecisionValues) =>
    runAction("Unable to record the decision", async () => {
      if (!current) return;
      const result = unwrapAction(
        await reviewPrequalificationAction(companyId, current.id, {
          decision: values.decision,
          expires_at: values.expiresAt || undefined,
          single_project_limit_cents: dollarsToCents(values.singleLimit),
          aggregate_limit_cents: dollarsToCents(values.aggregateLimit),
          review_notes: values.notes || null,
        }),
      );
      setDecisionOpen(false);
      toast({
        title:
          values.decision === "declined"
            ? "Prequalification declined"
            : "Prequalification approved",
        description: result.notified
          ? "The vendor has been emailed the decision."
          : "No vendor email on file, so no notice was sent.",
      });
    });

  const waive = ({ reason, expiresAt }: { reason: string; expiresAt: string }) =>
    runAction("Unable to waive prequalification", async () => {
      unwrapAction(
        await waivePrequalificationAction(companyId, { reason, expires_at: expiresAt || null }),
      );
      setWaiveOpen(false);
      toast({
        title: "Prequalification waived",
        description: `${companyName} will pass the commitment check without a package.`,
      });
    });

  const headroom = exposure.aggregate_headroom_cents;
  const shortfall = groups.reduce(
    (total, group) => total + group.rows.filter((row) => row.state === "short").length,
    0,
  );

  const overflowItems = [
    programEditable
      ? { key: "program", label: "Edit what we ask for", onSelect: openProgramEditor }
      : null,
    canEdit && data.templateOutdated
      ? { key: "adopt", label: "Use current org program", onSelect: adoptOrgProgram }
      : null,
    canReview && !waived
      ? { key: "waive", label: "Waive prequalification", onSelect: () => setWaiveOpen(true) }
      : null,
  ].filter((item): item is { key: string; label: string; onSelect: () => void } => item !== null);

  const meta = [
    current?.invited_at ? `Invited ${formatDate(current.invited_at)}` : null,
    current?.submitted_at
      ? `Returned ${formatDate(current.submitted_at)}${current.submitted_by_name ? ` by ${current.submitted_by_name}` : ""}`
      : null,
    current?.reviewed_at
      ? `${waived ? "Waived" : "Decided"} ${formatDate(current.reviewed_at)}`
      : null,
  ].filter(Boolean);

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="desk-rise border bg-background">
        {/* Identity and actions. The tab already says what this is, so the strip
            reports state instead of repeating the title. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-muted/40 px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <StatusChip label={status.label} className={status.className} />
            {meta.map((entry) => (
              <span key={entry} className="text-xs text-muted-foreground">
                {entry}
              </span>
            ))}
          </div>

          {canEdit ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {current && reviewable ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setInviteOpen(true)}
                >
                  {current.invited_at ? "Resend invitation" : "Send invitation"}
                </Button>
              ) : null}
              {canReview && current && reviewable && !responded ? (
                <Button size="sm" disabled={pending} onClick={() => setDecisionOpen(true)}>
                  Record decision
                </Button>
              ) : null}
              {!current || !reviewable ? (
                <Button size="sm" disabled={pending} onClick={() => setInviteOpen(true)}>
                  {current && !waived ? "Request renewal" : "Request prequalification"}
                </Button>
              ) : null}
              {overflowItems.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label="More prequalification actions"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {overflowItems.map((item) => (
                      <DropdownMenuItem key={item.key} onSelect={item.onSelect}>
                        {item.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ) : null}
        </div>

        {canEdit && data.templateOutdated ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2.5">
            <p className="text-sm text-warning">
              This went out with an older version of your program. {companyName} has not started,
              so you can still switch it.
            </p>
            <Button size="sm" variant="outline" disabled={pending} onClick={adoptOrgProgram}>
              Use current program
            </Button>
          </div>
        ) : null}

        {responded && reviewable ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-primary/5 px-4 py-2.5">
            <p className="text-sm">
              {companyName} returned this package
              {shortfall > 0 ? ` with ${shortfall} gap${shortfall === 1 ? "" : "s"}` : ""}. It is
              waiting on your decision.
            </p>
            {canReview ? (
              <Button size="sm" disabled={pending} onClick={() => setDecisionOpen(true)}>
                Record decision
              </Button>
            ) : null}
          </div>
        ) : null}

        {approved ? (
          <div className="grid grid-cols-2 gap-4 border-b p-4 md:grid-cols-4">
            <Figure
              label="Expires"
              value={current?.expires_at ? formatDate(current.expires_at) : "—"}
              tone={expiryTone(expiryDays)}
              hint={
                expiryDays === null
                  ? undefined
                  : expiryDays < 0
                    ? `${Math.abs(expiryDays)} days ago`
                    : `in ${expiryDays} days`
              }
            />
            <Figure
              label="Single project limit"
              value={
                current?.single_project_limit_cents != null
                  ? formatMoneyFromCents(current.single_project_limit_cents)
                  : "No limit"
              }
            />
            <Figure
              label="Aggregate limit"
              value={
                current?.aggregate_limit_cents != null
                  ? formatMoneyFromCents(current.aggregate_limit_cents)
                  : "No limit"
              }
            />
            <Figure
              label="Approved commitments"
              value={formatMoneyFromCents(exposure.active_commitment_cents)}
              tone={headroom != null && headroom < 0 ? "text-destructive" : undefined}
              hint={
                headroom == null
                  ? undefined
                  : headroom < 0
                    ? `${formatMoneyFromCents(Math.abs(headroom))} over the limit`
                    : `${formatMoneyFromCents(headroom)} of headroom`
              }
            />
          </div>
        ) : null}

        {waived ? (
          <div className="px-4 py-6">
            <p className="text-sm">
              {companyName} does not need to prequalify. This satisfies the commitment and bid
              checks the same way an approval does.
            </p>
            {current?.review_notes ? (
              <p className="mt-3 whitespace-pre-wrap border-l-2 border-border pl-3 text-sm text-muted-foreground">
                {current.review_notes}
              </p>
            ) : null}
            {current?.expires_at ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Comes back up for review {formatDate(current.expires_at)}.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-2.5">
              <h2 className="text-sm font-semibold">What we expect from {companyName}</h2>
              <p className="text-xs text-muted-foreground">
                {!current
                  ? tailored
                    ? "Tailored for this vendor — sent when you request it"
                    : "From your org program in Settings → Compliance"
                  : responded
                    ? "Their answers are shown against each item"
                    : "Nothing back from them yet"}
              </p>
            </div>

            {groups.length === 0 && referencesRequired === 0 ? (
              <div className="px-4 py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  This program asks for nothing yet.
                </p>
                {programEditable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={openProgramEditor}
                  >
                    Choose what to ask for
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                {groups.map((group) => (
                  <section key={group.key}>
                    <div className="microlabel border-b bg-muted/20 px-4 py-1.5">
                      {group.title}
                    </div>
                    <ul className="divide-y border-b">
                      {group.rows.map((row) => (
                        <Expectation key={row.key} row={row} />
                      ))}
                    </ul>
                  </section>
                ))}

                {referencesRequired > 0 ? (
                  <section>
                    <div className="microlabel flex items-center justify-between border-b bg-muted/20 px-4 py-1.5">
                      <span>References</span>
                      <span className="tabular-nums">
                        {references.length} of {referencesRequired}
                      </span>
                    </div>
                    {references.length === 0 ? (
                      <div className="border-b px-4 py-3 text-sm text-muted-foreground">
                        {responded
                          ? `Only ${references.length} of ${referencesRequired} provided`
                          : "Awaiting"}
                      </div>
                    ) : (
                      <ul className="divide-y border-b">
                        {references.map((reference, index) => (
                          <li key={index} className="px-4 py-2.5">
                            <div className="text-sm font-medium">
                              {String(reference.company_name ?? "Reference")}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {[
                                reference.contact_name,
                                reference.email,
                                reference.phone,
                                typeof reference.amount_cents === "number"
                                  ? formatMoneyFromCents(reference.amount_cents)
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ") || "No contact details"}
                            </div>
                            {reference.project_description ? (
                              <p className="mt-1 text-xs">
                                {String(reference.project_description)}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ) : null}

                {legacyAnswers.length > 0 ? (
                  <section>
                    <div className="microlabel border-b bg-muted/20 px-4 py-1.5">
                      Other answers
                    </div>
                    <ul className="divide-y border-b">
                      {legacyAnswers.map(([key, value]) => (
                        <Expectation
                          key={key}
                          row={{
                            key,
                            label: key.replaceAll("_", " "),
                            required: false,
                            state: "met",
                            value: answerText(value) ?? "—",
                          }}
                        />
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            )}
          </>
        )}

        {current?.review_notes && !waived ? (
          <div className="border-b px-4 py-3">
            <div className="microlabel">Review notes</div>
            <p className="mt-1 whitespace-pre-wrap text-sm">{current.review_notes}</p>
          </div>
        ) : null}

        {documents.length > 0 && !waived ? (
          <div className="border-b px-4 py-2">
            <Link
              href={`/directory/${companyId}/compliance`}
              className="text-xs text-primary hover:underline"
            >
              Manage documents on the Compliance tab
            </Link>
          </div>
        ) : null}

        {history.length > 0 ? (
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-muted/40">
              <span className="text-xs text-muted-foreground">
                {history.length} earlier prequalification{history.length === 1 ? "" : "s"}
              </span>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="divide-y border-t">
                {history.map((entry) => {
                  const entryStatus = prequalificationStatusMeta(entry.status);
                  return (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm"
                    >
                      <div className="flex items-center gap-3">
                        <StatusChip label={entryStatus.label} className={entryStatus.className} />
                        <span className="text-muted-foreground">
                          Requested {formatDate(entry.requested_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        {entry.single_project_limit_cents != null ? (
                          <span className="font-mono tabular-nums">
                            {formatMoneyFromCents(entry.single_project_limit_cents)} / project
                          </span>
                        ) : null}
                        <span>
                          {entry.reviewed_at
                            ? `Decided ${formatDate(entry.reviewed_at)}`
                            : "No decision"}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>

      <PrequalDecisionDialog
        open={decisionOpen}
        onOpenChange={setDecisionOpen}
        companyName={companyName}
        submissionIssues={data.submissionIssues}
        missingDocumentCount={data.missingDocumentCount}
        pending={pending}
        onSubmit={decide}
      />

      <PrequalInviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        mode={current && reviewable ? "resend" : "request"}
        companyName={companyName}
        askedFor={describeProgram(effectiveTemplate, documentTypes)}
        lastInvitedAt={current?.invited_at}
        pending={pending}
        onSend={current && reviewable ? resendInvite : sendRequest}
      />

      <PrequalWaiveDialog
        open={waiveOpen}
        onOpenChange={setWaiveOpen}
        companyName={companyName}
        pending={pending}
        onWaive={waive}
      />

      {draft ? (
        <PrequalProgramDialog
          open={programOpen}
          onOpenChange={(next) => {
            setProgramOpen(next);
            if (!next) setDraft(null);
          }}
          companyName={companyName}
          draft={draft}
          orgTemplate={orgTemplate}
          documentTypes={documentTypes}
          isRequestOpen={Boolean(current)}
          pending={pending}
          onDraftChange={setDraft}
          onSave={saveProgram}
          onReset={() => setDraft(orgTemplate)}
        />
      ) : null}
    </div>
  );
}
