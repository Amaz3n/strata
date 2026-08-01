"use client";

import Script from "next/script";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  approveCutoverAction,
  approveBooksComparisonAction,
  approveOpeningBalancesAction,
  buildSalesTaxSummaryAction,
  cancelCutoverAction,
  closeBankReconciliationAction,
  closeAccountingPeriodAction,
  closeFiscalYearAction,
  completeCutoverAction,
  createAccountingPeriodAction,
  createAdjustingJournalAction,
  createAccountantPackageAction,
  createBankReconciliationAction,
  createBooksComparisonAction,
  createBooksExportAction,
  createGlAccountAction,
  createPlaidLinkTokenAction,
  createPocJournalExportAction,
  exchangePlaidPublicTokenAction,
  excludeBankTransactionAction,
  explainBooksVarianceAction,
  getBooksExportDownloadAction,
  importOpeningBalancesAction,
  matchBestBankTransactionAction,
  postOpeningBalancesAction,
  prepareCutoverAction,
  reopenAccountingPeriodAction,
  rollbackCutoverAction,
  runCloseChecklistAction,
  runLedgerRebuildAction,
  setGlAccountActiveAction,
} from "./actions";

type Workspace = Awaited<
  ReturnType<typeof import("@/lib/services/books/workspace").getBooksWorkspace>
>;
export type BooksSection =
  | "overview"
  | "transactions"
  | "banking"
  | "chart"
  | "ledger"
  | "close"
  | "opening-balances"
  | "accountant"
  | "cutover";

