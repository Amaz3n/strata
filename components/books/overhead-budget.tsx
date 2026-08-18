"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { loadOverheadBudgetAction, saveOverheadBudgetAction } from "@/app/(app)/books/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoneyCentsExact } from "@/lib/utils";

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/overhead-budgets").getOverheadBudgetWorkspace>>;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function OverheadBudget({ canEdit }: { canEdit: boolean }) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [name, setName] = useState("Annual overhead budget");
  const [status, setStatus] = useState<"draft" | "active" | "archived">("draft");
  const [values, setValues] = useState<Record<string, number[]>>({});
  const [pending, startTransition] = useTransition();
  const load = useCallback(() => loadOverheadBudgetAction(year).then((result) => {
    if (!result.success) return toast.error(result.error);
    setWorkspace(result.data); setName(result.data.budget?.name ?? "Annual overhead budget"); setStatus((result.data.budget?.status as typeof status) ?? "draft"); setValues(Object.fromEntries(result.data.accounts.map((account) => [account.id, [...account.budgetCents]])));
  }), [year]);
  useEffect(() => { void load(); }, [load]);
  const totals = useMemo(() => (workspace?.accounts ?? []).reduce((result, account) => { for (let month = 0; month < 12; month += 1) { result.budget[month] += values[account.id]?.[month] ?? 0; result.actual[month] += account.actualCents[month]; } return result; }, { budget: Array(12).fill(0) as number[], actual: Array(12).fill(0) as number[] }), [values, workspace]);
  if (!workspace) return <div className="border bg-background p-8 text-sm text-muted-foreground">Loading overhead budget…</div>;
  return (
    <section className="border bg-background">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b p-5"><div><p className="text-sm font-semibold">Overhead budget vs actual</p><p className="mt-1 text-xs text-muted-foreground">Non-project expense activity by month. Job costs stay in project budgets.</p></div><div className="flex items-end gap-2"><div><label className="text-[10px] uppercase tracking-wider text-muted-foreground">Year</label><Input type="number" className="mt-1 w-24" value={year} onChange={(event) => setYear(Number(event.target.value))} /></div>{canEdit ? <><Input value={name} onChange={(event) => setName(event.target.value)} className="w-52" /><Select value={status} onValueChange={(value) => setStatus(value as typeof status)}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">Draft</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="archived">Archived</SelectItem></SelectContent></Select><Button disabled={pending} onClick={() => startTransition(async () => { const lines = Object.entries(values).flatMap(([accountId, months]) => months.map((budgetCents, month) => ({ accountId, month, budgetCents }))).filter((line) => line.budgetCents > 0); const result = await saveOverheadBudgetAction({ budgetId: workspace.budget?.id, fiscalYear: year, name, status, lines }); if (!result.success) { toast.error(result.error); return; } toast.success("Overhead budget saved"); await load(); })}>{pending ? "Saving…" : "Save budget"}</Button></> : null}</div></div>
      <div className="overflow-x-auto"><table className="min-w-[1400px] w-full text-xs"><thead><tr className="border-b bg-muted/30"><th className="sticky left-0 z-10 min-w-56 bg-muted/30 px-4 py-2 text-left font-medium">Expense account</th>{MONTHS.map((month) => <th key={month} className="min-w-24 px-2 py-2 text-right font-medium">{month}</th>)}<th className="px-4 py-2 text-right font-medium">Annual</th></tr></thead><tbody>{workspace.accounts.map((account) => { const budget = values[account.id] ?? Array(12).fill(0); const annualBudget = budget.reduce((sum, value) => sum + value, 0); const annualActual = account.actualCents.reduce((sum, value) => sum + value, 0); return <tr key={account.id} className="border-b align-top"><td className="sticky left-0 z-10 bg-background px-4 py-3"><p className="font-medium">{account.code} · {account.name}</p><p className={annualActual > annualBudget && annualBudget > 0 ? "mt-1 text-destructive" : "mt-1 text-muted-foreground"}>Actual {formatMoneyCentsExact(annualActual)} · variance {formatMoneyCentsExact(annualBudget - annualActual)}</p></td>{MONTHS.map((_, month) => <td key={month} className="px-1 py-2 text-right">{canEdit ? <Input className="h-8 min-w-20 px-2 text-right font-mono text-xs" inputMode="decimal" value={(budget[month] / 100).toFixed(2)} onChange={(event) => { const cents = Math.max(Math.round(Number(event.target.value || 0) * 100), 0); setValues((current) => ({ ...current, [account.id]: (current[account.id] ?? Array(12).fill(0)).map((value, index) => index === month ? cents : value) })); }} /> : <p className="font-mono">{formatMoneyCentsExact(budget[month])}</p>}<p className="mt-1 font-mono text-[10px] text-muted-foreground">{formatMoneyCentsExact(account.actualCents[month])}</p></td>)}<td className="px-4 py-3 text-right"><p className="font-mono font-medium">{formatMoneyCentsExact(annualBudget)}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">{formatMoneyCentsExact(annualActual)}</p></td></tr>; })}</tbody><tfoot><tr className="bg-muted/30 font-medium"><td className="sticky left-0 bg-muted/30 px-4 py-3">Total budget / actual</td>{MONTHS.map((_, month) => <td key={month} className="px-2 py-3 text-right"><p className="font-mono">{formatMoneyCentsExact(totals.budget[month])}</p><p className="font-mono text-[10px] text-muted-foreground">{formatMoneyCentsExact(totals.actual[month])}</p></td>)}<td className="px-4 py-3 text-right font-mono">{formatMoneyCentsExact(totals.budget.reduce((a, b) => a + b, 0))}</td></tr></tfoot></table></div>
    </section>
  );
}
