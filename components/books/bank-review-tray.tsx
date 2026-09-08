"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, Check } from "lucide-react";
import { toast } from "sonner";

import {
  categorizeBankTransactionAction,
  loadBankCostCodingOptionsAction,
  confirmBankMatchAction,
  excludeBankTransactionAction,
  loadBankReviewTrayAction,
} from "@/app/(app)/books/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BankReviewTray } from "@/lib/services/books/bank-reconciliation";
import { cn, formatMoneyCentsExact } from "@/lib/utils";

/**
 * The unmatched tray.
 *
 * Bank transactions used to be an inline filter on the register: you could see
 * that something was unmatched, but not what it probably matched, and confirming
 * meant one transaction at a time with no idea how many were ready. Suggestions
 * arrive already scored, so the tray can lead with how much of the work is a
 * single click, and an unmapped bank account is called out rather than quietly
 * producing rows that can never match.
 */

/** Above this a suggestion is strong enough to accept in bulk without reading it. */
const CONFIDENT = 0.95;

type GlAccount = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  active: boolean;
};

export function BankReviewTray({ accounts }: { accounts: GlAccount[] }) {
  const [data, setData] = useState<BankReviewTray | null>(null);
  const [coding, setCoding] = useState<{ projects: Array<{ id: string; name: string }>; costCodes: Array<{ id: string; code: string; name: string }> } | null>(null);
  const [projectByTransaction, setProjectByTransaction] = useState<Record<string, string>>({});
  const [costCodeByTransaction, setCostCodeByTransaction] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const undepositedFundsAccount = accounts.find(
    (account) => account.active && account.code === "1010",
  );

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    loadBankReviewTrayAction()
      .then((result) => {
        if (result.success) setData(result.data as BankReviewTray);
        else setError(result.error ?? "The review tray could not be loaded.");
      })
      .catch(() => setError("The review tray could not be loaded."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);
  useEffect(() => { let active = true; loadBankCostCodingOptionsAction().then(result => { if (active && result.success) setCoding(result.data); }); return () => { active = false; }; }, []);

  const confirmOne = (
    row: BankReviewTray["rows"][number],
    suggestion = row.best,
  ) => {
    if (!suggestion) return;
    setBusyId(row.transactionId);
    startTransition(async () => {
      const result = await confirmBankMatchAction({
        bankTransactionId: row.transactionId,
        journalLineId: suggestion.journalLineId,
        amountCents: row.amountCents,
        confidence: suggestion.confidence,
      });
      setBusyId(null);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Matched");
      load();
    });
  };

  const categorize = (
    row: BankReviewTray["rows"][number],
    glAccountId: string,
  ) => {
    if (!glAccountId) return;
    setBusyId(row.transactionId);
    startTransition(async () => {
      const result = await categorizeBankTransactionAction({
        bankTransactionId: row.transactionId,
        glAccountId,
        projectId: projectByTransaction[row.transactionId] || null,
        costCodeId: costCodeByTransaction[row.transactionId] || null,
        appliedRuleId: row.ruleSuggestion?.ruleId ?? null,
      });
      setBusyId(null);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(projectByTransaction[row.transactionId] ? "Posted to Books and project actuals; customer billing requires a separate review" : "Categorized and posted");
      load();
    });
  };

  const exclude = (row: BankReviewTray["rows"][number]) => {
    setBusyId(row.transactionId);
    startTransition(async () => {
      const result = await excludeBankTransactionAction(
        row.transactionId,
        row.amountCents,
      );
      setBusyId(null);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Excluded from reconciliation");
      load();
    });
  };

  const confirmAllConfident = (rows: BankReviewTray["rows"]) => {
    const ready = rows.filter(
      (row) => row.best && row.best.confidence >= CONFIDENT,
    );
    startTransition(async () => {
      let matched = 0;
      // Sequential on purpose: each confirmation consumes a journal line, and two
      // transactions can be offered the same one.
      for (const row of ready) {
        const result = await confirmBankMatchAction({
          bankTransactionId: row.transactionId,
          journalLineId: row.best!.journalLineId,
          amountCents: row.amountCents,
          confidence: row.best!.confidence,
        });
        if (result.success) matched += 1;
      }
      toast[matched === ready.length ? "success" : "warning"](
        matched === ready.length
          ? `Matched ${matched} transaction${matched === 1 ? "" : "s"}`
          : `Matched ${matched} of ${ready.length}; the rest need a look`,
      );
      load();
    });
  };

  if (loading) return <TraySkeleton />;

  if (error) {
    return (
      <div className="border bg-background px-5 py-12 text-center">
        <p className="text-sm font-medium">
          The review tray could not be loaded
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {error}
        </p>
      </div>
    );
  }

  if (!data) return null;

  const confidentCount = data.rows.filter(
    (row) => row.best && row.best.confidence >= CONFIDENT,
  ).length;

  return (
    <div className="space-y-3">
      {data.unmappedAccounts.length > 0 ? (
        <div className="flex items-start gap-2.5 border border-warning/30 bg-warning/10 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-medium">
              {data.unmappedAccounts.length === 1
                ? "A bank account has"
                : "Bank accounts have"}{" "}
              no GL account mapped
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {data.unmappedAccounts.map((account) => account.name).join(", ")}{" "}
              — transactions here cannot be matched to the ledger until a GL
              account is set. Map{" "}
              {data.unmappedAccounts.length === 1 ? "it" : "them"} in{" "}
              <Link
                href="/books/banking"
                className="underline underline-offset-4"
              >
                Banking
              </Link>
              .
            </p>
          </div>
        </div>
      ) : null}

      {data.rows.length === 0 ? (
        <div className="border bg-background px-5 py-12 text-center">
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            Every bank transaction is matched or excluded. Nothing to review.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {data.rows.length} unmatched
              {confidentCount > 0
                ? ` · ${confidentCount} with a confident suggestion`
                : null}
            </p>
            {confidentCount > 0 ? (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => confirmAllConfident(data.rows)}
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                Match {confidentCount} confident
              </Button>
            ) : null}
          </div>

          <section className="border bg-background">
            <div className="divide-y">
              {data.rows.map((row) => {
                const busy = busyId === row.transactionId && pending;
                return (
                  <div
                    key={row.transactionId}
                    className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-start"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {row.transactionDate}
                        </span>
                        <span className="truncate text-sm font-medium">
                          {row.counterparty}
                        </span>
                        <Badge variant="outline">{row.direction}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row.bankAccountName}
                        {row.best ? (
                          <>
                            {" · "}
                            <span
                              className={cn(
                                row.best.confidence >= CONFIDENT &&
                                  "text-success",
                              )}
                            >
                              suggests{" "}
                              {row.best.journalDescription ||
                                "a posted ledger line"}{" "}
                              on {row.best.journalDate} (
                              {Math.round(row.best.confidence * 100)}%)
                            </span>
                          </>
                        ) : row.accountUnmapped ? (
                          <> · this account has no GL account mapped</>
                        ) : row.ruleSuggestion ? (
                          <>
                            {" · "}
                            <span
                              className={cn(
                                row.ruleSuggestion.autoApplies &&
                                  "text-success",
                              )}
                            >
                              a learned rule says{" "}
                              {row.ruleSuggestion.accountCode}{" "}
                              {row.ruleSuggestion.accountName}
                              {row.ruleSuggestion.autoApplies
                                ? ""
                                : " (still learning)"}
                            </span>
                          </>
                        ) : (
                          <>
                            {" "}
                            · no ledger line matches this amount within ten days
                            {row.direction === "inflow" &&
                            undepositedFundsAccount
                              ? "; clear 1010 when this is a settled customer deposit"
                              : ""}
                          </>
                        )}
                        {row.alternatives.length > 0 ? (
                          <ul className="mt-1.5 space-y-0.5">
                            {row.alternatives.map((alternative) => (
                              <li
                                key={alternative.journalLineId}
                                className="flex items-center gap-2 text-xs"
                              >
                                <button
                                  type="button"
                                  disabled={busy || pending}
                                  onClick={() => confirmOne(row, alternative)}
                                  className="text-left text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                                >
                                  {alternative.journalDescription ||
                                    "Posted ledger line"}{" "}
                                  on {alternative.journalDate} (
                                  {Math.round(alternative.confidence * 100)}%)
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      {!row.best && !row.accountUnmapped && coding && <>
                        <Select value={projectByTransaction[row.transactionId] || "overhead"} disabled={busy || pending} onValueChange={value => { setProjectByTransaction(current => ({ ...current, [row.transactionId]: value === "overhead" ? "" : value })); setCostCodeByTransaction(current => ({ ...current, [row.transactionId]: "" })); }}><SelectTrigger className="max-w-[200px]" aria-label="Project for bank spending"><SelectValue placeholder="Project" /></SelectTrigger><SelectContent><SelectItem value="overhead">No project</SelectItem>{coding.projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select>
                        {projectByTransaction[row.transactionId] && <Select value={costCodeByTransaction[row.transactionId] || "uncoded"} disabled={busy || pending} onValueChange={value => setCostCodeByTransaction(current => ({ ...current, [row.transactionId]: value === "uncoded" ? "" : value }))}><SelectTrigger className="max-w-[200px]" aria-label="Cost code for bank spending"><SelectValue placeholder="Cost code" /></SelectTrigger><SelectContent><SelectItem value="uncoded">Unassigned cost code</SelectItem>{coding.costCodes.map(code => <SelectItem key={code.id} value={code.id}>{code.code} · {code.name}</SelectItem>)}</SelectContent></Select>}
                      </>}

                      <span className="font-mono text-sm tabular-nums">
                        {formatMoneyCentsExact(row.amountCents)}
                      </span>
                      {row.best ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || pending}
                          onClick={() => confirmOne(row)}
                        >
                          Match
                        </Button>
                      ) : row.accountUnmapped ? null : row.ruleSuggestion ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || pending}
                          onClick={() =>
                            categorize(row, row.ruleSuggestion!.glAccountId)
                          }
                        >
                          Post to {row.ruleSuggestion.accountCode}
                        </Button>
                      ) : (
                        <div className="flex items-center gap-2">
                          {row.direction === "inflow" &&
                          undepositedFundsAccount ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || pending}
                              onClick={() =>
                                categorize(row, undepositedFundsAccount.id)
                              }
                            >
                              Clear deposits
                            </Button>
                          ) : null}
                          <Select
                            disabled={busy || pending}
                            onValueChange={(accountId) =>
                              categorize(row, accountId)
                            }
                          >
                            <SelectTrigger
                              size="sm"
                              className="max-w-[240px]"
                              aria-label={`Categorize ${row.counterparty}`}
                            >
                              <SelectValue placeholder="Categorize…" />
                            </SelectTrigger>
                            <SelectContent>
                              {accounts
                                .filter((account) => account.active)
                                .map((account) => (
                                  <SelectItem
                                    key={account.id}
                                    value={account.id}
                                  >
                                    {account.code} · {account.name}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || pending}
                        onClick={() => exclude(row)}
                      >
                        Exclude
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {data.truncated ? (
              <p className="border-t bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
                Showing the {data.rowCap} most recent unmatched transactions.
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

function TraySkeleton() {
  return (
    <div className="border bg-background divide-y">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          className="flex items-center justify-between gap-3 px-4 py-3"
        >
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-8 w-32" />
        </div>
      ))}
    </div>
  );
}