declare global {
  interface Window {
    Plaid?: {
      create(options: {
        token: string;
        onSuccess(
          publicToken: string,
          metadata: {
            institution?: { institution_id?: string; name?: string };
          },
        ): void;
        onExit(error?: { error_message?: string } | null): void;
      }): { open(): void };
    };
  }
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
function formatMoney(cents: number | null | undefined) {
  return money.format(Number(cents ?? 0) / 100);
}
function statusTone(status: string) {
  return new Set([
    "passed",
    "ready",
    "closed",
    "posted",
    "active",
    "completed",
    "official",
  ]).has(status)
    ? "border-success/25 bg-success/10 text-success"
    : new Set(["failed", "blocked", "error"]).has(status)
      ? "border-destructive/25 bg-destructive/10 text-destructive"
      : "border-warning/25 bg-warning/10 text-warning";
}

function ResultButton({
  label,
  pendingLabel = "Working…",
  run,
  variant = "outline",
}: {
  label: string;
  pendingLabel?: string;
  run: () => Promise<{ success: boolean; error?: string; data?: unknown }>;
  variant?: "outline" | "default" | "destructive";
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await run();
          if (!result.success) toast.error(result.error ?? "Action failed");
          else {
            toast.success(`${label} complete`);
            router.refresh();
          }
        })
      }
    >
      {pending ? pendingLabel : label}
    </Button>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border-l border-border/80 pl-4 first:border-l-0 first:pl-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl font-medium tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function downloadTextFile(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number) {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function BankReconciliationDesk({
  workspace,
}: {
  workspace: Extract<Workspace, { initialized: true }>;
}) {
  const router = useRouter();
  return (
    <section className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
      <div className="border bg-background p-5">
        <p className="text-sm font-semibold">Start statement reconciliation</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter statement balances in integer cents. Close remains blocked until
          the difference is zero.
        </p>
        <form
          className="mt-4 space-y-3"
          action={async (formData) => {
            const result = await createBankReconciliationAction(formData);
            if (!result.success) toast.error(result.error);
            else {
              toast.success("Reconciliation opened");
              router.refresh();
            }
          }}
        >
          <select
            name="bankAccountId"
            required
            className="flex h-9 w-full border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Select bank account</option>
            {workspace.bankAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.official_name || account.name}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <Input name="statementStart" type="date" required />
            <Input name="statementEnd" type="date" required />
            <Input
              name="beginningBalanceCents"
              inputMode="numeric"
              placeholder="Beginning cents"
              required
            />
            <Input
              name="endingBalanceCents"
              inputMode="numeric"
              placeholder="Ending cents"
              required
            />
          </div>
          <Button className="w-full">Open reconciliation</Button>
        </form>
      </div>
      <div className="border bg-background">
        <div className="border-b px-5 py-4">
          <p className="text-sm font-semibold">Statement controls</p>
        </div>
        <div className="divide-y">
          {workspace.bankReconciliations.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-4 px-5 py-3"
            >
              <div>
                <p className="text-sm">
                  {item.statement_start} → {item.statement_end}
                </p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  Statement {formatMoney(item.ending_balance_cents)} ·
                  difference {formatMoney(item.difference_cents)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={statusTone(item.status)}>
                  {item.status}
                </Badge>
                {item.status !== "closed" && (
                  <ResultButton
                    label="Close at zero"
                    run={() => closeBankReconciliationAction(item.id)}
                  />
                )}
              </div>
            </div>
          ))}
          {workspace.bankReconciliations.length === 0 && (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              No statement reconciliations yet.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ParallelCloseDesk({
  workspace,
}: {
  workspace: Extract<Workspace, { initialized: true }>;
}) {
  const router = useRouter();
  return (
    <section className="border bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-semibold">Parallel-close proof</p>
        <p className="text-xs text-muted-foreground">
          Import a provider trial balance, explain variances, then approve each
          clean close.
        </p>
      </div>
      <div className="grid gap-5 p-5 lg:grid-cols-2">
        <form
          className="space-y-3"
          action={async (formData) => {
            const result = await createBooksComparisonAction(formData);
            if (!result.success) toast.error(result.error);
            else {
              toast.success("Trial balances compared");
              router.refresh();
            }
          }}
        >
          <select
            name="connectionId"
            required
            className="flex h-9 w-full border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Accounting provider</option>
            {workspace.accountingConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.display_name || connection.provider}
              </option>
            ))}
          </select>
          <select
            name="periodId"
            required
            className="flex h-9 w-full border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Accounting period</option>
            {workspace.periods.map((period) => (
              <option key={period.id} value={period.id}>
                FY {period.fiscal_year} · P{period.fiscal_period}
              </option>
            ))}
          </select>
          <Input
            name="asOf"
            type="date"
            required
            defaultValue={workspace.asOf}
          />
          <Textarea
            name="externalRows"
            rows={8}
            required
            className="font-mono text-xs"
            placeholder='[{"externalAccountId":"1","externalAccountName":"Cash","arcAccountCode":"1000","debitCents":100000,"creditCents":0}]'
          />
          <Button className="w-full">Compare trial balance</Button>
        </form>
        <div className="space-y-3">
          {workspace.comparisons.map((comparison) => (
            <div key={comparison.id} className="border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm">
                    {comparison.variance_count} variance(s)
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {comparison.completed_at?.slice(0, 10) ?? "running"}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={statusTone(comparison.status)}
                >
                  {comparison.status}
                </Badge>
              </div>
              {comparison.status !== "approved" &&
                comparison.unexplained_variance_count === 0 && (
                  <div className="mt-3">
                    <ResultButton
                      label="Approve comparison"
                      run={() =>
                        approveBooksComparisonAction(
                          comparison.id,
                          "Reviewed against provider trial balance and approved",
                        )
                      }
                    />
                  </div>
                )}
              {comparison.items
                .filter((item) => item.status === "unexplained")
                .map((item) => (
                  <form
                    key={item.id}
                    className="mt-3 flex gap-2 border-t pt-3"
                    action={async (formData) => {
                      const result = await explainBooksVarianceAction(
                        item.id,
                        String(formData.get("explanation") ?? ""),
                      );
                      if (!result.success) toast.error(result.error);
                      else {
                        toast.success("Variance explained");
                        router.refresh();
                      }
                    }}
                  >
                    <Input
                      name="explanation"
                      required
                      minLength={10}
                      placeholder={`${formatMoney(item.difference_cents)} variance explanation`}
                    />
                    <Button size="sm" variant="outline">
                      Explain
                    </Button>
                  </form>
                ))}
            </div>
          ))}
          {workspace.comparisons.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No parallel close evidence yet.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export function BooksClient({ workspace, section }: { workspace: Workspace; section: BooksSection }) {
  const [plaidReady, setPlaidReady] = useState(false);
  const [connecting, startPlaid] = useTransition();
  const router = useRouter();

  const { settings, statements } = workspace;
  const tabs: Array<{ key: BooksSection; label: string; href: string; count?: number }> = [
    { key: "overview", label: "Overview", href: "/books" },
    { key: "transactions", label: "Transactions", href: "/books/transactions", count: workspace.unmatchedTransactions.length },
    { key: "banking", label: "Banking", href: "/books/banking" },
    { key: "chart", label: "Chart", href: "/books/chart" },
    { key: "ledger", label: "Ledger", href: "/books/ledger" },
    { key: "close", label: "Close", href: "/books/close", count: workspace.closeItems.filter((item) => item.status === "failed").length },
    { key: "opening-balances", label: "Opening balances", href: "/books/opening-balances" },
    { key: "accountant", label: "Accountant", href: "/books/accountant" },
    { key: "cutover", label: "Cutover", href: "/books/cutover" },
  ];

  const connectPlaid = () =>
    startPlaid(async () => {
      if (!plaidReady || !window.Plaid) {
        toast.error("Plaid Link is still loading");
        return;
      }
      const token = await createPlaidLinkTokenAction();
      if (!token.success) {
        toast.error(token.error);
        return;
      }
      window.Plaid.create({
        token: token.data.linkToken,
        onSuccess: async (publicToken, metadata) => {
          const result = await exchangePlaidPublicTokenAction({
            publicToken,
            institutionId: metadata.institution?.institution_id,
            institutionName: metadata.institution?.name,
          });
          if (!result.success) toast.error(result.error);
          else {
            toast.success("Bank feed connected");
            router.refresh();
          }
        },
        onExit: (error) => {
          if (error?.error_message) toast.error(error.error_message);
        },
      }).open();
    });

  return (
    <div className="min-h-full bg-[linear-gradient(180deg,hsl(var(--muted)/.32),transparent_260px)]">
      <Script
        src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"
        strategy="afterInteractive"
        onLoad={() => setPlaidReady(true)}
      />
      <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
        <header className="relative overflow-hidden border bg-primary text-primary-foreground shadow-[0_24px_70px_-50px_rgba(0,0,0,.8)]">
          <div className="absolute inset-y-0 right-0 w-2/5 opacity-20 [background-image:repeating-linear-gradient(135deg,transparent_0,transparent_13px,white_14px,transparent_15px)]" />
          <div className="relative grid gap-7 px-6 py-7 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/55">
                  Arc Books · {workspace.asOf}
                </p>
                <Badge
                  variant="outline"
                  className="border-white/20 bg-white/10 text-white"
                >
                  {String(settings.arc_ledger_mode).replaceAll("_", " ")}
                </Badge>
                <Badge
                  variant="outline"
                  className="border-white/20 bg-white/10 text-white"
                >
                  {settings.ledger_authority === "arc"
                    ? "Arc is official"
                    : "External books are official"}
                </Badge>
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
                The books behind the build.
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">
                One economic record from project activity to bank
                reconciliation, close, and accountant handoff.
              </p>
            </div>
            <div className="grid min-w-[290px] grid-cols-3 gap-5 border-t border-white/15 pt-5 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
              <div>
                <p className="text-[9px] uppercase tracking-widest text-white/45">
                  Assets
                </p>
                <p className="mt-1 font-mono text-sm">
                  {formatMoney(statements.balanceSheet.assetCents)}
                </p>
              </div>
              <div>
                <p className="text-[9px] uppercase tracking-widest text-white/45">
                  Net income
                </p>
                <p className="mt-1 font-mono text-sm">
                  {formatMoney(statements.profitLoss.netIncomeCents)}
                </p>
              </div>
              <div>
                <p className="text-[9px] uppercase tracking-widest text-white/45">
                  TB delta
                </p>
                <p className="mt-1 font-mono text-sm">
                  {formatMoney(
                    statements.trialBalance.totalDebitCents -
                      statements.trialBalance.totalCreditCents,
                  )}
                </p>
              </div>
            </div>
          </div>
        </header>
        <nav
          className="mt-4 flex gap-1 overflow-x-auto border-b"
          aria-label="Books sections"
        >
          {tabs.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={cn(
                "flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-xs font-medium transition-colors",
                section === item.key
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              {item.count ? (
                <span className="rounded-full bg-foreground px-1.5 py-0.5 text-[9px] text-background">
                  {item.count}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>

        {section === "overview" && (
          <div className="space-y-5 py-5">
            <section className="grid gap-4 border bg-background p-5 sm:grid-cols-2 lg:grid-cols-4">
              <Metric
                label="Revenue · month"
                value={formatMoney(statements.profitLoss.revenueCents)}
                detail="Posted accrual journal"
              />
              <Metric
                label="Gross profit"
                value={formatMoney(statements.profitLoss.grossProfitCents)}
                detail={`${statements.profitLoss.revenueCents ? Math.round((statements.profitLoss.grossProfitCents / statements.profitLoss.revenueCents) * 100) : 0}% margin`}
              />
              <Metric
                label="Unmatched bank"
                value={String(workspace.unmatchedTransactions.length)}
                detail="Transactions awaiting proof"
              />
              <Metric
                label="Open drift"
                value={String(
                  workspace.reconciliations[0]?.discrepancy_count ?? 0,
                )}
                detail="Latest external comparison"
              />
            </section>
            <div className="grid gap-5 lg:grid-cols-[1.4fr_.8fr]">
              <section className="border bg-background">
                <div className="flex items-center justify-between border-b px-5 py-4">
                  <div>
                    <p className="text-sm font-semibold">Profit & loss</p>
                    <p className="text-xs text-muted-foreground">
                      Month to date · accrual
                    </p>
                  </div>
                  <Badge variant="outline">Official after close</Badge>
                </div>
                <div className="divide-y">
                  {statements.profitLoss.rows.slice(0, 12).map((row) => (
                    <div
                      key={row.accountId}
                      className="grid grid-cols-[70px_1fr_auto] gap-3 px-5 py-3 text-sm"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {row.code}
                      </span>
                      <span>{row.name}</span>
                      <span className="font-mono tabular-nums">
                        {formatMoney(row.balanceCents)}
                      </span>
                    </div>
                  ))}
                  {statements.profitLoss.rows.length === 0 && (
                    <p className="px-5 py-12 text-center text-sm text-muted-foreground">
                      Posted activity will appear here.
                    </p>
                  )}
                </div>
              </section>
              <section className="space-y-4">
                <div className="border bg-background p-5">
                  <p className="text-sm font-semibold">Integrity controls</p>
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span>Trial balance</span>
                      <Badge
                        variant="outline"
                        className={statusTone(
                          statements.trialBalance.totalDebitCents ===
                            statements.trialBalance.totalCreditCents
                            ? "passed"
                            : "failed",
                        )}
                      >
                        {statements.trialBalance.totalDebitCents ===
                        statements.trialBalance.totalCreditCents
                          ? "Balanced"
                          : "Out of balance"}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span>Balance sheet</span>
                      <Badge
                        variant="outline"
                        className={statusTone(
                          statements.balanceSheet.differenceCents === 0
                            ? "passed"
                            : "failed",
                        )}
                      >
                        {statements.balanceSheet.differenceCents === 0
                          ? "Balanced"
                          : formatMoney(
                              statements.balanceSheet.differenceCents,
                            )}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span>Latest rebuild</span>
                      <span className="text-xs text-muted-foreground">
                        Run on demand
                      </span>
                    </div>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <ResultButton
                      label="Verify rebuild"
                      run={runLedgerRebuildAction}
                    />
                    <ResultButton
                      label="Create full export"
                      run={() => createBooksExportAction("complete")}
                    />
                    <ResultButton
                      label="POC journal CSV"
                      run={async () => {
                        const result = await createPocJournalExportAction(
                          workspace.asOf,
                        );
                        if (result.success)
                          downloadTextFile(
                            result.data.filename,
                            result.data.csv,
                          );
                        return result;
                      }}
                    />
                  </div>
                </div>
                <div className="border bg-muted p-5 text-foreground">
                  <p className="font-mono text-[10px] uppercase tracking-[.18em] opacity-55">
                    Operating posture
                  </p>
                  <p className="mt-3 text-lg font-semibold">
                    {settings.ledger_authority === "external"
                      ? "Arc proves the books beside your provider."
                      : settings.external_sync_posture === "outbound_mirror"
                        ? "Arc is official; your provider receives a controlled mirror."
                        : "Arc is the complete ledger of record."}
                  </p>
                  <p className="mt-2 text-xs leading-5 opacity-65">
                    The provider integration boundary remains available to every
                    organization, regardless of this organization’s choice.
                  </p>
                </div>
              </section>
            </div>
          </div>
        )}

        {(section === "banking" || section === "transactions") && (
          <div className="space-y-5 py-5">
            {section === "banking" ? (
              <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Cash & cards</h2>
                <p className="text-sm text-muted-foreground">
                  Plaid feeds remain normalized and provider-neutral inside Arc.
                </p>
              </div>
              <Button
                onClick={connectPlaid}
                disabled={connecting || !plaidReady}
              >
                {connecting ? "Connecting…" : "Connect with Plaid"}
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {workspace.bankAccounts.map((account) => {
                const connection = Array.isArray(account.connection)
                  ? account.connection[0]
                  : account.connection;
                return (
                  <div key={account.id} className="border bg-background p-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-semibold">
                          {account.official_name || account.name}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {connection?.institution_name || "Connected account"}{" "}
                          · •••• {account.mask || "—"}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={statusTone(connection?.status ?? "active")}
                      >
                        {connection?.status ?? "active"}
                      </Badge>
                    </div>
                    <p className="mt-7 font-mono text-2xl tabular-nums">
                      {formatMoney(account.current_balance_cents)}
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      Feed balance ·{" "}
                      {account.balance_as_of?.slice(0, 10) ?? "pending"}
                    </p>
                    <Button asChild size="sm" variant="outline" className="mt-4 w-full">
                      <Link href={`/books/banking/${account.id}/reconcile`}>Open reconciliation</Link>
                    </Button>
                  </div>
                );
              })}
              {workspace.bankAccounts.length === 0 && (
                <div className="col-span-full border border-dashed bg-background px-6 py-12 text-center text-sm text-muted-foreground">
                  Connect the first bank or card account to begin cash
                  reconciliation.
                </div>
              )}
            </div>
            <BankReconciliationDesk workspace={workspace} />
              </>
            ) : null}
            {section === "transactions" ? (
            <section className="border bg-background">
              <div className="flex items-center justify-between border-b px-5 py-4">
                <div>
                  <p className="text-sm font-semibold">
                    Bank transaction register
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Match state, source description, direction, and amount from the normalized Plaid feed.
                  </p>
                </div>
                <Badge>{workspace.bankTransactions.length}</Badge>
              </div>
              <div className="divide-y">
                {workspace.bankTransactions
                  .slice(0, 100)
                  .map((transaction) => (
                    <div
                      key={transaction.id}
                      className="grid grid-cols-[100px_1fr_auto] items-center gap-4 px-5 py-3 text-sm xl:grid-cols-[100px_1fr_auto_auto]"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {transaction.transaction_date}
                      </span>
                      <div>
                        <p>
                          {transaction.merchant_name || transaction.description}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {transaction.direction} · {workspace.unmatchedTransactions.some((item) => item.id === transaction.id) ? "needs match" : "matched"}
                        </p>
                      </div>
                      <span className="font-mono tabular-nums">
                        {transaction.direction === "outflow" ? "−" : "+"}
                        {formatMoney(transaction.amount_cents)}
                      </span>
                      {workspace.unmatchedTransactions.some((item) => item.id === transaction.id) ? (
                      <div className="col-start-2 flex gap-2 xl:col-start-auto">
                        <ResultButton
                          label="Best match"
                          run={() =>
                            matchBestBankTransactionAction(
                              transaction.id,
                              Number(transaction.amount_cents),
                            )
                          }
                        />
                        <ResultButton
                          label="Exclude"
                          run={() =>
                            excludeBankTransactionAction(
                              transaction.id,
                              Number(transaction.amount_cents),
                            )
                          }
                        />
                      </div>
                      ) : <Badge variant="outline" className="col-start-2 xl:col-start-auto">Matched</Badge>}
                    </div>
                  ))}
                {workspace.bankTransactions.length === 0 && (
                  <p className="px-5 py-12 text-center text-sm text-muted-foreground">
                    Bank activity will appear here after the first Plaid sync.
                  </p>
                )}
              </div>
            </section>
            ) : null}
          </div>
        )}

        {(section === "ledger" || section === "chart") && (
          <div className={cn("grid gap-5 py-5", section === "ledger" && "xl:grid-cols-[1.35fr_.65fr]")}>
            <div className="space-y-5">
              {section === "ledger" ? (
              <section className="border bg-background">
                <div className="border-b px-5 py-4">
                  <p className="text-sm font-semibold">Recent journal</p>
                  <p className="text-xs text-muted-foreground">
                    Posted entries are immutable; corrections reverse and
                    repost.
                  </p>
                </div>
                <div className="divide-y">
                  {workspace.journals.map((entry) => (
                    <div
                      key={entry.id}
                      className="grid grid-cols-[95px_1fr_auto] gap-3 px-5 py-3 text-sm"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {entry.entry_date}
                      </span>
                      <div>
                        <p>{entry.memo}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {entry.posting_key}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={statusTone(entry.status)}
                      >
                        {entry.entry_kind}
                      </Badge>
                    </div>
                  ))}
                </div>
              </section>
              ) : null}
              {section === "chart" ? (
              <>
              <section className="border bg-background">
                <div className="border-b px-5 py-4">
                  <p className="text-sm font-semibold">Chart of accounts</p>
                  <p className="text-xs text-muted-foreground">
                    Construction-native defaults; system accounts cannot be
                    removed.
                  </p>
                </div>
                <div className="grid divide-y sm:grid-cols-2 sm:[&>*:nth-child(odd)]:border-r">
                  {workspace.accounts.map((account) => (
                    <div
                      key={account.id}
                      className="flex items-center gap-3 px-5 py-3"
                    >
                      <span className="w-12 font-mono text-xs text-muted-foreground">
                        {account.code}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{account.name}</p>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {account.account_type} ·{" "}
                          {account.subtype.replaceAll("_", " ")}
                        </p>
                      </div>
                      {!account.active ? <Badge variant="outline">Inactive</Badge> : null}
                      {account.is_system && (
                        <span
                          className="size-1.5 rounded-full bg-success"
                          title="System account"
                        />
                      )}
                      {!account.is_system ? (
                        <ResultButton
                          label={account.active ? "Deactivate" : "Activate"}
                          variant={account.active ? "outline" : "default"}
                          run={() => setGlAccountActiveAction(account.id, !account.active)}
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
                <section className="border bg-background p-5">
                  <p className="text-sm font-semibold">Add account</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">Extend the construction template without changing the protected control accounts.</p>
                  <form
                    className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                    action={async (formData) => {
                      const result = await createGlAccountAction(formData)
                      if (!result.success) toast.error(result.error)
                      else {
                        toast.success("Account created")
                        router.refresh()
                      }
                    }}
                  >
                    <Input name="code" required placeholder="Account code" />
                    <Input name="name" required placeholder="Account name" />
                    <select name="accountType" required className="flex h-9 border border-input bg-transparent px-3 text-sm">
                      <option value="">Account type</option>
                      <option value="asset">Asset</option><option value="liability">Liability</option><option value="equity">Equity</option><option value="income">Income</option><option value="cogs">Cost of goods sold</option><option value="expense">Expense</option>
                    </select>
                    <Input name="subtype" required placeholder="Subtype, e.g. equipment_rental" pattern="[a-z0-9_]+" />
                    <select name="normalBalance" required className="flex h-9 border border-input bg-transparent px-3 text-sm">
                      <option value="debit">Debit normal balance</option><option value="credit">Credit normal balance</option>
                    </select>
                    <select name="cashFlowCategory" className="flex h-9 border border-input bg-transparent px-3 text-sm">
                      <option value="">No cash-flow category</option><option value="operating">Operating</option><option value="investing">Investing</option><option value="financing">Financing</option><option value="cash">Cash</option>
                    </select>
                    <Button className="sm:col-span-2 lg:col-span-3">Create account</Button>
                  </form>
                </section>
              </>
              ) : null}
            </div>
            {section === "ledger" ? (
            <section className="h-fit border bg-background p-5">
              <p className="text-sm font-semibold">Post adjustment</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Paste balanced line JSON using account codes and integer cents.
                A reversing date is optional.
              </p>
              <form
                className="mt-5 space-y-3"
                action={async (formData) => {
                  const result = await createAdjustingJournalAction(formData);
                  if (!result.success) toast.error(result.error);
                  else {
                    toast.success("Adjustment posted");
                    router.refresh();
                  }
                }}
              >
                <Input
                  name="entryDate"
                  type="date"
                  required
                  defaultValue={workspace.asOf}
                />
                <Input name="memo" required placeholder="Adjustment memo" />
                <Input
                  name="reversingOn"
                  type="date"
                  aria-label="Optional reversing date"
                />
                <Textarea
                  name="lines"
                  rows={9}
                  required
                  defaultValue={
                    '[\n  {"accountCode":"6900","debitCents":10000,"creditCents":0,"description":"Adjustment"},\n  {"accountCode":"2000","debitCents":0,"creditCents":10000,"description":"Offset"}\n]'
                  }
                  className="font-mono text-xs"
                />
                <Button type="submit" className="w-full">
                  Post balanced journal
                </Button>
              </form>
            </section>
            ) : null}
          </div>
        )}

        {(section === "close" || section === "opening-balances") && (
          <div className={cn("grid gap-5 py-5", section === "close" && "xl:grid-cols-[1.25fr_.75fr]")}>
            {section === "close" ? (
            <section className="border bg-background">
              <div className="border-b px-5 py-4">
                <p className="text-sm font-semibold">Accounting periods</p>
                <p className="text-xs text-muted-foreground">
                  Bank, control-account, WIP, coding, tax, and drift checks gate
                  close.
                </p>
              </div>
              <div className="divide-y">
                {workspace.periods.map((period) => {
                  const checks = workspace.closeItems.filter(
                    (item) => item.period_id === period.id,
                  );
                  const failures = checks.filter(
                    (item) => item.status === "failed",
                  );
                  return (
                    <div key={period.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-medium">
                            FY {period.fiscal_year} · Period{" "}
                            {period.fiscal_period}
                          </p>
                          <p className="mt-1 font-mono text-xs text-muted-foreground">
                            {period.period_start} → {period.period_end}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={statusTone(period.status)}
                        >
                          {period.status}
                        </Badge>
                      </div>
                      {checks.length > 0 && (
                        <div className="mt-4 grid gap-2 sm:grid-cols-2">
                          {checks.map((check) => (
                            <div
                              key={check.id}
                              className="flex items-center justify-between border px-3 py-2 text-xs"
                            >
                              <span className="truncate pr-2">
                                {check.label}
                              </span>
                              <span
                                className={cn(
                                  "font-mono",
                                  check.status === "failed"
                                    ? "text-destructive"
                                    : check.status === "warning"
                                      ? "text-warning"
                                      : "text-success",
                                )}
                              >
                                {check.status}
                                {check.issue_count
                                  ? ` · ${check.issue_count}`
                                  : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button asChild size="sm" variant="ghost">
                          <Link href={`/books/close/${period.id}`}>Open period</Link>
                        </Button>
                        {period.status !== "closed" && (
                          <ResultButton
                            label="Run checklist"
                            run={() => runCloseChecklistAction(period.id)}
                          />
                        )}
                        {period.status === "closed" && (
                          <ResultButton
                            label="Reopen with audit trail"
                            run={() =>
                              reopenAccountingPeriodAction(
                                period.id,
                                "Period reopened by an authorized user for a documented correction",
                              )
                            }
                          />
                        )}
                        {period.fiscal_period >= 12 &&
                          period.status !== "closed" && (
                            <ResultButton
                              label="Post year-end close"
                              run={() => closeFiscalYearAction(period.id)}
                            />
                          )}
                        {period.status !== "closed" && (
                          <ResultButton
                            label="Close period"
                            variant="default"
                            run={() => closeAccountingPeriodAction(period.id)}
                          />
                        )}
                      </div>
                      {failures.length > 0 && (
                        <p className="mt-3 text-xs text-destructive">
                          {failures.length} blocking control
                          {failures.length === 1 ? "" : "s"} remain.
                        </p>
                      )}
                    </div>
                  );
                })}
                {workspace.periods.length === 0 && (
                  <p className="px-5 py-12 text-center text-sm text-muted-foreground">
                    Create the first organization accounting period.
                  </p>
                )}
              </div>
            </section>
            ) : null}
            <div className="space-y-5">
              {section === "close" ? (
              <section className="border bg-background p-5">
                <p className="text-sm font-semibold">New period</p>
                <form
                  action={async (formData) => {
                    const result = await createAccountingPeriodAction(formData);
                    if (!result.success) toast.error(result.error);
                    else {
                      toast.success("Accounting period created");
                      router.refresh();
                    }
                  }}
                  className="mt-4 grid grid-cols-2 gap-3"
                >
                  <Input name="periodStart" type="date" required />
                  <Input name="periodEnd" type="date" required />
                  <Input
                    name="fiscalYear"
                    inputMode="numeric"
                    placeholder="Fiscal year"
                    required
                  />
                  <Input
                    name="fiscalPeriod"
                    inputMode="numeric"
                    placeholder="Period 1–13"
                    required
                  />
                  <Button className="col-span-2">Create period</Button>
                </form>
              </section>
              ) : null}
              {section === "opening-balances" ? (
              <section className="border bg-background p-5">
                <p className="text-sm font-semibold">Opening balance batch</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Dry-run JSON import. The immutable batch must balance and
                  requires owner plus accountant approval before posting.
                </p>
                <form
                  className="mt-4 space-y-3"
                  action={async (formData) => {
                    const result = await importOpeningBalancesAction(formData);
                    if (!result.success) toast.error(result.error);
                    else {
                      toast.success("Opening batch validated");
                      router.refresh();
                    }
                  }}
                >
                  <Input name="cutoverDate" type="date" required />
                  <Input name="sourceFilename" placeholder="Source file name" />
                  <Textarea
                    name="sourceContent"
                    rows={8}
                    required
                    className="font-mono text-xs"
                    placeholder='[{"accountCode":"1000","subledgerType":"bank","sourceEntityType":"bank_account","sourceEntityId":"checking","description":"Cash","debitCents":100000,"creditCents":0},{"accountCode":"3000","description":"Equity","debitCents":0,"creditCents":100000}]'
                  />
                  <Button className="w-full">Validate batch</Button>
                </form>
              </section>
              ) : null}
              {section === "opening-balances" ? (
                <section className="border bg-background">
                  <div className="border-b px-5 py-4">
                    <p className="text-sm font-semibold">Validated opening batches</p>
                    <p className="text-xs text-muted-foreground">Owner and accountant approvals are independent before an immutable opening journal posts.</p>
                  </div>
                  <div className="divide-y">
                    {workspace.openingBatches.map((batch) => (
                      <div key={batch.id} className="px-5 py-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-sm">Opening at {batch.cutover_date}</p>
                            <p className="font-mono text-[10px] text-muted-foreground">{formatMoney(batch.debit_total_cents)} · {batch.digest?.slice(0, 12)}</p>
                          </div>
                          <Badge variant="outline" className={statusTone(batch.status)}>{batch.status}</Badge>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {new Set(["validated", "approved"]).has(batch.status) ? (
                            <>
                              <ResultButton label="Owner approve" run={() => approveOpeningBalancesAction(batch.id, "owner")} />
                              <ResultButton label="CPA approve" run={() => approveOpeningBalancesAction(batch.id, "accountant")} />
                            </>
                          ) : null}
                          {batch.status === "approved" ? <ResultButton label="Post opening" variant="default" run={() => postOpeningBalancesAction(batch.id)} /> : null}
                        </div>
                      </div>
                    ))}
                    {workspace.openingBatches.length === 0 ? <p className="px-5 py-10 text-center text-sm text-muted-foreground">No opening balance batches yet.</p> : null}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        )}

        {(section === "accountant" || section === "cutover") && (
          <div className={cn("grid gap-5 py-5", section === "cutover" && "xl:grid-cols-[1fr_1fr]")}>
            {section === "cutover" ? (
            <div className="xl:col-span-2">
              <ParallelCloseDesk workspace={workspace} />
            </div>
            ) : null}
            {section === "accountant" ? (
            <div className="space-y-5">
              <section className="border bg-background">
                <div className="flex items-center justify-between border-b px-5 py-4">
                  <div>
                    <p className="text-sm font-semibold">Portable books</p>
                    <p className="text-xs text-muted-foreground">
                      Machine-readable, balanced, redacted, and independently
                      verifiable.
                    </p>
                  </div>
                  <ResultButton
                    label="Create export"
                    run={() => createBooksExportAction("complete")}
                  />
                  <ResultButton
                    label="Accountant package"
                    run={() =>
                      createAccountantPackageAction({
                        taxYear: new Date().getUTCFullYear(),
                      })
                    }
                  />
                </div>
                <div className="divide-y">
                  {workspace.exports.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-4 px-5 py-3"
                    >
                      <div>
                        <p className="text-sm capitalize">
                          {item.export_type} package
                        </p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {item.requested_at?.slice(0, 16).replace("T", " ")} ·{" "}
                          {item.content_hash?.slice(0, 12) ?? "pending"}
                          {item.downloaded_at ? " · downloaded" : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={statusTone(item.status)}
                        >
                          {item.status}
                        </Badge>
                        {item.status === "ready" && (
                          <ResultButton
                            label="Download"
                            run={async () => {
                              const result = await getBooksExportDownloadAction(
                                item.id,
                              );
                              if (result.success)
                                window.open(
                                  result.data.url,
                                  "_blank",
                                  "noopener,noreferrer",
                                );
                              return result;
                            }}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              <section className="border bg-background">
                <div className="border-b px-5 py-4">
                  <p className="text-sm font-semibold">Accountant packages</p>
                  <p className="text-xs text-muted-foreground">Portable ledger, statements, control evidence, and year-end 1099 summary.</p>
                </div>
                <div className="divide-y">
                  {workspace.accountantPackages.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-4 px-5 py-3">
                      <div>
                        <p className="text-sm">{item.tax_year ? `Tax year ${item.tax_year}` : "Period package"}</p>
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{item.content_hash?.slice(0, 12) ?? "Generating"} · requested {item.requested_at?.slice(0, 10)}</p>
                      </div>
                      <Badge variant="outline" className={statusTone(item.status)}>{item.status}</Badge>
                    </div>
                  ))}
                  {workspace.accountantPackages.length === 0 ? <p className="px-5 py-10 text-center text-sm text-muted-foreground">No accountant packages yet.</p> : null}
                </div>
              </section>
              <section className="border bg-background p-5">
                <p className="text-sm font-semibold">Sales and use tax workpaper</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Summarizes taxable invoicing by jurisdiction for review. Filing treatment still belongs with the company’s tax professional.</p>
                <form
                  className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
                  action={async (formData) => {
                    const startDate = String(formData.get("startDate"))
                    const endDate = String(formData.get("endDate"))
                    const result = await buildSalesTaxSummaryAction(startDate, endDate)
                    if (!result.success) {
                      toast.error(result.error)
                      return
                    }
                    const lines = [
                      ["Jurisdiction", "Invoice count", "Taxable sales cents", "Tax cents"],
                      ...result.data.rows.map((row) => [row.jurisdiction, row.invoiceCount, row.taxableSalesCents, row.taxCents]),
                    ]
                    downloadTextFile(`sales-use-tax-${startDate}-${endDate}.csv`, lines.map((line) => line.map(csvCell).join(",")).join("\n"))
                    toast.success("Tax workpaper downloaded")
                  }}
                >
                  <Input name="startDate" type="date" required defaultValue={`${new Date().getUTCFullYear()}-01-01`} />
                  <Input name="endDate" type="date" required defaultValue={workspace.asOf} />
                  <Button>Download CSV</Button>
                </form>
              </section>
            </div>
            ) : null}
            {section === "cutover" ? (
            <div className="space-y-5">
              <section className="border bg-muted p-5 text-foreground">
                <p className="font-mono text-[10px] uppercase tracking-[.18em] opacity-55">
                  Ledger authority
                </p>
                <h2 className="mt-3 text-xl font-semibold">
                  {settings.ledger_authority === "arc"
                    ? "Arc is the official ledger."
                    : "Your external provider remains official."}
                </h2>
                <p className="mt-2 text-sm leading-6 opacity-70">
                  Cutover is optional, organization-scoped, dual-approved, and
                  blocked until three clean parallel closes, reconciled bank
                  accounts, posted opening balances, drained sync queues, and a
                  complete export are present.
                </p>
              </section>
              <section className="border bg-background p-5">
                <p className="text-sm font-semibold">
                  Prepare authority cutover
                </p>
                <form
                  action={async (formData) => {
                    const result = await prepareCutoverAction(formData);
                    if (!result.success) toast.error(result.error);
                    else {
                      toast.success(
                        result.data.status === "ready"
                          ? "Cutover ready for dual approval"
                          : `Cutover blocked: ${result.data.blockers.join(", ")}`,
                      );
                      router.refresh();
                    }
                  }}
                  className="mt-4 space-y-3"
                >
                  <select
                    name="connectionId"
                    required
                    className="flex h-9 w-full border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="">Select accounting connection</option>
                    {workspace.accountingConnections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.display_name || connection.provider}
                      </option>
                    ))}
                  </select>
                  <Input name="cutoverDate" type="date" required />
                  <select
                    name="targetPosture"
                    className="flex h-9 w-full border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="outbound_mirror">
                      Keep controlled outbound mirror
                    </option>
                    <option value="disconnected">
                      Arc only after grace period
                    </option>
                  </select>
                  <Button
                    className="w-full"
                    disabled={settings.ledger_authority === "arc"}
                  >
                    Evaluate prerequisites
                  </Button>
                </form>
              </section>
              <section className="border bg-background">
                <div className="border-b px-5 py-4">
                  <p className="text-sm font-semibold">Cutover record</p>
                </div>
                <div className="divide-y">
                  {workspace.cutovers.map((run) => (
                    <div key={run.id} className="px-5 py-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm">
                            {run.cutover_date} ·{" "}
                            {run.target_posture.replaceAll("_", " ")}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {Array.isArray(run.blockers) && run.blockers.length
                              ? `${run.blockers.length} blocker(s)`
                              : "Prerequisites captured"}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={statusTone(run.status)}
                        >
                          {run.status}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {run.status === "ready" && (
                          <>
                            <ResultButton
                              label="Owner approve"
                              run={() => approveCutoverAction(run.id, "owner")}
                            />
                            <ResultButton
                              label="CPA approve"
                              run={() =>
                                approveCutoverAction(run.id, "accountant")
                              }
                            />
                            <ResultButton
                              label="Complete cutover"
                              variant="default"
                              run={() => completeCutoverAction(run.id)}
                            />
                            <ResultButton
                              label="Cancel and unfreeze"
                              variant="destructive"
                              run={() => cancelCutoverAction(run.id)}
                            />
                          </>
                        )}
                        {new Set(["draft", "validating", "blocked"]).has(
                          run.status,
                        ) && (
                          <ResultButton
                            label="Cancel"
                            variant="destructive"
                            run={() => cancelCutoverAction(run.id)}
                          />
                        )}
                        {run.status === "completed" &&
                          run.rollback_deadline &&
                          new Date(run.rollback_deadline) > new Date() && (
                            <ResultButton
                              label="Rollback before first close"
                              variant="destructive"
                              run={() =>
                                rollbackCutoverAction(
                                  run.id,
                                  "Approved rollback during cutover grace window",
                                )
                              }
                            />
                          )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
