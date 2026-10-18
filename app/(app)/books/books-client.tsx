"use client";

import Script from "next/script";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";

import { BankingWorkspace } from "@/components/books/banking-workspace";
import { BankStatementDesk } from "@/components/books/bank-statement-desk";
import {
  reconnectBankingAccountAction,
  refreshBankingFeedsAction,
} from "@/app/(app)/books/banking-actions";
import { OpeningBalancesWizard } from "@/components/books/opening-balances-wizard";
import { ExternalAccountMapping } from "@/components/books/external-account-mapping";
import { GreenfieldLaunch } from "@/components/books/greenfield-launch";
import { AccountantHandoff } from "@/components/books/accountant-handoff";
import { TaxRegister } from "@/components/books/tax-register";
import { TaxWorkpapers } from "@/components/books/tax-workpapers";
import { Vendor1099Packages } from "@/components/books/vendor-1099-packages";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import {
  approveCutoverAction,
  approveBooksComparisonAction,
  approveOpeningBalancesAction,
  cancelCutoverAction,
  completeCutoverAction,
  createBooksComparisonAction,
  createBooksExportAction,
  createPlaidLinkTokenAction,
  exchangePlaidPublicTokenAction,
  explainBooksVarianceAction,
  getBooksExportDownloadAction,
  mapBankAccountAction,
  mirrorPeriodSummaryAction,
  postOpeningBalancesAction,
  prepareCutoverAction,
  promoteBooksToParallelAction,
  rollbackCutoverAction,
} from "./actions";

type Workspace = Awaited<
  ReturnType<typeof import("@/lib/services/books/workspace").getBooksWorkspace>
