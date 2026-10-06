"use client";

import { useEffect, useState } from "react";
import {
  parseBudgetCents as cents,
  spreadAnnualBudget,
} from "@/lib/financials/company-budget";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import {
  loadOverheadBudgetAction,
  saveOverheadBudgetAction,
} from "@/app/(app)/books/actions";
import {
  AccountActivitySheet,
  type ActivityTarget,
} from "@/components/books/account-activity-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn, formatMoneyCentsExact as money } from "@/lib/utils";

type Workspace = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/overhead-budgets").getOverheadBudgetWorkspace
  >
>;
const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);
const monthLabel = (date: string, long = false) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: long ? "long" : "short",
    ...(long ? { year: "numeric" as const } : {}),
    timeZone: "UTC",
  });
const monthEnd = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

export function OverheadBudget({
  canEdit,
  initialYear = new Date().getFullYear(),
}: {
  canEdit: boolean;
  initialYear?: number;
}) {
  const [year, setYear] = useState(initialYear);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [period, setPeriod] = useState("year");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState(false);
  const [activity, setActivity] = useState<ActivityTarget | null>(null);
  useEffect(() => {
    let cancelled = false;
    setWorkspace(null);
    setError(null);
    loadOverheadBudgetAction(year)
      .then((result) => {
        if (cancelled) return;
        if (result.success) setWorkspace(result.data);
        else setError(result.error ?? "Could not load the company budget.");
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the company budget.");
      });
    return () => {
      cancelled = true;
    };
  }, [year, revision]);

  const months = workspace?.monthStarts ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const indices = months.flatMap((date, index) =>
    period === "year" ||
    (period === "ytd" ? date <= today : index === Number(period))
      ? [index]
      : [],
  );
  const total = (values: number[]) =>
    sum(indices.map((index) => values[index]));
  const accounts = workspace?.accounts ?? [];
  const budget = sum(accounts.map((account) => total(account.budgetCents)));
  const actual = sum(accounts.map((account) => total(account.actualCents)));
  const hasBudget = Boolean(workspace?.budget);
  const monthly = months.map((date, index) => ({
    date,
    budget: sum(accounts.map((account) => account.budgetCents[index])),
    actual: sum(accounts.map((account) => account.actualCents[index])),
  }));
  const scale = Math.max(
    1,
    ...monthly.flatMap((month) => [Math.abs(month.actual), month.budget]),
  );
  const rows = accounts
    .filter((account) =>
      `${account.code} ${account.name}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .filter(
      (account) =>
        !hasBudget ||
        filter !== "over" ||
        (hasBudget && total(account.actualCents) > total(account.budgetCents)),
    );
  const startDate = months[indices[0]] ?? months[0] ?? today;
  const endDate = monthEnd(months[indices.at(-1) ?? 0] ?? today);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Company budget
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Plan the cost of running your business.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-md border">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous fiscal year"
              disabled={year <= 2000}
              onClick={() => {
                setYear(year - 1);
                setPeriod("year");
              }}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-20 text-center font-mono text-sm">
              FY {year}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next fiscal year"
              disabled={year >= 2200}
              onClick={() => {
                setYear(year + 1);
                setPeriod("year");
              }}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
          {canEdit && workspace ? (
            <Button onClick={() => setEditing(true)}>
              {hasBudget ? (
                <Pencil className="mr-2 size-3.5" />
              ) : (
                <Plus className="mr-2 size-4" />
              )}
              {hasBudget ? "Edit budget" : "Create budget"}
            </Button>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-12 text-center" role="alert">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => setRevision((value) => value + 1)}
            >
              Try again
            </Button>
          </div>
        ) : !workspace ? (
          <div
            className="space-y-6 p-6"
            role="status"
            aria-label="Loading company budget"
          >
            <div className="h-44 animate-pulse rounded-md bg-muted" />
            <div className="h-64 animate-pulse rounded-md bg-muted/50" />
          </div>
        ) : (
          <>
            <section className="grid border-b lg:grid-cols-[minmax(240px,1fr)_2fr]">
              <div className="flex flex-col justify-between gap-6 px-6 py-6 lg:border-r">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {period === "year"
                      ? "Fiscal year"
                      : period === "ytd"
                        ? "Through current month"
                        : monthLabel(months[Number(period)], true)}{" "}
                    · actual expenses
                  </p>
                  <p className="mt-3 font-mono text-3xl tracking-tight tabular-nums">
                    {money(actual)}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Budget
                      {workspace.budget?.status === "draft"
                        ? " · draft"
                        : workspace.budget?.status === "archived"
                          ? " · archived"
                          : ""}
                    </p>
                    <p className="mt-1 font-mono tabular-nums">
                      {hasBudget ? money(budget) : "Not set"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {!hasBudget
                        ? "Variance"
                        : actual > budget
                          ? "Over budget"
                          : "Remaining"}
                    </p>
                    <p
                      className={cn(
                        "mt-1 font-mono tabular-nums",
                        hasBudget && actual > budget && "text-destructive",
                      )}
                    >
                      {hasBudget ? money(Math.abs(budget - actual)) : "—"}
                    </p>
                  </div>
                </div>
              </div>
              <div className="px-6 py-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium">The year at a glance</p>
                  <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-sm bg-foreground" />
                      Actual
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-sm border bg-muted" />
                      Budget
                    </span>
                  </div>
                </div>
                <div className="mt-5 grid h-32 grid-cols-12 gap-1">
                  {monthly.map((month, index) => (
                    <button
                      key={month.date}
                      title={`${monthLabel(month.date, true)} · Actual ${money(month.actual)} · Budget ${hasBudget ? money(month.budget) : "not set"}`}
                      aria-label={`${monthLabel(month.date, true)}: actual ${money(month.actual)}, budget ${hasBudget ? money(month.budget) : "not set"}`}
                      aria-pressed={period === String(index)}
                      onClick={() =>
                        setPeriod(
                          period === String(index) ? "year" : String(index),
                        )
                      }
                      className={cn(
                        "group flex min-w-0 flex-col rounded-sm px-1 pt-1 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                        period === String(index) && "bg-muted",
                      )}
                    >
                      <span className="flex min-h-0 flex-1 items-end justify-center gap-1 border-b pb-1">
                        <span
                          className="w-2.5 rounded-t-sm border bg-muted"
                          style={{
                            height: `${(month.budget / scale) * 100}%`,
                            minHeight: month.budget ? 2 : 0,
                          }}
                        />
                        <span
                          className={cn(
                            "w-2.5 rounded-t-sm bg-foreground/80",
                            month.actual < 0 && "bg-success",
                          )}
                          style={{
                            height: `${(Math.abs(month.actual) / scale) * 100}%`,
                            minHeight: month.actual ? 2 : 0,
                          }}
                        />
                      </span>
                      <span className="mt-2 text-[10px] text-muted-foreground">
                        {monthLabel(month.date)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </section>
            {!hasBudget ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-6 py-4">
                <div>
                  <p className="text-sm font-medium">
                    Actual spending, even before you have a plan.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Create a monthly budget when you’re ready to compare
                    spending against a target.
                  </p>
                </div>
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(true)}
                  >
                    Build your budget <ArrowUpRight className="ml-2 size-4" />
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3">
              <div className="relative">
                <Search className="absolute left-0 top-2.5 size-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Search expense accounts"
                  placeholder="Find an expense account…"
                  className="w-64 border-0 bg-transparent pl-6 shadow-none"
                />
              </div>
              <div className="flex items-center gap-3">
                <select
                  aria-label="Budget period"
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={period}
                  onChange={(event) => setPeriod(event.target.value)}
                >
                  <option value="year">Full fiscal year</option>
                  {months[0] <= today ? (
                    <option value="ytd">Through current month</option>
                  ) : null}
                  {months.map((date, index) => (
                    <option key={date} value={index}>
                      {monthLabel(date, true)}
                    </option>
                  ))}
                </select>
                {hasBudget ? (
                  <select
                    aria-label="Account filter"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                  >
                    <option value="all">All accounts</option>
                    <option value="over">Over budget</option>
                  </select>
                ) : null}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead className="border-b bg-muted/20 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="px-6 py-3 text-left font-medium">
                      Expense account
                    </th>
                    <th className="px-4 py-3 text-right font-medium">Budget</th>
                    <th className="px-4 py-3 text-right font-medium">Actual</th>
                    <th className="px-6 py-3 text-right font-medium">
                      Remaining / over
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((account) => {
                    const planned = total(account.budgetCents);
                    const spent = total(account.actualCents);
                    return (
                      <tr
                        key={account.id}
                        className="group border-b transition-colors hover:bg-muted/25"
                      >
                        <td className="px-6 py-4">
                          <button
                            className="flex items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() =>
                              setActivity({
                                accountId: account.id,
                                code: account.code,
                                name: account.name,
                                unassignedOnly: true,
                                operatingOnly: true,
                              })
                            }
                          >
                            <span className="font-mono text-xs text-muted-foreground">
                              {account.code}
                            </span>
                            <span className="font-medium">
                              {account.name}
                              {!account.active ? (
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  Inactive
                                </span>
                              ) : null}
                            </span>
                            <ArrowUpRight className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
                          </button>
                        </td>
                        <td className="px-4 py-4 text-right font-mono tabular-nums">
                          {hasBudget ? money(planned) : "—"}
                        </td>
                        <td className="px-4 py-4 text-right">
                          <button
                            className="font-mono tabular-nums underline-offset-4 hover:underline"
                            aria-label={`View ${account.name} actual transactions`}
                            onClick={() =>
                              setActivity({
                                accountId: account.id,
                                code: account.code,
                                name: account.name,
                                unassignedOnly: true,
                                operatingOnly: true,
                              })
                            }
                          >
                            {money(spent)}
                          </button>
                        </td>
                        <td
                          className={cn(
                            "px-6 py-4 text-right font-mono tabular-nums",
                            hasBudget && spent > planned
                              ? "text-destructive"
                              : "text-muted-foreground",
                          )}
                        >
                          {hasBudget
                            ? `${money(Math.abs(planned - spent))}${spent > planned ? " over" : ""}`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {rows.length > 0 ? (
                  <tfoot>
                    <tr className="border-b bg-muted/20 font-medium">
                      <td className="px-6 py-4">
                        {query || filter !== "all"
                          ? "Filtered total"
                          : "Total company expenses"}
                      </td>
                      <td className="px-4 py-4 text-right font-mono">
                        {hasBudget
                          ? money(sum(rows.map((a) => total(a.budgetCents))))
                          : "—"}
                      </td>
                      <td className="px-4 py-4 text-right font-mono">
                        {money(sum(rows.map((a) => total(a.actualCents))))}
                      </td>
                      <td className="px-6 py-4 text-right font-mono">
                        {hasBudget
                          ? money(
                              sum(
                                rows.map(
                                  (a) =>
                                    total(a.budgetCents) - total(a.actualCents),
                                ),
                              ),
                            )
                          : "—"}
                      </td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
            {rows.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-sm font-medium">
                  {accounts.length
                    ? "No accounts match this view"
                    : "No expense accounts yet"}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {accounts.length
                    ? "Try a different search or account filter."
                    : "Add expense accounts in Settings → Accounting → Chart of accounts."}
                </p>
              </div>
            ) : null}
            <p className="px-6 py-4 text-xs leading-5 text-muted-foreground">
              {monthLabel(months[0], true)} – {monthLabel(months[11], true)} ·
              Posted expenses without a project, on an accrual basis. Project
              costs stay in project budgets. Negative actuals represent net
              credits.
            </p>
            <BudgetEditor
              key={`${year}-${revision}`}
              open={editing}
              onClose={() => setEditing(false)}
              workspace={workspace}
              onSaved={() => {
                setEditing(false);
                setRevision((value) => value + 1);
              }}
            />
          </>
        )}
      </div>
      <AccountActivitySheet
        target={activity}
        startDate={startDate}
        endDate={endDate}
        onOpenChange={(open) => {
          if (!open) setActivity(null);
        }}
      />
    </div>
  );
}

function BudgetEditor({
  open,
  onClose,
  workspace,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  workspace: Workspace;
  onSaved: () => void;
}) {
  const initial = () =>
    Object.fromEntries(
      workspace.accounts.map((account) => [
        account.id,
        account.budgetCents.map((value) => (value / 100).toFixed(2)),
      ]),
    );
  const [values, setValues] = useState<Record<string, string[]>>(initial);
  const [selected, setSelected] = useState(
    workspace.accounts.find((account) => account.active)?.id ?? "",
  );
  const [name, setName] = useState(workspace.budget?.name ?? "Company budget");
  const [status, setStatus] = useState<"draft" | "active" | "archived">(
    (workspace.budget?.status as "draft" | "active" | "archived") ?? "draft",
  );
  const [annual, setAnnual] = useState("");
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const account = workspace.accounts.find((item) => item.id === selected);
  const hasInactiveBudget = workspace.accounts.some(
    (account) =>
      !account.active && account.budgetCents.some((value) => value > 0),
  );
  const valid = Object.values(values).every((months) =>
    months.every((value) => Number.isFinite(cents(value))),
  );
  const update = (months: string[]) => {
    setValues((current) => ({ ...current, [selected]: months }));
    setDirty(true);
  };
  const close = () => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const save = async () => {
    if (!valid || hasInactiveBudget || name.trim().length < 2) return;
    setPending(true);
    try {
      const result = await saveOverheadBudgetAction({
        budgetId: workspace.budget?.id,
        fiscalYear: workspace.fiscalYear,
        name,
        status,
        notes: workspace.budget?.notes,
        lines: Object.entries(values)
          .flatMap(([accountId, months]) =>
            months.map((value, month) => ({
              accountId,
              month,
              budgetCents: cents(value),
            })),
          )
          .filter((line) => line.budgetCents > 0),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setDirty(false);
      toast.success("Company budget saved");
      onSaved();
    } catch {
      toast.error("Could not save your budget. Your changes are still here.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent
        aria-labelledby="company-budget-editor-title"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle id="company-budget-editor-title">
            Plan your company expenses
          </SheetTitle>
          <SheetDescription>
            FY {workspace.fiscalYear} · Set a monthly plan for each account.
          </SheetDescription>
        </SheetHeader>
        <fieldset disabled={pending} className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 p-6">
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <label className="space-y-2 text-xs font-medium">
                Budget name
                <Input
                  value={name}
                  maxLength={100}
                  onChange={(event) => {
                    setName(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label className="space-y-2 text-xs font-medium">
                Status
                <select
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value as typeof status);
                    setDirty(true);
                  }}
                  className="h-9 w-full rounded-md border bg-background px-2"
                >
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
            </div>
            <label className="block space-y-2 text-xs font-medium">
              Expense account
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setAnnual("");
                }}
              >
                <option value="" disabled>
                  Select an account
                </option>
                {workspace.accounts.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.active}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            {account ? (
              <>
                <div className="rounded-md border bg-muted/20 p-4">
                  <p className="text-sm font-medium">
                    Start with an annual amount
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Spread it evenly, then adjust individual months below.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Input
                      aria-label="Annual amount"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={annual}
                      onChange={(event) => setAnnual(event.target.value)}
                    />
                    <Button
                      variant="outline"
                      disabled={!annual || !Number.isFinite(cents(annual))}
                      onClick={() => {
                        const amount = cents(annual);
                        update(
                          spreadAnnualBudget(amount).map((value) =>
                            (value / 100).toFixed(2),
                          ),
                        );
                      }}
                    >
                      Spread across months
                    </Button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">Monthly plan</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      update(
                        account.actualCents.map((value) =>
                          (Math.max(0, value) / 100).toFixed(2),
                        ),
                      )
                    }
                  >
                    Use this year’s actuals
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
                  {workspace.monthStarts.map((date, index) => (
                    <label
                      key={date}
                      className="space-y-1.5 text-xs text-muted-foreground"
                    >
                      {monthLabel(date, true)}
                      <Input
                        aria-label={`${monthLabel(date, true)} budget`}
                        inputMode="decimal"
                        className="font-mono text-right text-foreground"
                        value={values[selected]?.[index] ?? ""}
                        aria-invalid={
                          !Number.isFinite(
                            cents(values[selected]?.[index] ?? ""),
                          )
                        }
                        onChange={(event) =>
                          update(
                            (values[selected] ?? Array(12).fill("")).map(
                              (value, i) =>
                                i === index ? event.target.value : value,
                            ),
                          )
                        }
                      />
                      <span className="block text-[10px]">
                        Actual {money(account.actualCents[index])}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex justify-between border-t pt-4 text-sm">
                  <span>{account.name} · annual plan</span>
                  <span className="font-mono">
                    {money(
                      sum(
                        (values[selected] ?? []).map(
                          (value) => cents(value) || 0,
                        ),
                      ),
                    )}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Add an expense account in accounting settings to start planning.
              </p>
            )}
            {hasInactiveBudget ? (
              <p role="alert" className="text-xs text-destructive">
                This budget includes an inactive account. Reactivate it in the
                chart of accounts before editing this plan; its existing budget
                is preserved.
              </p>
            ) : null}
            {!valid ? (
              <p role="alert" className="text-xs text-destructive">
                Use positive dollar amounts with no more than two decimal
                places.
              </p>
            ) : null}
          </div>
        </fieldset>
        <footer className="border-t bg-background px-6 py-4">
          {confirmDiscard ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">Discard your unsaved changes?</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setConfirmDiscard(false)}
                >
                  Keep editing
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setValues(initial());
                    setName(workspace.budget?.name ?? "Company budget");
                    setStatus(
                      (workspace.budget?.status as typeof status) ?? "draft",
                    );
                    setDirty(false);
                    setConfirmDiscard(false);
                    onClose();
                  }}
                >
                  Discard changes
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {dirty
                  ? "Unsaved changes"
                  : `Annual plan: ${money(
                      sum(
                        Object.values(values)
                          .flat()
                          .map((value) => cents(value) || 0),
                      ),
                    )}`}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" disabled={pending} onClick={close}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    pending ||
                    hasInactiveBudget ||
                    !valid ||
                    name.trim().length < 2 ||
                    !workspace.accounts.length
                  }
                  onClick={save}
                >
                  {pending ? "Saving…" : "Save budget"}
                </Button>
              </div>
            </div>
          )}
        </footer>
      </SheetContent>
    </Sheet>
  );
}
