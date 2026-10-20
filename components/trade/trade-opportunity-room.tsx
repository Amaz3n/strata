"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  reopenTradeOpportunityAction,
  reviseTradeQuoteAction,
  setOpportunityDueAction,
} from "@/app/(app)/pipeline/[dealId]/trade-actions";
import { describeActivity } from "@/lib/sales/activity";
import type { TradeOpportunityDetail } from "@/lib/services/trade-quotes";
import { formatLocalDate, formatMoneyCents } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QUOTE_EDITOR_ID, QuoteEditor } from "@/components/trade/quote-editor";
import {
  AcceptanceDialog,
  CloseDialog,
  CustomerDialog,
  FollowUpDialog,
  LogContactDialog,
  StartJobSheet,
  dateInputValue,
  localDateToIso,
} from "@/components/trade/trade-opportunity-dialogs";
import { opportunitySourceLabel } from "@/lib/validation/trade-quotes";

type Dialog = "customer" | "followup" | "contact" | "accept" | "lost" | "declined" | "start" | null;

const TONE_CLASS = {
  late: "text-destructive",
  soon: "text-warning",
  none: "text-muted-foreground",
} as const;

const ACTIVITY_TITLES: Record<string, string> = {
  prospect_created: "Opportunity added",
  estimate_sent: "Quote sent",
  estimate_client_signed: "Customer accepted and signed",
  estimate_accepted_outside_portal: "Acceptance recorded",
  estimate_changes_requested: "Customer asked for changes",
  estimate_rejected: "Customer turned it down",
  prospect_follow_up_set: "Follow-up set",
  prospect_won: "Job started",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  changes_requested: "Changes requested",
  rejected: "Turned down",
  approved: "Accepted",
  client_signed: "Signed",
  executed: "Signed",
  converted_to_project: "Job started",
};

