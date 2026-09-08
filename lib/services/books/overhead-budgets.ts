import "server-only";
import { fiscalYearRange } from "@/lib/services/books/fiscal-calendar";
import { buildProfitAndLoss, loadPostedLedger } from "@/lib/services/books/statements";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { requireOrgContext } from "@/lib/services/context";
import { recordAudit } from "@/lib/services/audit";

async function requireOverheadContext(permission: "books.read" | "books.adjust", orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({ permission, userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "books_overhead_budget", resourceId: context.orgId, logDecision: permission !== "books.read" });
  return context;
}

export async function getOverheadBudgetWorkspace(input: { fiscalYear: number; orgId?: string }) {
  const context = await requireOverheadContext("books.read", input.orgId);
  const service = createServiceSupabaseClient();
  const { data: settings, error: settingsError } = await service.from("books_settings").select("fiscal_year_start_month").eq("org_id", context.orgId).single();
  if (settingsError) throw new Error(`Failed to load fiscal calendar: ${settingsError.message}`);
  const range = fiscalYearRange(input.fiscalYear, Number(settings.fiscal_year_start_month));
  const [accountResult, budgetResult, snapshot] = await Promise.all([
    service.from("gl_accounts").select("id,code,name").eq("org_id", context.orgId).eq("account_type", "expense").eq("active", true).order("code"),
    service.from("books_overhead_budgets").select("id,name,status,notes,lines:books_overhead_budget_lines(account_id,month_start,budget_cents,notes)").eq("org_id", context.orgId).eq("fiscal_year", input.fiscalYear).order("status", { ascending: true }).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    loadPostedLedger(context.orgId, range.endDate),
  ]);
  if (accountResult.error) throw new Error(`Failed to load overhead accounts: ${accountResult.error.message}`);
  if (budgetResult.error) throw new Error(`Failed to load overhead budget: ${budgetResult.error.message}`);
  const actuals: Record<string, number[]> = {};
  const overhead = { ...snapshot, lines: snapshot.lines.filter((line) => line.project_id === null) };
  const months = await Promise.all(range.months.map(async (start, index) => {
    const end = index === 11 ? range.endDate : new Date(new Date(`${range.months[index + 1]}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
    return buildProfitAndLoss(context.orgId, start, end, overhead);
  }));
  for (const [month, report] of months.entries()) for (const row of report.rows) {
    if (row.accountType !== "expense") continue;
    actuals[row.accountId] ??= Array(12).fill(0);
    actuals[row.accountId][month] = row.balanceCents;
  }
  const budget = budgetResult.data;
  const budgetLines: Record<string, number[]> = {};
  for (const line of budget?.lines ?? []) {
    const month = range.months.indexOf(String(line.month_start));
    if (month < 0) continue;
    budgetLines[line.account_id] ??= Array(12).fill(0);
    budgetLines[line.account_id][month] = Number(line.budget_cents);
  }
  return {
    fiscalYear: input.fiscalYear,
    monthStarts: range.months,
    budget: budget ? { id: budget.id, name: budget.name, status: budget.status, notes: budget.notes } : null,
    accounts: (accountResult.data ?? []).map((account) => ({ ...account, budgetCents: budgetLines[account.id] ?? Array(12).fill(0), actualCents: actuals[account.id] ?? Array(12).fill(0) })),
  };
}

export async function saveOverheadBudget(input: {
  budgetId?: string | null;
  fiscalYear: number;
  name: string;
  status: "draft" | "active" | "archived";
  notes?: string | null;
  lines: Array<{ accountId: string; month: number; budgetCents: number }>;
  orgId?: string;
}) {
  const context = await requireOverheadContext("books.adjust", input.orgId);
  const service = createServiceSupabaseClient();
  const { data: settings, error: settingsError } = await service.from("books_settings").select("fiscal_year_start_month").eq("org_id", context.orgId).single();
  if (settingsError) throw new Error(`Failed to load fiscal calendar: ${settingsError.message}`);
  const range = fiscalYearRange(input.fiscalYear, Number(settings.fiscal_year_start_month));
  const payload = input.lines.map((line) => {
    if (!Number.isInteger(line.month) || line.month < 0 || line.month > 11) throw new Error("Invalid fiscal month");
    return { account_id: line.accountId, month_start: range.months[line.month], budget_cents: line.budgetCents };
  });
  const { data, error } = await service.rpc("replace_books_overhead_budget_atomic", {
    p_org_id: context.orgId,
    p_budget_id: input.budgetId ?? null,
    p_name: input.name,
    p_fiscal_year: input.fiscalYear,
    p_status: input.status,
    p_notes: input.notes ?? null,
    p_lines: payload,
    p_actor_id: context.userId,
  });
  if (error) throw new Error(`Failed to save overhead budget: ${error.message}`);
  const budgetId = String(data);
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.budgetId ? "update" : "insert", entityType: "books_overhead_budget", entityId: budgetId, after: { fiscal_year: input.fiscalYear, name: input.name, status: input.status, line_count: payload.length }, source: "books.overhead" });
  return budgetId;
}
