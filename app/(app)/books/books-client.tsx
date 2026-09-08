"use client";

import { WarrantyAccounting } from "@/components/books/warranty-accounting";
import { InventoryWorkspace } from "@/components/books/inventory-workspace";
import { PayrollSettlement } from "@/components/books/payroll-settlement";
import { ClearingSupport } from "@/components/books/clearing-support";
import Script from "next/script";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { BankReviewTray } from "@/components/books/bank-review-tray";
import { BankTransactionRegister } from "@/components/books/bank-transaction-register";
import { BankReconciliationDetail } from "@/components/books/bank-reconciliation-detail";
import { DepositBatches } from "@/components/books/deposit-batches";
import { OverheadBudget } from "@/components/books/overhead-budget";
import {
  AccountActivitySheet,
  type ActivityTarget,
} from "@/components/books/account-activity-sheet";
import { BooksJournals } from "@/components/books/books-journals";
import { ManualBankImport } from "@/components/books/manual-bank-import";
import { OpeningBalancesWizard } from "@/components/books/opening-balances-wizard";
import { BooksStatements } from "@/components/books/books-statements";
import { FundingAccounts } from "@/components/books/funding-accounts";
import { ExternalAccountMapping } from "@/components/books/external-account-mapping";
import { CustomerDeposits } from "@/components/books/customer-deposits";
import { BooksRegisters } from "@/components/books/books-registers";
import { GreenfieldLaunch } from "@/components/books/greenfield-launch";
import { TaxRegister } from "@/components/books/tax-register";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  GL_ACCOUNT_SUBTYPES,
  GL_ACCOUNT_SUBTYPE_TYPES,
  normalBalanceForSubtype,
  type GlAccountSubtype,
  type GlAccountType,
} from "@/lib/services/books/types";

import {
  approveCutoverAction,
  approveBooksComparisonAction,
  approveOpeningBalancesAction,
  buildSalesTaxSummaryAction,
  cancelCutoverAction,
  closeAccountingPeriodAction,
  closeFiscalYearAction,
  completeCutoverAction,
  createAccountingPeriodAction,
  createAccountantPackageAction,
  createBankReconciliationAction,
  createBooksComparisonAction,
  createBooksExportAction,
  createGlAccountAction,
  createManualBankAccountAction,
  createPlaidLinkTokenAction,
  createPocJournalExportAction,
  exchangePlaidPublicTokenAction,
  excludeBankTransactionAction,
  explainBooksVarianceAction,
  getBooksExportDownloadAction,
  importBankStatementAction,
  mapBankAccountAction,
  mirrorPeriodSummaryAction,
  postOpeningBalancesAction,
  prepareCutoverAction,
  promoteBooksToParallelAction,
  reopenAccountingPeriodAction,
  resolveReconciliationItemAction,
  rollbackCutoverAction,
  runCloseChecklistAction,
  runReconciliationNowAction,
  runLedgerRebuildAction,
  setGlAccountActiveAction,
  updateGlAccountAction,
} from "./actions";

type Workspace = Awaited<
  ReturnType<typeof import("@/lib/services/books/workspace").getBooksWorkspace>
>;
export type BooksSection =
  | "overview"
  | "statements"
  | "banking"
  | "overhead"
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
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
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

function ReasonedAction({
  label,
  placeholder,
  run,
  variant = "outline",
}: {
  label: string;
  placeholder: string;
  run: (
    reason: string,
  ) => Promise<{ success: boolean; error?: string; data?: unknown }>;
  variant?: "outline" | "default" | "destructive";
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="flex min-w-[280px] flex-1 gap-2">
      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        minLength={10}
        placeholder={placeholder}
        aria-label={`${label} reason`}
      />
      <ResultButton label={label} variant={variant} run={() => run(reason)} />
    </div>
  );
}

type ReconciliationItemRow = {
  id: string;
  category: string;
  entity_type: string | null;
  entity_id: string | null;
  difference_cents: number | null;
  details: unknown;
  created_at: string;
};

/**
 * The unresolved findings behind the blocking `accounting_drift` close check.
 *
 * The nightly sweep resolves anything it can no longer reproduce, so everything
 * here is live. What it cannot judge is a difference somebody has decided to
 * accept — that needs a person and a reason, and it is recorded against them.
 */
