import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireAuthorization } from "@/lib/services/authorization";
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
  const start = `${input.fiscalYear}-01-01`;
  const end = `${input.fiscalYear}-12-31`;
  const [accountResult, budgetResult, actualResult] = await Promise.all([
    service.from("gl_accounts").select("id,code,name").eq("org_id", context.orgId).eq("account_type", "expense").eq("active", true).order("code"),
    service.from("books_overhead_budgets").select("id,name,status,notes,lines:books_overhead_budget_lines(account_id,month_start,budget_cents,notes)").eq("org_id", context.orgId).eq("fiscal_year", input.fiscalYear).order("status", { ascending: true }).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    service.from("journal_lines").select("account_id,debit_cents,credit_cents,entry:journal_entries!inner(entry_date,status)").eq("org_id", context.orgId).is("project_id", null).eq("entry.status", "posted").gte("entry.entry_date", start).lte("entry.entry_date", end).limit(10000),
  ]);
  if (accountResult.error) throw new Error(`Failed to load overhead accounts: ${accountResult.error.message}`);
  if (budgetResult.error) throw new Error(`Failed to load overhead budget: ${budgetResult.error.message}`);
  if (actualResult.error) throw new Error(`Failed to load overhead actuals: ${actualResult.error.message}`);
  const accountIds = new Set((accountResult.data ?? []).map((account) => account.id));
  const actuals: Record<string, number[]> = {};
  for (const line of actualResult.data ?? []) {
    if (!accountIds.has(line.account_id)) continue;
    const entry = Array.isArray(line.entry) ? line.entry[0] : line.entry;
    if (!entry) continue;
    const month = Number(String(entry.entry_date).slice(5, 7)) - 1;
    actuals[line.account_id] ??= Array(12).fill(0);
    actuals[line.account_id][month] += Number(line.debit_cents) - Number(line.credit_cents);
  }
  const budget = budgetResult.data;
  const budgetLines: Record<string, number[]> = {};
  for (const line of budget?.lines ?? []) {
    const month = Number(String(line.month_start).slice(5, 7)) - 1;
    budgetLines[line.account_id] ??= Array(12).fill(0);
    budgetLines[line.account_id][month] = Number(line.budget_cents);
  }
  return {
    fiscalYear: input.fiscalYear,
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
  const payload = input.lines.map((line) => ({ account_id: line.accountId, month_start: `${input.fiscalYear}-${String(line.month + 1).padStart(2, "0")}-01`, budget_cents: line.budgetCents }));
  const service = createServiceSupabaseClient();
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
