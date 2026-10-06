"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  LockKeyhole,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import {
  closeAccountingPeriodAction,
  reopenAccountingPeriodAction,
  resolveReconciliationItemAction,
  runCloseChecklistAction,
  runReconciliationNowAction,
} from "@/app/(app)/books/actions";
import { WipReview } from "@/components/books/wip-review";
import { ClearingSupport } from "@/components/books/clearing-support";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { closeReviewState, isAbandonedClose } from "@/lib/services/books/close-review";
import { cn } from "@/lib/utils";

type Workspace = Awaited<
  ReturnType<typeof import("@/lib/services/books/workspace").getBooksWorkspace>
>;
type Props = {
  periods: Workspace["periods"];
  checks: Workspace["closeItems"];
  findings: Workspace["reconciliationItems"];
  findingTotal: number;
  capabilities: Workspace["capabilities"];
  asOf: string;
  periodId?: string;
};
type CheckRow = Props["checks"][number];
const date = (value: string) =>
  new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const month = (value: string) =>
  new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
const currency = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function destination(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return null;
  return value === "/books/accountant" ? "/settings/accounting/taxes" : value;
}

export function CloseWorkspace(props: Props) {
  const periods = [...props.periods].sort((a, b) =>
    b.period_end.localeCompare(a.period_end),
  );
  const selected =
    periods.find((period) => period.id === props.periodId) ??
    [...periods]
      .reverse()
      .find(
        (period) =>
          ["open", "reopened", "reviewing"].includes(period.status) &&
          period.period_end <= props.asOf,
      ) ??
    periods.find((period) => period.period_start <= props.asOf) ??
    periods[0];
  return (
    <div className="min-h-[calc(100svh-8rem)] bg-background">
      <div className="flex flex-wrap items-center justify-end gap-2 border-b px-5 py-3">
        <Button asChild variant="ghost" size="sm"><Link href="/reports?collection=statements">Financial statements</Link></Button>
        {props.capabilities.export ? <Button asChild variant="outline" size="sm"><Link href="/books/exports">Exports & accountant handoff</Link></Button> : null}
        {props.capabilities.tax ? <Button asChild variant="ghost" size="sm"><Link href="/books/taxes">Tax filing records</Link></Button> : null}
      </div>
      {selected ? (
        <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)]">
          <nav
            aria-label="Accounting periods"
            className="min-w-0 border-b bg-muted/20 p-4 lg:border-b-0 lg:border-r lg:p-5"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Periods
              </h2>
              <span className="text-xs tabular-nums text-muted-foreground">
                {periods.length}
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto lg:max-h-[75svh] lg:flex-col lg:overflow-y-auto">
              {periods.map((period) => (
                <Link
                  key={period.id}
                  href={`/books/close/${period.id}`}
                  aria-current={selected.id === period.id ? "page" : undefined}
                  className={cn(
                    "flex min-w-48 items-center justify-between gap-3 rounded-md border border-transparent px-3 py-3 transition-colors hover:bg-muted lg:min-w-0",
                    selected.id === period.id &&
                      "border-border bg-background shadow-sm",
                  )}
                >
                  <div>
                    <p className="text-sm font-medium">
                      {month(period.period_start)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      FY {period.fiscal_year} · P{period.fiscal_period}
                      <span className="ml-2 capitalize">{period.status}</span>
                    </p>
                  </div>
                  {period.status === "closed" ? (
                    <LockKeyhole
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  ) : selected.id === period.id ? (
                    <ArrowRight className="size-4 shrink-0" aria-hidden />
                  ) : null}
                </Link>
              ))}
            </div>
          </nav>
          <PeriodReview
            key={selected.id}
            {...props}
            period={selected}
            laterClosed={periods.find(
              (period) =>
                period.status === "closed" &&
                period.period_start > selected.period_end,
            )}
          />
        </div>
      ) : (
        <div className="mx-auto max-w-lg px-6 py-24 text-center">
          <Circle className="mx-auto mb-5 size-10 text-muted-foreground" />
          <h2 className="text-xl font-semibold">
            Your first close starts with a period
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Set up your accounting calendar to begin reviewing and closing your
            books.
          </p>
          <Button asChild className="mt-6" variant="outline">
            <Link href="/settings/accounting/calendar">
              Open accounting calendar <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function PeriodReview({
  period,
  checks,
  findings,
  findingTotal,
  capabilities,
  laterClosed,
}: Props & {
  period: Props["periods"][number];
  laterClosed: Props["periods"][number] | undefined;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [operation, setOperation] = useState("");
  const [dialog, setDialog] = useState<"close" | "reopen" | null>(null);
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useState<"attention" | "all">("attention");
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const { rows, blockers, attention, passed, ready } = closeReviewState(
    checks,
    period.id,
  );
  const closed = period.status === "closed";
  const reviewing = period.status === "reviewing";
  const [checkedAt] = useState(() => new Date());
  const abandoned = isAbandonedClose(period.status, period.close_started_at, checkedAt);
  const updatedAt = rows
    .map((check) => check.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1);
  const visible = (filter === "all" || closed ? rows : attention)
    .slice()
    .sort(
      (a, b) =>
        Number(b.blocking && b.status !== "passed") -
          Number(a.blocking && a.status !== "passed") ||
        a.category.localeCompare(b.category),
    );
  const act = (
    label: string,
    run: () => Promise<{ success: boolean; error?: string }>,
    refreshChecks = false,
  ) => {
    setOperation(label);
    startTransition(async () => {
      try {
        const result = await run();
        if (!result.success) {
          toast.error(result.error ?? "The action could not be completed");
          router.refresh();
          return;
        }
        if (refreshChecks) {
          const refreshed = await runCloseChecklistAction(period.id);
          if (!refreshed.success)
            toast.error(
              refreshed.error ?? "Saved, but checks could not be refreshed",
            );
        }
        toast.success(label === "Run checks" ? "Period checks updated" : label);
        setDialog(null);
        setReason("");
        router.refresh();
      } catch {
        toast.error("Could not complete the action. Please try again.");
        router.refresh();
      }
    });
  };
  const renderCheck = (check: CheckRow) => {
    const evidence = record(check.evidence);
    const href =
      destination(evidence.href) ??
      (check.category === "controls" ? "/books/ledger" : null);
    const isPassed = check.status === "passed";
    return (
      <details key={check.id} className="group border-b last:border-b-0">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-1 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          {isPassed ? (
            <CheckCircle2
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-success"
            />
          ) : (
            <CircleAlert
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                check.blocking ? "text-destructive" : "text-warning",
              )}
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{check.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {isPassed
                ? "Verified"
                : `${check.issue_count || "Outstanding"} ${check.issue_count === 1 ? "item" : "items"}`}{" "}
              ·{" "}
              <span className="capitalize">
                {check.category === "integrations" &&
                check.code !== "sync_backlog"
                  ? "Ledger integrity"
                  : check.category}
              </span>
            </p>
          </div>
          <span
            className={cn(
              "shrink-0 text-xs",
              isPassed
                ? "text-muted-foreground"
                : check.blocking
                  ? "text-destructive"
                  : "text-warning",
            )}
          >
            {isPassed ? "Passed" : check.blocking ? "Required" : "Advisory"}
          </span>
          <span
            aria-hidden
            className="text-muted-foreground group-open:rotate-90"
          >
            ›
          </span>
        </summary>
        <div className="space-y-4 pb-5 pl-8 pr-2">
          <p className="text-xs leading-5 text-muted-foreground">
            {isPassed
              ? "This control passed at the last check."
              : check.blocking
                ? "Resolve the underlying exception, then run checks again. This control must pass before the period can close."
                : "Review this activity for completeness. This advisory does not prevent closing."}
          </p>
          {typeof evidence.difference_cents === "number" ? (
            <dl className="grid gap-3 border-l-2 pl-4 text-xs sm:grid-cols-3">
              {[
                ["Ledger", evidence.ledger_cents],
                ["Subledger", evidence.subledger_cents],
                ["Difference", evidence.difference_cents],
              ].map(([label, amount]) =>
                typeof amount === "number" ? (
                  <div key={String(label)}>
                    <dt className="text-muted-foreground">{String(label)}</dt>
                    <dd className="mt-1 font-mono">{currency(amount)}</dd>
                  </div>
                ) : null,
              )}
            </dl>
          ) : null}
          {evidence.scan_capped === true ? (
            <p className="text-xs text-warning">
              More records remain than this check can review. Resolve the listed
              exceptions and run checks again.
            </p>
          ) : null}
          {!closed && !reviewing && !isPassed ? (
            <div className="flex flex-wrap gap-2">
              {check.code === "clearing_accounts" && capabilities.close ? (
                <ClearingSupport periodId={period.id} />
              ) : check.code === "poc_snapshots" && capabilities.close ? (
                <WipReview periodId={period.id} />
              ) : href ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={href}>
                    Review source <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : null}
          {check.code === "accounting_drift" && !closed ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium">
                  Live reconciliation findings · {findingTotal}
                </p>
                {capabilities.reconcile && !reviewing ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      act(
                        "Reconciliation updated",
                        runReconciliationNowAction,
                        capabilities.close,
                      )
                    }
                  >
                    Recheck reconciliation
                  </Button>
                ) : null}
              </div>
              {findings.length < findingTotal ? (
                <p className="text-xs text-muted-foreground">
                  Showing {findings.length} of {findingTotal} findings. More
                  will appear as these are resolved.
                </p>
              ) : null}
              {findings.map((finding) => {
                const detail = record(finding.details);
                const source = destination(detail.href);
                const explanation = explanations[finding.id] ?? "";
                return (
                  <div
                    key={finding.id}
                    className="space-y-3 rounded-md border p-4"
                  >
                    <div className="flex justify-between gap-3">
                      <p className="text-xs font-medium">
                        {String(
                          detail.description ??
                            detail.cure ??
                            finding.category.replaceAll("_", " "),
                        )}
                      </p>
                      {finding.difference_cents !== null ? (
                        <span className="font-mono text-xs">
                          {currency(finding.difference_cents)}
                        </span>
                      ) : null}
                    </div>
                    {source ? (
                      <Link
                        href={source}
                        className="text-xs underline underline-offset-4"
                      >
                        Review source record
                      </Link>
                    ) : null}
                    {capabilities.reconcile && !reviewing ? (
                      <>
                        <label
                          className="block text-xs text-muted-foreground"
                          htmlFor={`reason-${finding.id}`}
                        >
                          Reason for accepting this difference
                        </label>
                        <Textarea
                          id={`reason-${finding.id}`}
                          value={explanation}
                          onChange={(event) =>
                            setExplanations((current) => ({
                              ...current,
                              [finding.id]: event.target.value,
                            }))
                          }
                          rows={2}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() =>
                              act(
                                "Finding marked cured",
                                () =>
                                  resolveReconciliationItemAction({
                                    itemId: finding.id,
                                    disposition: "resolved",
                                  }),
                                capabilities.close,
                              )
                            }
                          >
                            Mark cured
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending || explanation.trim().length < 10}
                            onClick={() =>
                              act(
                                "Difference accepted",
                                () =>
                                  resolveReconciliationItemAction({
                                    itemId: finding.id,
                                    disposition: "explained",
                                    explanation,
                                  }),
                                capabilities.close,
                              )
                            }
                          >
                            Accept difference
                          </Button>
                        </div>
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </details>
    );
  };
  return (
    <main className="min-w-0 px-5 py-7 md:px-8 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              FY {period.fiscal_year} / Period {period.fiscal_period}
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">
              {month(period.period_start)}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {date(period.period_start)} — {date(period.period_end)}
            </p>
          </div>
          <span
            className={cn(
              "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs",
              closed && "border-success/20 bg-success/5 text-success",
            )}
          >
            {closed ? (
              <LockKeyhole className="size-3.5" />
            ) : (
              <Circle className="size-3" />
            )}
            <span className="capitalize">{period.status}</span>
          </span>
        </div>
        <div className="my-8 grid gap-0 border-y py-5 sm:grid-cols-3">
          {[
            {
              label: "Verify",
              detail: rows.length
                ? `${passed} of ${rows.length} controls passed`
                : "Checks have not been run",
              done: rows.length > 0 && passed === rows.length,
            },
            {
              label: "Resolve",
              detail: blockers.length
                ? `${blockers.length} required controls remain`
                : rows.length
                  ? "No blocking exceptions"
                  : "Awaiting first review",
              done: ready,
            },
            {
              label: "Close",
              detail: closed
                ? `Closed ${period.closed_at ? date(period.closed_at) : "and locked"}`
                : "Lock entries & save statements",
              done: closed,
            },
          ].map((step, index) => (
            <div
              key={step.label}
              className="flex gap-3 py-2 sm:border-r sm:px-5 sm:first:pl-0 sm:last:border-0"
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                  step.done && "border-success/20 bg-success/10 text-success",
                )}
              >
                {step.done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <div>
                <p className="text-sm font-medium">{step.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {step.detail}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_260px]">
          <section aria-label="Period controls">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-semibold">
                {closed ? "Closing review" : "Period review"}
              </h3>
              {!closed && rows.length > 0 ? (
                <div className="flex rounded-md border p-0.5">
                  {(["attention", "all"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                      className={cn(
                        "rounded px-2.5 py-1 text-xs",
                        filter === value
                          ? "bg-muted font-medium"
                          : "text-muted-foreground",
                      )}
                    >
                      {value === "attention"
                        ? `Needs attention (${attention.length})`
                        : `All (${rows.length})`}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {rows.length === 0 ? (
              <div className="py-14">
                <CircleAlert className="mb-4 size-7 text-muted-foreground" />
                <h4 className="text-base font-medium">
                  {closed
                    ? "No saved checklist available"
                    : "Start with a fresh review"}
                </h4>
                <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                  {closed
                    ? "This period is closed, but no checklist was returned for it."
                    : "Run checks to review bank reconciliation, ledger balances, project accounting, and tax completeness for this period."}
                </p>
              </div>
            ) : visible.length === 0 ? (
              <div className="py-14">
                <CheckCircle2 className="mb-4 size-8 text-success" />
                <h4 className="text-lg font-medium">The checks are clear.</h4>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  All {rows.length} controls passed. Closing runs a fresh
                  verification before locking the period.
                </p>
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className="mt-4 text-xs underline underline-offset-4"
                >
                  Review passed controls
                </button>
              </div>
            ) : (
              <div className="mt-3">{visible.map(renderCheck)}</div>
            )}
          </section>
          <aside className="order-first rounded-lg border bg-muted/20 p-5 xl:sticky xl:top-5 xl:order-last">
            <h3 className="text-sm font-semibold">
              {closed
                ? "Period secured"
                : reviewing
                  ? "Close in progress"
                  : ready
                    ? "Ready for final verification"
                    : "Prepare to close"}
            </h3>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {closed
                ? "Entries in this period are locked. Closing saved the financial statements for this period."
                : abandoned
                  ? "This close stopped before it finished, so entries in this period are still frozen. Resume it to finish closing; the checks run again first."
                  : reviewing
                  ? "This period is being closed. Refresh to see the result before making further changes."
                  : "Closing verifies controls, recognizes project revenue, and saves financial statements before locking entries."}
            </p>
            {!closed &&
            (period.fiscal_period === 12 || period.fiscal_period === 13) ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                Year-end balances transfer to retained earnings automatically
                during close.
              </p>
            ) : null}
            <div className="mt-5 space-y-2">
              {abandoned && capabilities.close ? (
                <Button
                  className="w-full"
                  disabled={pending}
                  onClick={() =>
                    act("Period closed", () =>
                      closeAccountingPeriodAction(period.id),
                    )
                  }
                >
                  <LockKeyhole className="size-3.5" />
                  Resume close
                </Button>
              ) : reviewing ? (
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => router.refresh()}
                >
                  Refresh status
                </Button>
              ) : closed ? (
                <>
                  {capabilities.reopen && laterClosed ? (
                    <p className="text-sm text-muted-foreground">
                      Periods reopen newest first. Reopen the period ending{" "}
                      {date(laterClosed.period_end)} before correcting this one.
                    </p>
                  ) : capabilities.reopen ? (
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={() => setDialog("reopen")}
                    >
                      Reopen for a correction
                    </Button>
                  ) : null}
                </>
              ) : capabilities.close ? (
                <>
                  <Button
                    className="w-full"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      act("Run checks", () =>
                        runCloseChecklistAction(period.id),
                      )
                    }
                  >
                    <RefreshCw
                      className={cn(
                        "size-3.5",
                        pending && "motion-safe:animate-spin",
                      )}
                    />
                    {pending
                      ? "Working…"
                      : rows.length
                        ? "Run checks again"
                        : "Run checks"}
                  </Button>
                  <Button
                    className="w-full"
                    disabled={pending || !ready}
                    onClick={() => setDialog("close")}
                  >
                    <LockKeyhole className="size-3.5" />
                    Close period
                  </Button>
                </>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">
                  Your role can review this period. An authorized closer must
                  run checks and close it.
                </p>
              )}
            </div>
            {!closed && !reviewing && !ready && capabilities.close ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {rows.length
                  ? "Required controls must pass before closing."
                  : "Run checks to unlock the close action."}
              </p>
            ) : null}
            {updatedAt ? (
              <p className="mt-5 border-t pt-4 text-xs text-muted-foreground">
                Last checked {date(updatedAt)}. Checks are a point-in-time
                review.
              </p>
            ) : null}
            <p role="status" className="sr-only">
              {pending ? `${operation} in progress` : ""}
            </p>
          </aside>
        </div>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!pending && !open) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "reopen" ? "Reopen" : "Close"}{" "}
              {month(period.period_start)}?
            </DialogTitle>
            <DialogDescription>
              {dialog === "reopen"
                ? "Reopening allows corrections to this period. Record a reason for the audit trail, then run a new review and close again when corrections are complete."
                : "Arc will rerun the checks, post any required revenue and year-end entries, save statements, and lock this period. Corrections afterward require reopening."}
            </DialogDescription>
          </DialogHeader>
          {dialog === "reopen" ? (
            <div className="space-y-2">
              <label className="text-sm" htmlFor="reopen-reason">
                Correction and supporting evidence
              </label>
              <Textarea
                id="reopen-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Explain the correction needed (at least 10 characters)"
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setDialog(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                pending || (dialog === "reopen" && reason.trim().length < 10)
              }
              onClick={() =>
                dialog === "reopen"
                  ? act("Period reopened", () =>
                      reopenAccountingPeriodAction(period.id, reason),
                    )
                  : act("Period closed", () =>
                      closeAccountingPeriodAction(period.id),
                    )
              }
            >
              {pending
                ? "Working…"
                : dialog === "reopen"
                  ? "Reopen period"
                  : "Confirm close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
