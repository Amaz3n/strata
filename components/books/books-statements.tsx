"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { loadStatementsAction } from "@/app/(app)/books/actions";
import {
  AccountActivitySheet,
  type ActivityTarget,
} from "@/components/books/account-activity-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { StatementsForPeriod } from "@/lib/services/books/statement-detail";
import type { StatementAccountRow } from "@/lib/services/books/statements";
import { cn, formatMoneyCentsExact } from "@/lib/utils";

/**
 * Statements as a workspace surface.
 *
 * The five statements computed correctly long before this existed, but only as
 * `/reports` catalog entries — you could run one and read a number, and there was
 * nowhere to ask what the number was made of. Everything here exists to answer
 * that: every account row opens its register, and the P&L carries the project
 * dimension that `accountRows` drops.
 *
 * Data is fetched on demand rather than added to `getBooksWorkspace`, which every
 * other Books section already pays for on every page view.
 */

type StatementKey =
  | "profit_loss"
  | "cash_basis"
  | "balance_sheet"
  | "trial_balance"
  | "cash_flow";

const STATEMENTS: Array<{ key: StatementKey; label: string }> = [
  { key: "profit_loss", label: "Profit & loss" },
  { key: "cash_basis", label: "Cash basis" },
  { key: "balance_sheet", label: "Balance sheet" },
  { key: "trial_balance", label: "Trial balance" },
  { key: "cash_flow", label: "Cash flow" },
];

function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** Periods are computed in UTC to match `entry_date`, which is a bare date. */
function periodRange(key: string): {
  startDate: string;
  endDate: string;
  label: string;
} {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = iso(now);
  switch (key) {
    case "last_month": {
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0));
      return { startDate: iso(start), endDate: iso(end), label: "Last month" };
    }
    case "quarter": {
      const start = new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1));
      return {
        startDate: iso(start),
        endDate: today,
        label: "Quarter to date",
      };
    }
    case "year":
      return {
        startDate: iso(new Date(Date.UTC(year, 0, 1))),
        endDate: today,
        label: "Year to date",
      };
    case "last_year":
      return {
        startDate: iso(new Date(Date.UTC(year - 1, 0, 1))),
        endDate: iso(new Date(Date.UTC(year - 1, 11, 31))),
        label: "Last year",
      };
    default:
      return {
        startDate: iso(new Date(Date.UTC(year, month, 1))),
        endDate: today,
        label: "This month",
      };
  }
}

const PERIOD_KEYS = [
  "month",
  "last_month",
  "quarter",
  "year",
  "last_year",
] as const;

const REPORT_SLUGS: Record<StatementKey, string> = {
  profit_loss: "books-profit-loss",
  cash_basis: "books-cash-basis",
  balance_sheet: "books-balance-sheet",
  trial_balance: "books-trial-balance",
  cash_flow: "books-cash-flow",
};