function ReconciliationFindings({
  items,
  total,
  cap,
  canResolve,
}: {
  items: ReconciliationItemRow[];
  total: number;
  cap: number;
  canResolve: boolean;
}) {
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  return (
    <section className="border bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-semibold">Reconciliation findings</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Open findings block the close. Cure one and re-run reconciliation, or
          accept it as a known difference with a reason.
        </p>
      </div>
      <div className="divide-y">
        {items.map((item) => {
          const details =
            item.details && typeof item.details === "object"
              ? (item.details as {
                  href?: unknown;
                  description?: unknown;
                  cure?: unknown;
                })
              : null;
          const href = typeof details?.href === "string" ? details.href : null;
          const description =
            typeof details?.description === "string"
              ? details.description
              : typeof details?.cure === "string"
                ? details.cure
                : null;
          const explanation = explanations[item.id] ?? "";
          return (
            <div key={item.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-medium">
                    {item.category}
                  </p>
                  {description ? (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {description}
                    </p>
                  ) : null}
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {item.entity_type ?? "org"} · {item.created_at.slice(0, 10)}
                  </p>
                </div>
                {item.difference_cents !== null ? (
                  <span className="shrink-0 font-mono text-xs tabular-nums text-destructive">
                    {formatMoney(item.difference_cents)}
                  </span>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {href ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link href={href}>Open</Link>
                  </Button>
                ) : null}
                {canResolve ? (
                  <ResultButton
                    label="Mark cured"
                    run={() =>
                      resolveReconciliationItemAction({
                        itemId: item.id,
                        disposition: "resolved",
                      })
                    }
                  />
                ) : null}
                {canResolve ? (
                  <ResultButton
                    label="Accept difference"
                    run={() =>
                      resolveReconciliationItemAction({
                        itemId: item.id,
                        disposition: "explained",
                        explanation,
                      })
                    }
                  />
                ) : null}
              </div>
              {canResolve ? (
                <Textarea
                  className="mt-2 text-xs"
                  rows={2}
                  value={explanation}
                  placeholder="Why this difference is accepted (required to accept)"
                  onChange={(event) =>
                    setExplanations((current) => ({
                      ...current,
                      [item.id]: event.target.value,
                    }))
                  }
                />
              ) : null}
            </div>
          );
        })}
        {items.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            No open reconciliation findings.
          </p>
        )}
      </div>
      {total > cap && (
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">
          Showing the {cap} most recent of {total} open findings.
        </p>
      )}
    </section>
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
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function BankReconciliationDesk({
  workspace,
}: {
  workspace: Extract<Workspace, { initialized: true }>;
}) {
  const router = useRouter();
  const [selectedReconciliationId, setSelectedReconciliationId] = useState<string | null>(
    workspace.bankReconciliations.find((item) => item.status !== "closed")?.id ?? null,
  );
  return (
    <section className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
      <div className="border bg-background p-5">
        <p className="text-sm font-semibold">Start statement reconciliation</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter statement balances in dollars and cents. Close remains blocked
          until the difference is zero.
        </p>
        {workspace.capabilities.reconcile ? (
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
            <Select name="bankAccountId" required>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select bank account" />
              </SelectTrigger>
              <SelectContent>
                {workspace.bankAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.official_name || account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="grid grid-cols-2 gap-3">
              <Input name="statementStart" type="date" required />
              <Input name="statementEnd" type="date" required />
              <Input
                name="beginningBalance"
                inputMode="decimal"
                placeholder="Beginning balance (e.g. 12,345.67)"
                required
              />
              <Input
                name="endingBalance"
                inputMode="decimal"
                placeholder="Ending balance (e.g. 12,100.42)"
                required
              />
            </div>
            <Button className="w-full">Open reconciliation</Button>
          </form>
        ) : (
          <p className="mt-4 border border-dashed p-4 text-xs text-muted-foreground">
            You can review reconciliations, but your role cannot create or close
            them.
          </p>
        )}
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
                {item.status !== "closed" &&
                  workspace.capabilities.reconcile && (
                    <Button size="sm" variant="outline" onClick={() => setSelectedReconciliationId(item.id)}>
                      Review checklist
                    </Button>
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
      </div>
      {selectedReconciliationId ? (
        <BankReconciliationDetail reconciliationId={selectedReconciliationId} onClosed={() => router.refresh()} />
      ) : null}
    </section>
  );
}

function ParallelCloseDesk({
  workspace,
}: {
  workspace: Extract<Workspace, { initialized: true }>;
}) {
  const router = useRouter();
  const [approvalNotes, setApprovalNotes] = useState<Record<string, string>>(
    {},
  );
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
        {workspace.capabilities.reconcile ? (
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
            <Select name="connectionId" required>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Accounting provider" />
              </SelectTrigger>
              <SelectContent>
                {workspace.accountingConnections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.display_name || connection.provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select name="periodId" required>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Accounting period" />
              </SelectTrigger>
              <SelectContent>
                {workspace.periods.map((period) => (
                  <SelectItem key={period.id} value={period.id}>
                    FY {period.fiscal_year} · P{period.fiscal_period}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              name="asOf"
              type="date"
              required
              defaultValue={workspace.asOf}
            />
            <Textarea
              name="externalTrialBalance"
              rows={8}
              required
              className="font-mono text-xs"
              placeholder={
                "Paste rows from your provider, for example:\n1000 Cash\t12,345.67\t0.00\n2000 Accounts Payable\t0.00\t4,200.00"
              }
            />
            <Button className="w-full">Compare trial balance</Button>
          </form>
        ) : (
          <p className="border border-dashed p-4 text-xs text-muted-foreground">
            Your role can review parallel-close proof, but cannot import or
            approve it.
          </p>
        )}
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
              {workspace.capabilities.reconcile &&
                comparison.status !== "approved" &&
                comparison.unexplained_variance_count === 0 && (
                  <div className="mt-3 space-y-2">
                    <Input
                      value={approvalNotes[comparison.id] ?? ""}
                      minLength={10}
                      placeholder="Document who reviewed this comparison and the evidence used"
                      onChange={(event) =>
                        setApprovalNotes((current) => ({
                          ...current,
                          [comparison.id]: event.target.value,
                        }))
                      }
                    />
                    <ResultButton
                      label="Approve comparison"
                      run={() =>
                        approveBooksComparisonAction(
                          comparison.id,
                          approvalNotes[comparison.id] ?? "",
                        )
                      }
                    />
                  </div>
                )}
              {workspace.capabilities.reconcile
                ? comparison.items
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
                    ))
                : null}
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

export function BooksClient({
  workspace,
  section,
}: {
  workspace: Workspace;
  section: BooksSection;
}) {
  const [plaidReady, setPlaidReady] = useState(false);
  const [accountQuery, setAccountQuery] = useState("");
  const [newAccountType, setNewAccountType] = useState<GlAccountType>("asset");
  const [newAccountSubtype, setNewAccountSubtype] = useState<GlAccountSubtype>("cash");
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [accountActivityTarget, setAccountActivityTarget] = useState<ActivityTarget | null>(null);
  const [connecting, startPlaid] = useTransition();
  const [mappingAccountId, setMappingAccountId] = useState<string | null>(null);
  const [mapping, startMapping] = useTransition();
  const router = useRouter();

  const { settings, statements } = workspace;
  const filteredAccounts = workspace.accounts.filter((account) => {
    const query = accountQuery.trim().toLowerCase();
    return (
      !query ||
      `${account.code} ${account.name} ${account.subtype}`
        .toLowerCase()
        .includes(query)
    );
  });
  const availableSubtypes = GL_ACCOUNT_SUBTYPES.filter(
    (subtype) => GL_ACCOUNT_SUBTYPE_TYPES[subtype] === newAccountType,
  );
  const tabs: Array<{
    key: BooksSection;
    label: string;
    href: string;
    count?: number;
  }> = [
    { key: "overview", label: "Overview", href: "/books" },
    { key: "statements", label: "Statements", href: "/books/statements" },
    { key: "banking", label: "Banking", href: "/books/banking", count: workspace.unmatchedTransactions.length },
    { key: "overhead", label: "Overhead", href: "/books/overhead" },
    { key: "chart", label: "Chart", href: "/books/chart" },
    { key: "ledger", label: "Ledger", href: "/books/ledger" },
    {
      key: "close",
      label: "Close",
      href: "/books/close",
      count: workspace.closeItems.filter((item) => item.status === "failed")
        .length,
    },
    {
      key: "opening-balances",
      label: "Opening balances",
      href: "/books/opening-balances",
    },
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
    <div className="min-h-full bg-muted/20">
      {workspace.capabilities.reconcile && section === "banking" ? (
        <Script
          src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"
          strategy="afterInteractive"
          onLoad={() => setPlaidReady(true)}
        />
      ) : null}
      <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
        <header className="relative overflow-hidden border bg-primary text-primary-foreground">
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
            {statements ? (
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
            ) : (
              <div className="min-w-[290px] border-t border-white/15 pt-5 text-xs leading-5 text-white/60 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
                This workspace loads only the data needed for{" "}
                {tabs.find((tab) => tab.key === section)?.label.toLowerCase()}.
                Open Overview for current ledger metrics.
              </div>
            )}
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

        {section === "overview" && statements && (
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
                    {workspace.capabilities.adjust ? (
                      <ResultButton
                        label="Verify rebuild"
                        run={runLedgerRebuildAction}
                      />
                    ) : null}
                    {workspace.capabilities.export ? (
                      <ResultButton
                        label="Create full export"
                        run={() => createBooksExportAction("complete")}
                      />
                    ) : null}
                    {workspace.capabilities.export ? (
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
                    ) : null}
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
            {workspace.capabilities.adjust ? <CustomerDeposits /> : null}
            {workspace.capabilities.adjust ? <><InventoryWorkspace canManage={workspace.capabilities.manage} /><WarrantyAccounting /><BooksRegisters /></> : null}
            <section className="border bg-background p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">
                    Construction accounting
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Move from the ledger to WIP, committed cost, receivables,
                    payables, and vendor tax review.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href="/reports/wip-over-under">WIP schedule</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/projects">Project job costs</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/reports/ar-aging">AR aging</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/reports/ap-aging">AP aging</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/reports/vendor-1099">1099 review</Link>
                  </Button>
                </div>
              </div>
            </section>
          </div>
        )}

        {section === "statements" && (
          <div className="py-5">
            <BooksStatements />
          </div>
        )}

        {section === "banking" && (
          <div className="space-y-5 py-5">
            {workspace.capabilities.manage ? <FundingAccounts /> : null}
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Cash & cards</h2>
                    <p className="text-sm text-muted-foreground">
                      Plaid feeds remain normalized and provider-neutral inside
                      Arc.
                    </p>
                  </div>
                  {workspace.capabilities.reconcile ? (
                    <Button
                      onClick={connectPlaid}
                      disabled={connecting || !plaidReady}
                    >
                      {connecting ? "Connecting…" : "Connect with Plaid"}
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {workspace.bankAccounts.map((account) => {
                    const connection = Array.isArray(account.connection)
                      ? account.connection[0]
                      : account.connection;
                    const eligibleControlAccounts = workspace.accounts.filter(
                      (glAccount) => {
                        if (!glAccount.active) return false;
                        if (account.account_type === "credit") {
                          return (
                            glAccount.account_type === "liability" &&
                            glAccount.subtype === "credit_card"
                          );
                        }
                        if (account.account_type === "loan") {
                          return (
                            glAccount.account_type === "liability" &&
                            ["current_debt", "long_term_debt"].includes(
                              glAccount.subtype,
                            )
                          );
                        }
                        return (
                          glAccount.account_type === "asset" &&
                          ["cash", "undeposited_funds", "other_asset"].includes(
                            glAccount.subtype,
                          )
                        );
                      },
                    );
                    return (
                      <div
                        key={account.id}
                        className="border bg-background p-5"
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-semibold">
                              {account.official_name || account.name}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {connection?.institution_name ||
                                "Connected account"}{" "}
                              · •••• {account.mask || "—"}
                            </p>
                          </div>
                          <Badge
                            variant="outline"
                            className={statusTone(
                              connection?.status ?? "active",
                            )}
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
                        {workspace.capabilities.reconcile ? (
                          <div className="mt-4 border-t pt-4">
                            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              Ledger control account
                            </label>
                            <Select
                              value={account.gl_account_id ?? undefined}
                              disabled={mapping && mappingAccountId === account.id}
                              onValueChange={(glAccountId) => {
                                setMappingAccountId(account.id);
                                startMapping(async () => {
                                  const result = await mapBankAccountAction({
                                    bankAccountId: account.id,
                                    glAccountId,
                                  });
                                  setMappingAccountId(null);
                                  if (!result.success) {
                                    toast.error(result.error);
                                    return;
                                  }
                                  toast.success("Bank account mapped to the ledger");
                                  router.refresh();
                                });
                              }}
                            >
                              <SelectTrigger className="mt-1 w-full">
                                <SelectValue placeholder="Map before reconciling" />
                              </SelectTrigger>
                              <SelectContent>
                                {eligibleControlAccounts.map((glAccount) => (
                                  <SelectItem key={glAccount.id} value={glAccount.id}>
                                    {glAccount.code} · {glAccount.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ) : null}
                        {workspace.capabilities.reconcile ? (
                          account.gl_account_id ? (
                            <Button
                              asChild
                              size="sm"
                              variant="outline"
                              className="mt-4 w-full"
                            >
                              <Link href={`/books/banking/${account.id}/reconcile`}>
                                Open reconciliation
                              </Link>
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" className="mt-4 w-full" disabled>
                              Map account to reconcile
                            </Button>
                          )
                        ) : null}
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
                {workspace.capabilities.reconcile ? <DepositBatches /> : null}
                {workspace.capabilities.adjust && <PayrollSettlement />}
                {workspace.capabilities.reconcile ? (
                  <BankReviewTray accounts={workspace.accounts} />
                ) : (
                  <p className="border border-dashed bg-background p-5 text-sm text-muted-foreground">
                    Your role can inspect the bank register, but cannot match or categorize transactions.
                  </p>
                )}
                <BankTransactionRegister
                  transactions={workspace.bankTransactions}
                  unmatchedIds={workspace.unmatchedTransactions.map((transaction) => transaction.id)}
                  accounts={workspace.bankAccounts}
                  sourceTruncated={workspace.bankTransactionsTruncated}
                />
                {workspace.capabilities.reconcile ? (
                  <ManualBankImport
                    accounts={workspace.accounts}
                    bankAccounts={workspace.bankAccounts}
                    onChanged={() => router.refresh()}
                  />
                ) : null}
              </>
          </div>
        )}

        {section === "ledger" && (
          <div className="py-5">
            <BooksJournals
              accounts={workspace.accounts}
              asOf={workspace.asOf}
            />
          </div>
        )}

        {section === "overhead" && (
          <div className="py-5"><OverheadBudget canEdit={workspace.capabilities.adjust} /></div>
        )}

        {section === "chart" && (
          <div className="grid gap-5 py-5">
            <div className="space-y-5">
              {section === "chart" ? (
                <>
                  <section className="border bg-background">
                    <div className="border-b px-5 py-4">
                      <div className="flex flex-wrap items-end justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">
                            Chart of accounts
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Construction-native defaults; system accounts cannot
                            be removed.
                          </p>
                        </div>
                        <Input
                          value={accountQuery}
                          onChange={(event) =>
                            setAccountQuery(event.target.value)
                          }
                          placeholder="Search code, name, or subtype"
                          className="w-full sm:w-72"
                          aria-label="Search chart of accounts"
                        />
                      </div>
                    </div>
                    <div className="grid divide-y sm:grid-cols-2 sm:[&>*:nth-child(odd)]:border-r">
                      {filteredAccounts.map((account) => (
                        <div
                          key={account.id}
                          className="flex items-center gap-3 px-5 py-3"
                        >
                          <span className="w-12 font-mono text-xs text-muted-foreground">
                            {account.code}
                          </span>
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => setAccountActivityTarget({ accountId: account.id, code: account.code, name: account.name })}
                              className="truncate text-left text-sm underline-offset-4 hover:underline"
                            >
                              {account.name}
                            </button>
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              {account.account_type} ·{" "}
                              {account.subtype.replaceAll("_", " ")}
                            </p>
                          </div>
                          {!account.active ? (
                            <Badge variant="outline">Inactive</Badge>
                          ) : null}
                          {account.is_system && (
                            <span
                              className="size-1.5 rounded-full bg-success"
                              title="System account"
                            />
                          )}
                          {!account.is_system && workspace.capabilities.manage ? (
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingAccountId(account.id)}
                              >
                                Edit
                              </Button>
                              <ResultButton
                                label={account.active ? "Deactivate" : "Activate"}
                                variant={account.active ? "outline" : "default"}
                                run={() =>
                                  setGlAccountActiveAction(
                                    account.id,
                                    !account.active,
                                  )
                                }
                              />
                            </div>
                          ) : null}
                        </div>
                      ))}
                      {filteredAccounts.length === 0 ? (
                        <p className="col-span-full px-5 py-10 text-center text-sm text-muted-foreground">
                          No accounts match this search.
                        </p>
                      ) : null}
                    </div>
                    {editingAccountId ? (() => {
                      const account = workspace.accounts.find((item) => item.id === editingAccountId);
                      if (!account || account.is_system) return null;
                      return (
                        <form
                          className="grid gap-3 border-t bg-muted/20 p-5 sm:grid-cols-2"
                          action={async (formData) => {
                            const result = await updateGlAccountAction(formData);
                            if (!result.success) toast.error(result.error);
                            else {
                              toast.success("Account updated");
                              setEditingAccountId(null);
                              router.refresh();
                            }
                          }}
                        >
                          <input type="hidden" name="accountId" value={account.id} />
                          <div>
                            <p className="text-xs font-semibold">Edit {account.code}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Codes, types, and normal balances are locked after creation to preserve posting rules.
                            </p>
                          </div>
                          <Input name="name" required defaultValue={account.name} aria-label="Account name" />
                          <Input name="description" defaultValue={account.description ?? ""} placeholder="Description or usage guidance" />
                          <Select name="cashFlowCategory" defaultValue={account.cash_flow_category ?? undefined}>
                            <SelectTrigger><SelectValue placeholder="No cash-flow category" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="operating">Operating</SelectItem>
                              <SelectItem value="investing">Investing</SelectItem>
                              <SelectItem value="financing">Financing</SelectItem>
                              <SelectItem value="cash">Cash</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="flex justify-end gap-2 sm:col-span-2">
                            <Button type="button" variant="ghost" onClick={() => setEditingAccountId(null)}>Cancel</Button>
                            <Button>Save account</Button>
                          </div>
                        </form>
                      );
                    })() : null}
                  </section>
                  {workspace.capabilities.manage ? (
                    <section className="border bg-background p-5">
                      <p className="text-sm font-semibold">Add account</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Extend the construction template without changing the
                        protected control accounts.
                      </p>
                      <form
                        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                        action={async (formData) => {
                          const result = await createGlAccountAction(formData);
                          if (!result.success) toast.error(result.error);
                          else {
                            toast.success("Account created");
                            router.refresh();
                          }
                        }}
                      >
                        <Input
                          name="code"
                          required
                          placeholder="Account code"
                        />
                        <Input
                          name="name"
                          required
                          placeholder="Account name"
                        />
                        <Select
                          name="accountType"
                          required
                          value={newAccountType}
                          onValueChange={(value: GlAccountType) => {
                            setNewAccountType(value);
                            setNewAccountSubtype(
                              GL_ACCOUNT_SUBTYPES.find((subtype) => GL_ACCOUNT_SUBTYPE_TYPES[subtype] === value)!,
                            );
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Account type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="asset">Asset</SelectItem>
                            <SelectItem value="liability">Liability</SelectItem>
                            <SelectItem value="equity">Equity</SelectItem>
                            <SelectItem value="income">Income</SelectItem>
                            <SelectItem value="cogs">
                              Cost of goods sold
                            </SelectItem>
                            <SelectItem value="expense">Expense</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select name="subtype" required value={newAccountSubtype} onValueChange={(value: GlAccountSubtype) => setNewAccountSubtype(value)}>
                          <SelectTrigger className="w-full"><SelectValue placeholder="Account subtype" /></SelectTrigger>
                          <SelectContent>
                            {availableSubtypes.map((subtype) => (
                              <SelectItem key={subtype} value={subtype}>{subtype.replaceAll("_", " ")}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <input type="hidden" name="normalBalance" value={normalBalanceForSubtype(newAccountSubtype)} />
                        <Select name="cashFlowCategory">
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="No cash-flow category" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="operating">Operating</SelectItem>
                            <SelectItem value="investing">Investing</SelectItem>
                            <SelectItem value="financing">Financing</SelectItem>
                            <SelectItem value="cash">Cash</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button className="sm:col-span-2 lg:col-span-3">
                          Create account
                        </Button>
                      </form>
                    </section>
                  ) : null}
                </>
              ) : null}
            </div>
            <AccountActivitySheet
              target={accountActivityTarget}
              startDate={`${workspace.asOf.slice(0, 4)}-01-01`}
              endDate={workspace.asOf}
              onOpenChange={(open) => { if (!open) setAccountActivityTarget(null); }}
            />
          </div>
        )}

        {(section === "close" || section === "opening-balances") && (
          <div
            className={cn(
              "grid gap-5 py-5",
              section === "close" && "xl:grid-cols-[1.25fr_.75fr]",
            )}
          >
            {section === "close" ? (
              <section className="border bg-background">
                <div className="border-b px-5 py-4">
                  <p className="text-sm font-semibold">Accounting periods</p>
                  <p className="text-xs text-muted-foreground">
                    Bank, control-account, WIP, coding, tax, and drift checks
                    gate close.
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
                            {checks.map((check) => {
                              // A failing row is only useful if it says where to
                              // cure it; the evidence ids were already collected
                              // and then rendered as plain text.
                              const href =
                                check.status !== "passed" &&
                                typeof (
                                  check.evidence as { href?: unknown } | null
                                )?.href === "string"
                                  ? (check.evidence as { href: string }).href
                                  : null;
                              const body = (
                                <>
                                  <span className="truncate pr-2">
                                    {check.label}
                                  </span>
                                  <span
                                    className={cn(
                                      "shrink-0 font-mono",
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
                                </>
                              );
                              return href ? (
                                <Link
                                  key={check.id}
                                  href={href}
                                  className="flex items-center justify-between border px-3 py-2 text-xs transition-colors hover:bg-accent"
                                >
                                  {body}
                                </Link>
                              ) : (
                                <div
                                  key={check.id}
                                  className="flex items-center justify-between border px-3 py-2 text-xs"
                                >
                                  {body}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div className="mt-4 flex flex-wrap gap-2">
                          {period.status !== "closed" && workspace.capabilities.close && <ClearingSupport periodId={period.id} />}
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/books/close/${period.id}`}>
                              Open period
                            </Link>
                          </Button>
                          {period.status !== "closed" &&
                            workspace.capabilities.close && (
                              <ResultButton
                                label="Run checklist"
                                run={() => runCloseChecklistAction(period.id)}
                              />
                            )}
                          {period.status !== "closed" &&
                            workspace.capabilities.close && (
                              // Curing a discrepancy should not mean waiting for the
                              // 04:45 UTC sweep to see the checklist go green.
                              <ResultButton
                                label="Re-run reconciliation"
                                run={() => runReconciliationNowAction()}
                              />
                            )}
                          {period.status === "closed" &&
                            workspace.capabilities.reopen && (
                              <ReasonedAction
                                label="Reopen"
                                placeholder="Correction and supporting evidence"
                                run={(reason) =>
                                  reopenAccountingPeriodAction(
                                    period.id,
                                    reason,
                                  )
                                }
                              />
                            )}
                          {period.fiscal_period >= 12 &&
                            period.status !== "closed" &&
                            workspace.capabilities.close && (
                              <ResultButton
                                label="Post year-end close"
                                run={() => closeFiscalYearAction(period.id)}
                              />
                            )}
                          {period.status !== "closed" &&
                            workspace.capabilities.close && (
                              <ResultButton
                                label="Close period"
                                variant="default"
                                run={() =>
                                  closeAccountingPeriodAction(period.id)
                                }
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
              {section === "close" && workspace.capabilities.manage ? (
                <section className="border bg-background p-5">
                  <p className="text-sm font-semibold">New period</p>
                  <form
                    action={async (formData) => {
                      const result =
                        await createAccountingPeriodAction(formData);
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
              {section === "close" ? (
                <ReconciliationFindings
                  items={workspace.reconciliationItems}
                  total={workspace.reconciliationItemTotal}
                  cap={workspace.reconciliationItemCap}
                  canResolve={workspace.capabilities.reconcile}
                />
              ) : null}
              {section === "opening-balances" &&
              workspace.capabilities.manage ? (
                <OpeningBalancesWizard
                  accounts={workspace.accounts}
                  asOf={workspace.asOf}
                />
              ) : null}
              {section === "opening-balances" ? (
                <section className="border bg-background">
                  <div className="border-b px-5 py-4">
                    <p className="text-sm font-semibold">
                      Validated opening batches
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Owner and accountant approvals are independent before an
                      immutable opening journal posts.
                    </p>
                  </div>
                  <div className="divide-y">
                    {workspace.openingBatches.map((batch) => (
                      <div key={batch.id} className="px-5 py-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-sm">
                              Opening at {batch.cutover_date}
                            </p>
                            <p className="font-mono text-[10px] text-muted-foreground">
                              {formatMoney(batch.debit_total_cents)} ·{" "}
                              {batch.digest?.slice(0, 12)}
                            </p>
                          </div>
                          <Badge
                            variant="outline"
                            className={statusTone(batch.status)}
                          >
                            {batch.status}
                          </Badge>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {workspace.capabilities.manage &&
                          new Set(["validated", "approved"]).has(
                            batch.status,
                          ) ? (
                            <>
                              <ResultButton
                                label="Owner approve"
                                run={() =>
                                  approveOpeningBalancesAction(
                                    batch.id,
                                    "owner",
                                  )
                                }
                              />
                              <ResultButton
                                label="CPA approve"
                                run={() =>
                                  approveOpeningBalancesAction(
                                    batch.id,
                                    "accountant",
                                  )
                                }
                              />
                            </>
                          ) : null}
                          {workspace.capabilities.manage &&
                          batch.status === "approved" ? (
                            <ResultButton
                              label="Post opening"
                              variant="default"
                              run={() => postOpeningBalancesAction(batch.id)}
                            />
                          ) : null}
                        </div>
                      </div>
                    ))}
                    {workspace.openingBatches.length === 0 ? (
                      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                        No opening balance batches yet.
                      </p>
                    ) : null}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        )}

        {(section === "accountant" || section === "cutover") && (
          <div
            className={cn(
              "grid gap-5 py-5",
              section === "cutover" && "xl:grid-cols-[1fr_1fr]",
            )}
          >
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
                    {workspace.capabilities.export ? (
                      <ResultButton
                        label="Create export"
                        run={() => createBooksExportAction("complete")}
                      />
                    ) : null}
                    {workspace.capabilities.export ? (
                      <ResultButton
                        label="Accountant package"
                        run={() =>
                          createAccountantPackageAction({
                            taxYear: new Date().getUTCFullYear(),
                          })
                        }
                      />
                    ) : null}
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
                            {item.requested_at?.slice(0, 16).replace("T", " ")}{" "}
                            · {item.content_hash?.slice(0, 12) ?? "pending"}
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
                          {item.status === "ready" &&
                            workspace.capabilities.export && (
                              <ResultButton
                                label="Download"
                                run={async () => {
                                  const result =
                                    await getBooksExportDownloadAction(item.id);
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
                    <p className="text-xs text-muted-foreground">
                      Portable ledger, statements, control evidence, and
                      year-end 1099 summary.
                    </p>
                  </div>
                  <div className="divide-y">
                    {workspace.accountantPackages.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between gap-4 px-5 py-3"
                      >
                        <div>
                          <p className="text-sm">
                            {item.tax_year
                              ? `Tax year ${item.tax_year}`
                              : "Period package"}
                          </p>
                          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                            {item.content_hash?.slice(0, 12) ?? "Generating"} ·
                            requested {item.requested_at?.slice(0, 10)}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={statusTone(item.status)}
                        >
                          {item.status}
                        </Badge>
                      </div>
                    ))}
                    {workspace.accountantPackages.length === 0 ? (
                      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                        No accountant packages yet.
                      </p>
                    ) : null}
                  </div>
                </section>
                {workspace.capabilities.tax ? (
                  <TaxRegister />
                ) : null}
                {workspace.capabilities.tax ? (
                  <section className="border bg-background p-5">
                    <p className="text-sm font-semibold">
                      Sales and use tax workpaper
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Summarizes taxable invoicing by jurisdiction for review.
                      Filing treatment still belongs with the company’s tax
                      professional.
                    </p>
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="mt-3"
                    >
                      <Link href="/reports/vendor-1099">
                        Review 1099 vendors and missing W-9s
                      </Link>
                    </Button>
                    <form
                      className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
                      action={async (formData) => {
                        const startDate = String(formData.get("startDate"));
                        const endDate = String(formData.get("endDate"));
                        const result = await buildSalesTaxSummaryAction(
                          startDate,
                          endDate,
                        );
                        if (!result.success) {
                          toast.error(result.error);
                          return;
                        }
                        const lines = [
                          ["WARNING", result.data.warning],
                          ...result.data.limitations.map((limitation) => [
                            "LIMITATION",
                            limitation,
                          ]),
                          [],
                          [
                            "Jurisdiction",
                            "Invoice count",
                            "Taxable sales cents",
                            "Exempt sales cents",
                            "Unclassified sales cents",
                            "Adjustment count",
                            "Tax cents",
                            "Use tax cents",
                          ],
                          ...result.data.rows.map((row) => [
                            row.jurisdiction,
                            row.invoiceCount,
                            row.taxableSalesCents,
                            row.exemptSalesCents,
                            row.unclassifiedSalesCents,
                            row.adjustmentCount,
                            row.taxCents,
                            row.useTaxCents,
                          ]),
                        ];
                        downloadTextFile(
                          `sales-use-tax-${startDate}-${endDate}.csv`,
                          lines
                            .map((line) => line.map(csvCell).join(","))
                            .join("\n"),
                        );
                        toast.warning(result.data.warning, {
                          description: result.data.limitations.join(" "),
                          duration: 12000,
                        });
                      }}
                    >
                      <Input
                        name="startDate"
                        type="date"
                        required
                        defaultValue={`${new Date().getUTCFullYear()}-01-01`}
                      />
                      <Input
                        name="endDate"
                        type="date"
                        required
                        defaultValue={workspace.asOf}
                      />
                      <Button>Download CSV</Button>
                    </form>
                  </section>
                ) : null}
              </div>
            ) : null}
            {section === "cutover" ? (
              <div className="space-y-5">
                {workspace.capabilities.cutover && workspace.accountingConnections.length === 0 && settings.ledger_authority === "external" ? <GreenfieldLaunch /> : null}
                <ExternalAccountMapping connections={workspace.accountingConnections} />
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
                    accounts, posted opening balances, drained sync queues, and
                    a complete export are present.
                  </p>
                </section>
                {settings.ledger_authority === "external" &&
                settings.arc_ledger_mode === "shadow" ? (
                  <section className="border bg-background p-5">
                    <p className="text-sm font-semibold">
                      Enter parallel close
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Promotion requires an active provider, a passing rebuild,
                      zero open reconciliation drift, and a named review
                      attestation.
                    </p>
                    {workspace.capabilities.cutover ? (
                      <form
                        className="mt-4 space-y-3"
                        action={async (formData) => {
                          const result = await promoteBooksToParallelAction(
                            String(formData.get("attestation") ?? ""),
                          );
                          if (!result.success) toast.error(result.error);
                          else {
                            toast.success("Parallel close started");
                            router.refresh();
                          }
                        }}
                      >
                        <Textarea
                          name="attestation"
                          required
                          minLength={20}
                          rows={3}
                          placeholder="Who reviewed the rebuild and reconciliation evidence, when, and what was approved?"
                        />
                        <Button className="w-full">Start parallel close</Button>
                      </form>
                    ) : (
                      <p className="mt-4 text-xs text-muted-foreground">
                        Only a Books cutover operator can change the ledger
                        posture.
                      </p>
                    )}
                  </section>
                ) : null}
                {workspace.capabilities.cutover ? (
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
                      <Select name="connectionId" required>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select accounting connection" />
                        </SelectTrigger>
                        <SelectContent>
                          {workspace.accountingConnections.map((connection) => (
                            <SelectItem
                              key={connection.id}
                              value={connection.id}
                            >
                              {connection.display_name || connection.provider}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input name="cutoverDate" type="date" required />
                      <Select
                        name="targetPosture"
                        defaultValue="outbound_mirror"
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="outbound_mirror">
                            Keep controlled outbound mirror
                          </SelectItem>
                          <SelectItem value="disconnected">
                            Arc only after grace period
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        className="w-full"
                        disabled={settings.ledger_authority === "arc"}
                      >
                        Evaluate prerequisites
                      </Button>
                    </form>
                  </section>
                ) : null}
                {settings.ledger_authority === "arc" &&
                settings.external_sync_posture === "outbound_mirror" ? (
                  <section className="border bg-background">
                    <div className="border-b px-5 py-4">
                      <p className="text-sm font-semibold">
                        Closed-period mirror
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Publish one balanced summary journal per closed period.
                        Retries are idempotent.
                      </p>
                    </div>
                    <div className="divide-y">
                      {workspace.periods
                        .filter((period) => period.status === "closed")
                        .map((period) => (
                          <div
                            key={period.id}
                            className="flex items-center justify-between gap-3 px-5 py-3"
                          >
                            <span className="text-sm">
                              FY {period.fiscal_year} · P{period.fiscal_period}
                            </span>
                            {workspace.capabilities.adjust &&
                            workspace.accountingConnections[0] ? (
                              <ResultButton
                                label="Mirror summary"
                                run={() =>
                                  mirrorPeriodSummaryAction(
                                    period.id,
                                    workspace.accountingConnections[0].id,
                                  )
                                }
                              />
                            ) : null}
                          </div>
                        ))}
                      {workspace.periods.every(
                        (period) => period.status !== "closed",
                      ) ? (
                        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                          Close a period before mirroring it.
                        </p>
                      ) : null}
                    </div>
                  </section>
                ) : null}
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
                              {Array.isArray(run.blockers) &&
                              run.blockers.length
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
                          {workspace.capabilities.cutover &&
                            run.status === "ready" && (
                              <>
                                <ResultButton
                                  label="Owner approve"
                                  run={() =>
                                    approveCutoverAction(run.id, "owner")
                                  }
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
                          {workspace.capabilities.cutover &&
                            new Set(["draft", "validating", "blocked"]).has(
                              run.status,
                            ) && (
                              <ResultButton
                                label="Cancel"
                                variant="destructive"
                                run={() => cancelCutoverAction(run.id)}
                              />
                            )}
                          {workspace.capabilities.cutover &&
                            run.status === "completed" &&
                            run.rollback_deadline &&
                            new Date(run.rollback_deadline) > new Date() && (
                              <ReasonedAction
                                label="Rollback"
                                placeholder="Why authority must return to the provider"
                                variant="destructive"
                                run={(reason) =>
                                  rollbackCutoverAction(run.id, reason)
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