>;
export type BooksSection =
  | "banking"
  | "overhead"
  | "ledger"
  | "close"
  | "opening-balances"
  | "exports"
  | "taxes"
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
  reconciliationAccountId,
}: {
  workspace: Workspace;
  section: BooksSection;
  reconciliationAccountId?: string;
}) {
  const [plaidReady, setPlaidReady] = useState(false);
  const [connecting, startPlaid] = useTransition();
  const [reconnectingAccountId, setReconnectingAccountId] = useState<
    string | null
  >(null);
  const [mappingAccountId, setMappingAccountId] = useState<string | null>(null);
  const [mapping, startMapping] = useTransition();
  const router = useRouter();

  const { settings } = workspace;
  const settingsSection = section === "opening-balances" || section === "cutover";
  const hasHealthyBankConnection = workspace.bankAccounts.some((account) => {
    const connection = Array.isArray(account.connection)
      ? account.connection[0]
      : account.connection;
    return Boolean(connection) && connection.status === "active" && !connection.last_error;
  });
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

  const reconnectPlaid = async (bankAccountId: string) => {
    if (!plaidReady || !window.Plaid) {
      toast.error("Plaid Link is still loading");
      return;
    }
    setReconnectingAccountId(bankAccountId);
    try {
      const result = await reconnectBankingAccountAction(bankAccountId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      window.Plaid.create({
        token: result.data.linkToken,
        onSuccess: async () => {
          const synced = await refreshBankingFeedsAction();
          if (!synced.success) toast.error(synced.error);
          else if (synced.data.errors.length)
            toast.error(synced.data.errors.join("; "));
          else toast.success("Bank connection restored");
          router.refresh();
        },
        onExit: (error) => {
          if (error?.error_message) toast.error(error.error_message);
        },
      }).open();
    } finally {
      setReconnectingAccountId(null);
    }
  };

  if (section === "banking")
    return (
      <>
        {workspace.capabilities.reconcile && (
          <Script
            src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"
            strategy="afterInteractive"
            onReady={() => setPlaidReady(true)}
          />
        )}
        <BankingWorkspace
            workspace={workspace}
            reconciliationAccountId={reconciliationAccountId}
            management={
              <div className="space-y-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold tracking-tight">Cash & cards</h2>
                    <p className="text-xs text-muted-foreground">Connected accounts and ledger mapping.</p>
                  </div>
                  {workspace.capabilities.reconcile && !hasHealthyBankConnection && workspace.bankAccounts.length > 0 ? (
                    <Button size="sm" onClick={connectPlaid} disabled={connecting || !plaidReady}>
                      {connecting ? "Connecting…" : "Connect with Plaid"}
                    </Button>
                  ) : workspace.capabilities.reconcile && hasHealthyBankConnection ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" aria-label="More banking actions">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem disabled={connecting || !plaidReady} onSelect={connectPlaid}>Add bank connection</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                {workspace.bankAccounts.length ? (
                  <div className="divide-y border bg-background">
                    {workspace.bankAccounts.map((account) => {
                      const connection = Array.isArray(account.connection) ? account.connection[0] : account.connection;
                      const unhealthy = Boolean(connection) && (connection.status !== "active" || Boolean(connection.last_error));
                      const eligibleControlAccounts = workspace.accounts.filter((glAccount) => {
                        if (!glAccount.active) return false;
                        if (account.account_type === "credit") return glAccount.account_type === "liability" && glAccount.subtype === "credit_card";
                        if (account.account_type === "loan") return glAccount.account_type === "liability" && ["current_debt", "long_term_debt"].includes(glAccount.subtype);
                        return glAccount.account_type === "asset" && ["cash", "undeposited_funds", "other_asset"].includes(glAccount.subtype);
                      });
                      return (
                        <div key={account.id} className="space-y-3 px-4 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{account.official_name || account.name}</p>
                              <p className="truncate text-xs text-muted-foreground">{connection?.institution_name || (connection ? "Connected account" : "Manual")} · •••• {account.mask || "—"}{account.current_balance_cents != null ? ` · ${formatMoney(account.current_balance_cents)}` : ""}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <Badge variant="outline" className={statusTone(connection?.status ?? "active")}>{connection ? (unhealthy ? "Needs attention" : "Healthy") : "Manual"}</Badge>
                            </div>
                          </div>
                          {workspace.capabilities.reconcile ? (
                            <div className="flex items-center gap-2">
                              <Select value={account.gl_account_id ?? undefined} disabled={mapping && mappingAccountId === account.id} onValueChange={(glAccountId) => {
                                setMappingAccountId(account.id);
                                startMapping(async () => {
                                  const result = await mapBankAccountAction({ bankAccountId: account.id, glAccountId });
                                  setMappingAccountId(null);
                                  if (!result.success) { toast.error(result.error); return; }
                                  toast.success("Bank account mapped to the ledger");
                                  router.refresh();
                                });
                              }}>
                                <SelectTrigger id={`ledger-account-${account.id}`} aria-label="Ledger account" className="h-8 min-w-0 flex-1 text-xs"><SelectValue placeholder="Choose ledger account" /></SelectTrigger>
                                <SelectContent>{eligibleControlAccounts.map((glAccount) => <SelectItem key={glAccount.id} value={glAccount.id}>{glAccount.code} · {glAccount.name}</SelectItem>)}</SelectContent>
                              </Select>
                            </div>
                          ) : null}
                          {workspace.capabilities.reconcile && unhealthy ? (
                            <Button size="sm" variant="ghost" className="h-7 px-0 text-xs" disabled={reconnectingAccountId === account.id || !plaidReady} onClick={() => void reconnectPlaid(account.id)}>
                              {reconnectingAccountId === account.id ? "Reconnecting…" : "Reconnect connection"}
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed bg-background px-5 py-8 text-center">
                    <p className="text-sm font-medium">No bank accounts connected</p>
                    <p className="mt-1 text-xs text-muted-foreground">Connect a bank or card to bring cash activity into Books.</p>
                    {workspace.capabilities.reconcile ? <Button size="sm" className="mt-4" onClick={connectPlaid} disabled={connecting || !plaidReady}>{connecting ? "Connecting…" : "Connect with Plaid"}</Button> : null}
                  </div>
                )}
                <BankStatementDesk
                  bankAccounts={workspace.bankAccounts}
                  statements={workspace.bankReconciliations}
                  canReconcile={workspace.capabilities.reconcile}
                  initialAccountId={reconciliationAccountId}
                />
              </div>
          }
        />
      </>
    );

  return (
    <div className={cn("min-h-full", !settingsSection && "bg-muted/20")}>
      <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
        {section === "opening-balances" && (
          <div className="py-5">
            <div className="space-y-5">
              {section === "opening-balances" &&
              workspace.capabilities.manage ? (
                <OpeningBalancesWizard
                  accounts={workspace.accounts}
                  asOf={workspace.asOf}
                  companies={workspace.companies}
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

        {section === "taxes" && workspace.capabilities.tax ? (
          <div className="space-y-5 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Taxes & filing records</h2>
              <div className="flex gap-2">
                <Button asChild variant="outline" size="sm"><Link href="/reports?collection=tax">Tax reports</Link></Button>
                <Button asChild variant="outline" size="sm"><Link href="/settings/accounting/taxes">Tax settings</Link></Button>
              </div>
            </div>
            <TaxRegister mode="filings" />
            <Vendor1099Packages defaultYear={Number(workspace.asOf.slice(0, 4)) - 1} />
            <TaxWorkpapers canAdjust={workspace.capabilities.adjust} asOf={workspace.asOf} />
          </div>
        ) : null}

        {(section === "exports" || section === "cutover") && (
          <div
            className={cn(
              "grid gap-5 py-5",
              section === "cutover" && "xl:grid-cols-[1fr_1fr]",
            )}
          >
            {section === "cutover" && workspace.accountingConnections.length > 0 && settings.ledger_authority !== "arc" ? (
              <div className="xl:col-span-2">
                <ParallelCloseDesk workspace={workspace} />
              </div>
            ) : null}
            {section === "exports" ? (
              <div className="space-y-5">
                <AccountantHandoff asOf={workspace.asOf} canExport={workspace.capabilities.export} canTax={workspace.capabilities.tax} />
                <section className="border bg-background">
                  <div className="flex items-center justify-between border-b px-5 py-4">
                    <div>
                      <p className="text-sm font-semibold">Exports</p>
                      <p className="text-xs text-muted-foreground">
                        Download your ledger, supporting records, and accountant packages.
                      </p>
                    </div>
                    {workspace.capabilities.export ? (
                      <ResultButton
                        label="Create export"
                        run={() => createBooksExportAction("complete")}
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
                    {workspace.exports.length === 0 ? <p className="px-5 py-10 text-center text-sm text-muted-foreground">No exports yet. Create an export or prepare an accountant package above.</p> : null}
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
              </div>
            ) : null}
            {section === "cutover" ? (
              <div className="space-y-5">
                {workspace.capabilities.cutover &&
                workspace.accountingConnections.length === 0 &&
                settings.ledger_authority === "external" ? (
                  <GreenfieldLaunch />
                ) : null}
                {workspace.accountingConnections.length > 0 && (settings.ledger_authority !== "arc" || settings.external_sync_posture === "outbound_mirror") ? (
                  <ExternalAccountMapping connections={workspace.accountingConnections} />
                ) : null}
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
                    {settings.ledger_authority === "arc"
                      ? "Setup is complete. Your migration records and any available recovery actions remain below."
                      : workspace.accountingConnections.length === 0
                        ? "Complete your opening position, then use the new-books launch above to make Arc your official ledger."
                        : "Migration requires independent approvals, clean parallel closes, reconciled bank accounts, posted opening balances, drained sync queues, and a complete export."}
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
                {workspace.capabilities.cutover && settings.ledger_authority !== "arc" && workspace.accountingConnections.length > 0 ? (
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
                              : `Cutover blocked. ${result.data.remediation.join(" ")}`,
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
                    <p className="text-sm font-semibold">Migration history</p>
                  </div>
                  <div className="divide-y">
                    {workspace.cutovers.length === 0 ? <p className="px-5 py-6 text-sm text-muted-foreground">No migration records yet.</p> : null}
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