export function BooksStatements() {
  const [periodKey, setPeriodKey] = useState<string>("year");
  const [statement, setStatement] = useState<StatementKey>("profit_loss");
  const [byProject, setByProject] = useState(false);
  const [comparison, setComparison] = useState<"prior_year" | "prior_period" | "none">("prior_year");
  const [monthly, setMonthly] = useState(false);
  const [data, setData] = useState<StatementsForPeriod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<ActivityTarget | null>(null);

  const period = useMemo(() => periodRange(periodKey), [periodKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadStatementsAction({
      startDate: period.startDate,
      endDate: period.endDate,
      comparison,
      includeMonthly: monthly && statement === "profit_loss",
    })
      .then((result) => {
        if (cancelled) return;
        if (result.success) setData(result.data as StatementsForPeriod);
        else setError(result.error ?? "These statements could not be built.");
      })
      .catch(() => {
        if (!cancelled) setError("These statements could not be built.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period.startDate, period.endDate, comparison, monthly, statement]);

  const openAccount = useCallback(
    (
      row: { accountId: string; code: string; name: string },
      project?: { id: string | null; name: string },
    ) => {
      setTarget({
        accountId: row.accountId,
        code: row.code,
        name: row.name,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
      });
    },
    [],
  );

  return (
    <div className="desk-rise space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Statements">
          {STATEMENTS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setStatement(item.key)}
              className={cn(
                "border px-3 py-1.5 text-sm transition-colors",
                statement === item.key
                  ? "border-foreground bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-1">
          {PERIOD_KEYS.map((key) => {
            const option = periodRange(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPeriodKey(key)}
                className={cn(
                  "border px-2.5 py-1.5 text-xs transition-colors",
                  periodKey === key
                    ? "border-foreground text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {statement === "balance_sheet" || statement === "trial_balance"
            ? `As of ${period.endDate}`
            : `${period.startDate} → ${period.endDate}`}
          {" · posted entries only"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={comparison} onValueChange={(value) => setComparison(value as typeof comparison)}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="prior_year">Prior year</SelectItem>
              <SelectItem value="prior_period">Prior period</SelectItem>
              <SelectItem value="none">No comparison</SelectItem>
            </SelectContent>
          </Select>
          {statement === "profit_loss" ? (
            <Button type="button" size="sm" variant={monthly ? "default" : "outline"} onClick={() => { setMonthly((value) => !value); setByProject(false); }}>
              Monthly columns
            </Button>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link href={`/reports/${REPORT_SLUGS[statement]}${statement === "balance_sheet" || statement === "trial_balance" ? `?asOf=${period.endDate}` : ""}`}>
              Export or print
            </Link>
          </Button>
        </div>
      </div>

      {loading ? <StatementSkeleton /> : null}

      {!loading && error ? (
        <div className="border px-5 py-12 text-center">
          <p className="text-sm font-medium">
            These statements could not be built
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {error}
          </p>
        </div>
      ) : null}

      {!loading && !error && data ? (
        <>
          {statement === "profit_loss" ? (
            <ProfitAndLoss
              data={data}
              byProject={byProject}
              onToggleByProject={setByProject}
              onOpen={openAccount}
              monthly={monthly}
            />
          ) : null}
          {statement === "balance_sheet" ? (
            <BalanceSheet data={data} onOpen={openAccount} />
          ) : null}
          {statement === "trial_balance" ? (
            <TrialBalance data={data} onOpen={openAccount} />
          ) : null}
          {statement === "cash_flow" ? <CashFlow data={data} /> : null}
          {statement === "cash_basis" ? <CashBasis data={data} /> : null}
        </>
      ) : null}

      <AccountActivitySheet
        target={target}
        startDate={period.startDate}
        endDate={period.endDate}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      />
    </div>
  );
}

type OpenAccount = (
  row: { accountId: string; code: string; name: string },
  project?: { id: string | null; name: string },
) => void;

function ProfitAndLoss({
  data,
  byProject,
  onToggleByProject,
  onOpen,
  monthly,
}: {
  data: StatementsForPeriod;
  byProject: boolean;
  onToggleByProject: (next: boolean) => void;
  onOpen: OpenAccount;
  monthly: boolean;
}) {
  const pnl = data.profitLoss;
  const prior = data.priorProfitLoss;
  const priorByAccount = useMemo(
    () =>
      new Map(
        (prior?.rows ?? []).map((row) => [row.accountId, row.balanceCents]),
      ),
    [prior],
  );

  if (monthly && data.monthlyProfitLoss.length > 0) {
    return <MonthlyProfitAndLoss data={data} onOpen={onOpen} />;
  }

  if (pnl.rows.length === 0) {
    return (
      <Empty>
        Nothing has posted to an income or expense account in this period.
        Revenue appears here once percentage-of-completion recognition runs at
        period close.
      </Empty>
    );
  }

  if (byProject) {
    return (
      <>
        <ViewToggle byProject onToggle={onToggleByProject} />
        <TableShell minWidth={720}>
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <Th>Project</Th>
              <Th className="text-right">Revenue</Th>
              <Th className="text-right">Cost of revenue</Th>
              <Th className="text-right">Gross profit</Th>
              <Th className="text-right">Expenses</Th>
              <Th className="text-right">Net</Th>
            </tr>
          </thead>
          <tbody>
            {pnl.byProject.map((project) => (
              <tr key={project.projectId ?? "unassigned"} className="border-b">
                <Td>
                  <span
                    className={cn(
                      project.projectId ? "" : "text-muted-foreground",
                    )}
                  >
                    {project.projectName}
                  </span>
                </Td>
                <Money value={project.revenueCents} />
                <Money value={project.cogsCents} />
                <Money value={project.grossProfitCents} />
                <Money value={project.expenseCents} />
                <Money value={project.netIncomeCents} emphasis />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-t-foreground/20 bg-muted/30 font-semibold">
              <Td>Total</Td>
              <Money value={pnl.revenueCents} />
              <Money value={pnl.cogsCents} />
              <Money value={pnl.grossProfitCents} />
              <Money value={pnl.expenseCents} />
              <Money value={pnl.netIncomeCents} />
            </tr>
          </tfoot>
        </TableShell>
      </>
    );
  }

  const section = (type: StatementAccountRow["accountType"]) =>
    pnl.rows.filter((row) => row.accountType === type);

  return (
    <>
      <ViewToggle byProject={false} onToggle={onToggleByProject} />
      <TableShell minWidth={640}>
        <thead>
          <tr className="border-b bg-muted/40 text-left">
            <Th>Account</Th>
            <Th className="text-right">Amount</Th>
            {prior ? <Th className="text-right">{data.comparisonLabel ?? "Comparison"}</Th> : null}
          </tr>
        </thead>
        <tbody>
          <Group label="Revenue" span={prior ? 3 : 2} />
          {section("income").map((row) => (
            <AccountRow
              key={row.accountId}
              row={row}
              prior={priorByAccount.get(row.accountId)}
              showPrior={Boolean(prior)}
              onOpen={onOpen}
            />
          ))}
          <Subtotal
            label="Total revenue"
            value={pnl.revenueCents}
            prior={prior?.revenueCents}
            showPrior={Boolean(prior)}
          />

          <Group label="Cost of revenue" span={prior ? 3 : 2} />
          {section("cogs").map((row) => (
            <AccountRow
              key={row.accountId}
              row={row}
              prior={priorByAccount.get(row.accountId)}
              showPrior={Boolean(prior)}
              onOpen={onOpen}
            />
          ))}
          <Subtotal
            label="Total cost of revenue"
            value={pnl.cogsCents}
            prior={prior?.cogsCents}
            showPrior={Boolean(prior)}
          />
          <Subtotal
            label="Gross profit"
            value={pnl.grossProfitCents}
            prior={prior?.grossProfitCents}
            showPrior={Boolean(prior)}
            strong
          />

          <Group label="Operating expenses" span={prior ? 3 : 2} />
          {section("expense").map((row) => (
            <AccountRow
              key={row.accountId}
              row={row}
              prior={priorByAccount.get(row.accountId)}
              showPrior={Boolean(prior)}
              onOpen={onOpen}
            />
          ))}
          <Subtotal
            label="Total operating expenses"
            value={pnl.expenseCents}
            prior={prior?.expenseCents}
            showPrior={Boolean(prior)}
          />
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-t-foreground/20 bg-muted/30 font-semibold">
            <Td>Net income</Td>
            <Money value={pnl.netIncomeCents} />
            {prior ? <Money value={prior.netIncomeCents} muted /> : null}
          </tr>
        </tfoot>
      </TableShell>
    </>
  );
}

function MonthlyProfitAndLoss({ data, onOpen }: { data: StatementsForPeriod; onOpen: OpenAccount }) {
  const months = data.monthlyProfitLoss;
  const monthlyByAccount = months.map((month) => new Map(month.profitLoss.rows.map((row) => [row.accountId, row.balanceCents])));
  const sections: Array<{ type: StatementAccountRow["accountType"]; label: string }> = [
    { type: "income", label: "Revenue" },
    { type: "cogs", label: "Cost of revenue" },
    { type: "expense", label: "Operating expenses" },
  ];
  return (
    <TableShell minWidth={Math.max(760, 280 + months.length * 112)}>
      <thead>
        <tr className="border-b bg-muted/40 text-left">
          <Th>Account</Th>
          {months.map((month) => <Th key={month.startDate} className="text-right">{month.label}</Th>)}
          <Th className="text-right">Total</Th>
        </tr>
      </thead>
      <tbody>
        {sections.map((section) => (
          <Fragment key={section.type}>
            <Group label={section.label} span={months.length + 2} />
            {data.profitLoss.rows.filter((row) => row.accountType === section.type).map((row) => (
              <tr key={row.accountId} className="border-b hover:bg-muted/40">
                <Td><button type="button" onClick={() => onOpen(row)} className="text-left underline-offset-4 hover:underline"><span className="font-mono text-xs text-muted-foreground">{row.code}</span> {row.name}</button></Td>
                {monthlyByAccount.map((month, index) => <Money key={months[index].startDate} value={month.get(row.accountId) ?? 0} muted />)}
                <Money value={row.balanceCents} emphasis />
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-t-foreground/20 bg-muted/30 font-semibold">
          <Td>Net income</Td>
          {months.map((month) => <Money key={month.startDate} value={month.profitLoss.netIncomeCents} />)}
          <Money value={data.profitLoss.netIncomeCents} />
        </tr>
      </tfoot>
    </TableShell>
  );
}

/**
 * One P&L account. Expands to its project split — the construction dimension the
 * account-level total hides — and each split row drills down scoped to that project.
 */
function AccountRow({
  row,
  prior,
  showPrior,
  onOpen,
}: {
  row: StatementAccountRow;
  prior?: number;
  showPrior: boolean;
  onOpen: OpenAccount;
}) {
  const [expanded, setExpanded] = useState(false);
  const projects = row.projects ?? [];
  const splittable = projects.length > 1;

  return (
    <>
      <tr className="border-b hover:bg-muted/40">
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            {splittable ? (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                aria-label={
                  expanded
                    ? `Hide project detail for ${row.name}`
                    : `Show project detail for ${row.name}`
                }
                aria-expanded={expanded}
                className="text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    expanded && "rotate-90",
                  )}
                />
              </button>
            ) : (
              <span className="w-3.5" aria-hidden />
            )}
            <button
              type="button"
              onClick={() => onOpen(row)}
              className="text-left underline-offset-4 hover:underline"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {row.code}
              </span>{" "}
              {row.name}
            </button>
          </div>
        </td>
        <Money value={row.balanceCents} />
        {showPrior ? <Money value={prior ?? 0} muted /> : null}
      </tr>
      {expanded
        ? projects.map((project) => (
            <tr
              key={`${row.accountId}:${project.projectId ?? "unassigned"}`}
              className="border-b bg-muted/20"
            >
              <td className="py-1.5 pl-12 pr-3">
                <button
                  type="button"
                  onClick={() =>
                    onOpen(row, {
                      id: project.projectId,
                      name: project.projectName,
                    })
                  }
                  className={cn(
                    "text-left text-xs underline-offset-4 hover:underline",
                    project.projectId
                      ? "text-muted-foreground"
                      : "italic text-muted-foreground",
                  )}
                >
                  {project.projectName}
                </button>
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {formatMoneyCentsExact(project.balanceCents)}
              </td>
              {showPrior ? <td /> : null}
            </tr>
          ))
        : null}
    </>
  );
}

function BalanceSheet({
  data,
  onOpen,
}: {
  data: StatementsForPeriod;
  onOpen: OpenAccount;
}) {
  const sheet = data.balanceSheet;
  if (sheet.rows.length === 0)
    return <Empty>No balance-sheet activity has posted as of this date.</Empty>;
  const section = (type: StatementAccountRow["accountType"]) =>
    sheet.rows.filter((row) => row.accountType === type);

  return (
    <TableShell minWidth={560}>
      <thead>
        <tr className="border-b bg-muted/40 text-left">
          <Th>Account</Th>
          <Th className="text-right">Balance</Th>
        </tr>
      </thead>
      <tbody>
        <Group label="Assets" span={2} />
        {section("asset").map((row) => (
          <SimpleAccountRow key={row.accountId} row={row} onOpen={onOpen} />
        ))}
        <Subtotal
          label="Total assets"
          value={sheet.assetCents}
          showPrior={false}
          strong
        />

        <Group label="Liabilities" span={2} />
        {section("liability").map((row) => (
          <SimpleAccountRow key={row.accountId} row={row} onOpen={onOpen} />
        ))}
        <Subtotal
          label="Total liabilities"
          value={sheet.liabilityCents}
          showPrior={false}
        />

        <Group label="Equity" span={2} />
        {section("equity").map((row) => (
          <SimpleAccountRow key={row.accountId} row={row} onOpen={onOpen} />
        ))}
        <tr className="border-b">
          <td className="px-3 py-2 text-muted-foreground">
            Current period earnings
          </td>
          <Money value={sheet.currentEarningsCents} muted />
        </tr>
        <Subtotal
          label="Total equity"
          value={sheet.equityCents}
          showPrior={false}
        />
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-t-foreground/20 bg-muted/30 font-semibold">
          <Td>Liabilities and equity</Td>
          <Money value={sheet.liabilityCents + sheet.equityCents} />
        </tr>
        {sheet.differenceCents !== 0 ? (
          <tr className="border-t bg-destructive/10">
            <Td>
              <span className="text-destructive">Out of balance</span>
            </Td>
            <Money value={sheet.differenceCents} />
          </tr>
        ) : null}
      </tfoot>
    </TableShell>
  );
}

function TrialBalance({
  data,
  onOpen,
}: {
  data: StatementsForPeriod;
  onOpen: OpenAccount;
}) {
  const trial = data.trialBalance;
  if (trial.rows.length === 0)
    return <Empty>No entries have posted as of this date.</Empty>;
  const difference = trial.totalDebitCents - trial.totalCreditCents;

  return (
    <TableShell minWidth={620}>
      <thead>
        <tr className="border-b bg-muted/40 text-left">
          <Th>Account</Th>
          <Th className="text-right">Debit</Th>
          <Th className="text-right">Credit</Th>
        </tr>
      </thead>
      <tbody>
        {trial.rows.map((row) => (
          <tr key={row.accountId} className="border-b hover:bg-muted/40">
            <td className="px-3 py-2">
              <button
                type="button"
                onClick={() => onOpen(row)}
                className="text-left underline-offset-4 hover:underline"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {row.code}
                </span>{" "}
                {row.name}
              </button>
            </td>
            <Money value={row.debitCents} zeroDash />
            <Money value={row.creditCents} zeroDash />
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-t-foreground/20 bg-muted/30 font-semibold">
          <Td>Total</Td>
          <Money value={trial.totalDebitCents} />
          <Money value={trial.totalCreditCents} />
        </tr>
        {difference !== 0 ? (
          <tr className="border-t bg-destructive/10">
            <Td>
              <span className="text-destructive">
                Debits and credits disagree
              </span>
            </Td>
            <td
              colSpan={2}
              className="px-3 py-2 text-right font-mono tabular-nums text-destructive"
            >
              {formatMoneyCentsExact(difference)}
            </td>
          </tr>
        ) : null}
      </tfoot>
    </TableShell>
  );
}

function CashFlow({ data }: { data: StatementsForPeriod }) {
  const flow = data.cashFlow;
  const rows = [
    { label: "Operating activities", value: flow.operatingCents },
    { label: "Investing activities", value: flow.investingCents },
    { label: "Financing activities", value: flow.financingCents },
  ];
  if (rows.every((row) => row.value === 0) && flow.netChangeInCashCents === 0) {
    return <Empty>No cash moved in this period.</Empty>;
  }
  return (
    <TableShell minWidth={420}>
      <thead>
        <tr className="border-b bg-muted/40 text-left">
          <Th>Activity</Th>
          <Th className="text-right">Cash change</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className="border-b">
            <Td>{row.label}</Td>
            <Money value={row.value} />
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-t-foreground/20 bg-muted/30 font-semibold">
          <Td>Net change in cash</Td>
          <Money value={flow.netChangeInCashCents} />
        </tr>
      </tfoot>
    </TableShell>
  );
}

/**
 * Cash basis, shown as a reconciliation rather than a bare number.
 *
 * A builder files taxes on this, and their CPA has to be able to tie it back to
 * the accrual statement beside it — so the conversion adjustments are on screen
 * as named lines instead of folded into a total nobody can check.
 */
function CashBasis({ data }: { data: StatementsForPeriod }) {
  const cash = data.cashBasis;
  const nothing =
    cash.accrualRevenueCents === 0 &&
    cash.accrualCostCents === 0 &&
    cash.cashReceiptsCents === 0 &&
    cash.cashPaidCents === 0;
  if (nothing)
    return <Empty>Nothing has posted in this period to convert.</Empty>;

  return (
    <>
      <TableShell minWidth={560}>
        <thead>
          <tr className="border-b bg-muted/40 text-left">
            <Th>Conversion</Th>
            <Th className="text-right">Amount</Th>
          </tr>
        </thead>
        <tbody>
          <Group label="Receipts from customers" span={2} />
          <tr className="border-b">
            <Td>Revenue, accrual basis</Td>
            <Money value={cash.accrualRevenueCents} />
          </tr>
          {cash.revenueAdjustments.map((adjustment) => (
            <tr key={adjustment.label} className="border-b">
              <td className="py-2 pl-8 pr-3 text-muted-foreground">
                {adjustment.label}
              </td>
              <Money value={adjustment.amountCents} muted />
            </tr>
          ))}
          <Subtotal
            label="Cash collected"
            value={cash.cashReceiptsCents}
            showPrior={false}
            strong
          />

          <Group label="Costs and expenses paid" span={2} />
          <tr className="border-b">
            <Td>Costs and expenses, accrual basis</Td>
            <Money value={cash.accrualCostCents} />
          </tr>
          {cash.costAdjustments.map((adjustment) => (
            <tr key={adjustment.label} className="border-b">
              <td className="py-2 pl-8 pr-3 text-muted-foreground">
                {adjustment.label}
              </td>
              <Money value={adjustment.amountCents} muted />
            </tr>
          ))}
          <Subtotal
            label="Cash paid"
            value={cash.cashPaidCents}
            showPrior={false}
            strong
          />
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/20">
            <Td>Net income, accrual basis</Td>
            <Money value={cash.accrualNetIncomeCents} muted />
          </tr>
          <tr className="border-t-2 border-t-foreground/20 bg-muted/30 font-semibold">
            <Td>Net income, cash basis</Td>
            <Money value={cash.cashNetIncomeCents} />
          </tr>
        </tfoot>
      </TableShell>
      <p className="text-xs leading-5 text-muted-foreground">
        Converted from the accrual ledger using the movement in receivables,
        payables, retainage, billings in excess and payroll clearing over this
        period. Cost of revenue and operating expenses are converted together,
        because accounts payable is shared by both and the ledger does not
        record which payable belongs to which — net income is unaffected. This
        restates what is in the ledger; it is not a tax return, and says nothing
        about elections, depreciation schedules or method eligibility.
      </p>
    </>
  );
}

function SimpleAccountRow({
  row,
  onOpen,
}: {
  row: StatementAccountRow;
  onOpen: OpenAccount;
}) {
  return (
    <tr className="border-b hover:bg-muted/40">
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={() => onOpen(row)}
          className="text-left underline-offset-4 hover:underline"
        >
          <span className="font-mono text-xs text-muted-foreground">
            {row.code}
          </span>{" "}
          {row.name}
        </button>
      </td>
      <Money value={row.balanceCents} />
    </tr>
  );
}

function ViewToggle({
  byProject,
  onToggle,
}: {
  byProject: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className="flex justify-end">
      <div className="flex border">
        <button
          type="button"
          onClick={() => onToggle(false)}
          className={cn(
            "px-3 py-1 text-xs transition-colors",
            !byProject
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          By account
        </button>
        <button
          type="button"
          onClick={() => onToggle(true)}
          className={cn(
            "px-3 py-1 text-xs transition-colors",
            byProject
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          By project
        </button>
      </div>
    </div>
  );
}

function TableShell({
  children,
  minWidth,
}: {
  children: React.ReactNode;
  minWidth: number;
}) {
  return (
    <div className="overflow-x-auto border bg-background">
      <table className="w-full text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2">{children}</td>;
}

function Money({
  value,
  muted,
  emphasis,
  zeroDash,
}: {
  value: number;
  muted?: boolean;
  emphasis?: boolean;
  zeroDash?: boolean;
}) {
  return (
    <td
      className={cn(
        "px-3 py-2 text-right font-mono tabular-nums",
        muted && "text-muted-foreground",
        emphasis && "font-semibold",
      )}
    >
      {zeroDash && value === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        formatMoneyCentsExact(value)
      )}
    </td>
  );
}

function Group({ label, span }: { label: string; span: number }) {
  return (
    <tr className="border-b bg-muted/40">
      <td
        colSpan={span}
        className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </td>
    </tr>
  );
}

function Subtotal({
  label,
  value,
  prior,
  showPrior,
  strong,
}: {
  label: string;
  value: number;
  prior?: number;
  showPrior: boolean;
  strong?: boolean;
}) {
  return (
    <tr className={cn("border-b", strong ? "font-semibold" : "font-medium")}>
      <Td>{label}</Td>
      <Money value={value} />
      {showPrior ? <Money value={prior ?? 0} muted /> : null}
    </tr>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="border bg-background px-5 py-12 text-center">
      <p className="mx-auto max-w-md text-sm text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

function StatementSkeleton() {
  return (
    <div className="border bg-background">
      <div className="border-b bg-muted/40 px-3 py-2">
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="divide-y">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center justify-between px-3 py-2.5"
          >
            <Skeleton className="h-4 w-52" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