function activityTitle(event: TradeOpportunityDetail["activity"][number]) {
  const known = ACTIVITY_TITLES[event.event_type];
  const described = describeActivity(event);
  return { title: known ?? described.title, note: described.note };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function TradeOpportunityRoom({ data, now }: { data: TradeOpportunityDetail; now: string }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { opportunity: opp, contact, canWrite } = data;
  const move = opp.move;
  const stage = move.stage;
  const open = stage !== "won" && stage !== "lost";
  const followUpLate = opp.followUpAt !== null && new Date(opp.followUpAt) < new Date(now);

  function run(send: () => Promise<{ success: true } | { success: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await send();
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function focusEditor() {
    const editor = document.getElementById(QUOTE_EDITOR_ID);
    editor?.scrollIntoView({ behavior: "smooth", block: "start" });
    editor?.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true });
  }

  function primary() {
    switch (move.action) {
      case "build_quote":
      case "finish_quote":
        return { label: move.action === "build_quote" ? "Build the quote" : "Finish the quote", onClick: focusEditor };
      case "follow_up":
        return { label: "Follow up", onClick: () => setDialog("followup") };
      case "revise":
        return {
          label: "Revise quote",
          onClick: () =>
            data.quote &&
            run(() => reviseTradeQuoteAction({ estimate_id: data.quote?.id })),
        };
      case "start_job":
        return data.canStartJob ? { label: "Start job", onClick: () => setDialog("start") } : null;
      case "reopen":
        return {
          label: "Reopen",
          onClick: () => run(() => reopenTradeOpportunityAction({ prospect_id: opp.id })),
        };
      default:
        return null;
    }
  }
  const main = move.action === "open_job" ? null : primary();
  const showVersions = data.versions.length > 1 || data.versions.some((version) => version.sentAt);

  return (
    <div className="space-y-8 desk-rise">
      <section aria-label="Opportunity" className="space-y-4 border-b pb-5">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Customer">
            {contact ? (
              <>
                <span className="font-medium">{contact.name || contact.company || "Unnamed"}</span>
                {contact.name && contact.company && (
                  <span className="block text-muted-foreground">{contact.company}</span>
                )}
                {contact.email && <span className="block truncate text-muted-foreground">{contact.email}</span>}
                {contact.phone && <span className="block text-muted-foreground">{contact.phone}</span>}
              </>
            ) : (
              <span className="text-muted-foreground">No customer yet</span>
            )}
            {canWrite && open && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="mt-1 h-auto p-0 text-xs"
                onClick={() => setDialog("customer")}
              >
                {contact?.email ? "Edit customer" : "Add an email to send the quote"}
              </Button>
            )}
          </Fact>
          <Fact label="Source">{opp.fromInvitation ? "Builder invitation" : opportunitySourceLabel(opp.source)}</Fact>
          <Fact label="Price due">
            {canWrite && open ? (
              <Input
                type="date"
                aria-label="Price due date"
                className="h-8 w-40 text-sm"
                disabled={pending}
                defaultValue={dateInputValue(opp.dueAt)}
                onChange={(e) =>
                  run(() =>
                    setOpportunityDueAction({
                      prospect_id: opp.id,
                      due_at: e.target.value ? localDateToIso(e.target.value) : null,
                    }),
                  )
                }
              />
            ) : opp.dueAt ? (
              format(new Date(opp.dueAt), "MMM d, yyyy")
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </Fact>
          <Fact label="Follow-up">
            {opp.followUpAt ? (
              <span className={followUpLate ? "text-destructive" : undefined}>
                {format(new Date(opp.followUpAt), "MMM d, yyyy")}
              </span>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </Fact>
        </dl>

        <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/40 px-3 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <Badge variant="outline">{move.label}</Badge>
            <span className={`text-sm ${TONE_CLASS[move.tone]}`}>{move.sentence}</span>
            {move.valueCents > 0 && (
              <span className="text-sm font-medium tabular-nums">{formatMoneyCents(move.valueCents)}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {move.action === "open_job" && opp.jobId && (
              <Button asChild size="sm">
                <Link href={`/projects/${opp.jobId}`}>Open job</Link>
              </Button>
            )}
            {canWrite && main && (
              <Button size="sm" disabled={pending} onClick={main.onClick}>
                {pending ? "Working…" : main.label}
              </Button>
            )}
          </div>
        </div>

        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {data.quote && (stage === "quoting" || stage === "sent") && (
              <Button size="sm" variant="outline" onClick={() => setDialog("accept")}>
                Record acceptance
              </Button>
            )}
            {open && (
              <>
                <Button size="sm" variant="outline" onClick={() => setDialog("followup")}>
                  Set follow-up
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDialog("lost")}>
                  Mark lost
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDialog("declined")}>
                  Decline
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" onClick={() => setDialog("contact")}>
              Log contact
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>

      {data.scope && stage === "invited" && (
        <section aria-label="Request" className="space-y-1">
          <h2 className="text-sm font-semibold">What they asked for</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{data.scope}</p>
          {data.address && <p className="text-sm text-muted-foreground">{data.address}</p>}
        </section>
      )}

      <QuoteEditor data={data} />

      {showVersions && (
        <section aria-label="Versions" className="space-y-2">
          <h2 className="text-sm font-semibold">Versions</h2>
          <table className="w-full max-w-2xl border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Version</th>
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 pr-3 font-medium">Sent</th>
                <th className="py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.versions.map((version) => (
                <tr key={version.id} className="border-b">
                  <td className="py-1.5 pr-3">
                    v{version.version}
                    {version.current && (
                      <Badge variant="secondary" className="ml-2">
                        Current
                      </Badge>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">{STATUS_LABELS[version.status] ?? version.status}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">
                    {version.sentAt ? formatLocalDate(version.sentAt.slice(0, 10), "MMM d, yyyy") : ""}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{formatMoneyCents(version.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section aria-label="Activity" className="space-y-2">
        <h2 className="text-sm font-semibold">Activity</h2>
        {data.activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet. Sends, replies and calls show up here.</p>
        ) : (
          <ul className="max-w-2xl divide-y border-y">
            {data.activity.map((event) => {
              const { title, note } = activityTitle(event);
              return (
                <li key={event.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                  <span className="min-w-0">
                    {title}
                    {note && <span className="block text-muted-foreground">{note}</span>}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {format(new Date(event.created_at), "MMM d, h:mm a")}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canWrite && (
        <>
          {dialog === "customer" && (
            <CustomerDialog open onOpenChange={() => setDialog(null)} prospectId={opp.id} customer={contact} />
          )}
          {dialog === "followup" && (
            <FollowUpDialog open onOpenChange={() => setDialog(null)} prospectId={opp.id} followUpAt={opp.followUpAt} />
          )}
          {dialog === "contact" && <LogContactDialog open onOpenChange={() => setDialog(null)} prospectId={opp.id} />}
          {dialog === "accept" && data.quote && (
            <AcceptanceDialog
              open
              onOpenChange={() => setDialog(null)}
              estimateId={data.quote.id}
              defaultName={contact?.name ?? contact?.company ?? ""}
            />
          )}
          {(dialog === "lost" || dialog === "declined") && (
            <CloseDialog open onOpenChange={() => setDialog(null)} prospectId={opp.id} outcome={dialog} />
          )}
          {dialog === "start" && data.canStartJob && (
            <StartJobSheet open onOpenChange={() => setDialog(null)} data={data} />
          )}
        </>
      )}
    </div>
  );
}
