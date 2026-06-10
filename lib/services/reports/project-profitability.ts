import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import { getOrgBilling } from "@/lib/services/orgs"

export type ProfitabilityBasis = "accrual" | "cash"

/** How cost-of-work lines are grouped: by cost-code category, or by the QBO expense account on the source bill/expense. */
export type ProfitabilityGroupBy = "category" | "account"

export type ProfitabilityLine = {
  key: string
  label: string
  amount_cents: number
  /** Project budget for this line (cost sections only). */
  budget_cents?: number | null
  /** budget_cents - amount_cents (positive = under budget). */
  variance_cents?: number | null
  /** Share of total income, 0-1. */
  pct_of_income: number
}

export type ProfitabilitySection = {
  key: string
  label: string
  lines: ProfitabilityLine[]
  total_cents: number
  budget_total_cents?: number | null
  variance_total_cents?: number | null
}

export type ProjectProfitabilityReport = {
  project_id: string
  project_name: string
  org_name: string | null
  org_logo_url: string | null
  basis: ProfitabilityBasis
  from: string | null
  to: string | null
  generated_at: string
  group_by: ProfitabilityGroupBy
  /** What the data suggests is the most useful grouping (low cost-code coverage → "account"). */
  suggested_group_by: ProfitabilityGroupBy
  income: ProfitabilitySection
  cost_of_work: ProfitabilitySection
  gross_profit_cents: number
  gross_margin_percent: number
  // Headline + KPIs (the "one-up" over a flat P&L)
  total_income_cents: number
  total_cost_cents: number
  net_profit_cents: number
  net_margin_percent: number
  contract_value_cents: number | null
  budget_total_cents: number
  budgeted_margin_percent: number | null
  percent_billed: number | null
  percent_budget_spent: number | null
}

const INCOME_SOURCE_LABELS: Record<string, string> = {
  draw: "Progress draws",
  change_order: "Change orders",
  manual: "Direct billings",
  retainage: "Retainage",
}

function incomeSourceLabel(sourceType: string | null | undefined): { key: string; label: string } {
  const key = (sourceType ?? "manual").toLowerCase()
  return { key, label: INCOME_SOURCE_LABELS[key] ?? "Other billings" }
}

function marginPercent(profitCents: number, incomeCents: number): number {
  if (incomeCents <= 0) return 0
  return Math.round((profitCents / incomeCents) * 1000) / 10
}

function inDateRange(value: string | null | undefined, from: string | null, to: string | null): boolean {
  if (!value) return from === null && to === null ? true : false
  const date = value.slice(0, 10)
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

export async function getProjectProfitabilityReport({
  projectId,
  basis = "accrual",
  from = null,
  to = null,
  groupBy,
  orgId,
}: {
  projectId: string
  basis?: ProfitabilityBasis
  from?: string | null
  to?: string | null
  groupBy?: ProfitabilityGroupBy
  orgId?: string
}): Promise<ProjectProfitabilityReport> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId: resolvedOrgId,
    supabase,
    resourceType: "project",
    resourceId: projectId,
  })

  const [projectResult, invoicesResult, jobCostResult, budgetData, orgBilling] = await Promise.all([
    supabase.from("projects").select("id, name").eq("org_id", resolvedOrgId).eq("id", projectId).maybeSingle(),
    supabase
      .from("invoices")
      .select("id, status, total_cents, balance_due_cents, issue_date, created_at, metadata")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId),
    supabase
      .from("job_cost_entries")
      .select("cost_code_id, source_type, source_id, cost_cents, status, incurred_on, metadata")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .eq("status", "posted"),
    getBudgetWithActuals(projectId, resolvedOrgId).catch(() => null),
    getOrgBilling().catch(() => null),
  ])

  if (projectResult.error) throw new Error(`Failed to load project: ${projectResult.error.message}`)
  if (!projectResult.data) throw new Error("Project not found")
  if (invoicesResult.error) throw new Error(`Failed to load invoices: ${invoicesResult.error.message}`)
  if (jobCostResult.error) throw new Error(`Failed to load job-cost actuals: ${jobCostResult.error.message}`)

  const projectName = projectResult.data.name as string
  const orgName = (orgBilling?.org?.name as string | undefined) ?? null
  const orgLogoUrl = (orgBilling?.org?.logo_url as string | undefined) ?? null

  // ---- Income ----------------------------------------------------------------
  const incomeBySource = new Map<string, { label: string; amount_cents: number }>()
  for (const invoice of invoicesResult.data ?? []) {
    if (["draft", "saved", "void"].includes(String(invoice.status))) continue
    const billedDate = (invoice.issue_date ?? invoice.created_at) as string | null
    if (!inDateRange(billedDate, from, to)) continue
    const total = Number(invoice.total_cents ?? 0)
    const amount = basis === "cash" ? total - Number(invoice.balance_due_cents ?? 0) : total
    if (amount === 0) continue
    const { key, label } = incomeSourceLabel((invoice.metadata as any)?.source_type)
    const existing = incomeBySource.get(key) ?? { label, amount_cents: 0 }
    existing.amount_cents += Math.round(amount)
    incomeBySource.set(key, existing)
  }

  const totalIncomeCents = Array.from(incomeBySource.values()).reduce((sum, l) => sum + l.amount_cents, 0)

  const incomeLines: ProfitabilityLine[] = Array.from(incomeBySource.entries())
    .map(([key, line]) => ({
      key,
      label: line.label,
      amount_cents: line.amount_cents,
      pct_of_income: totalIncomeCents > 0 ? line.amount_cents / totalIncomeCents : 0,
    }))
    .sort((a, b) => b.amount_cents - a.amount_cents)

  // ---- Cost of Work ----------------------------------------------------------
  // De-dupe job-cost entries by source so a single bill line isn't counted twice.
  type CostEntry = {
    costCodeId: string | null
    amountCents: number
    sourceType: string | null
    sourceId: string | null
    metadata: Record<string, any>
  }
  const seenSources = new Set<string>()
  const costEntries: CostEntry[] = []
  for (const entry of jobCostResult.data ?? []) {
    if (!inDateRange(entry.incurred_on as string | null, from, to)) continue
    if (entry.source_type && entry.source_id) {
      const sourceKey = `${entry.source_type}:${entry.source_id}`
      if (seenSources.has(sourceKey)) continue
      seenSources.add(sourceKey)
    }
    costEntries.push({
      costCodeId: (entry.cost_code_id as string | null) ?? null,
      amountCents: Math.round(Number(entry.cost_cents ?? 0)),
      sourceType: (entry.source_type as string | null) ?? null,
      sourceId: (entry.source_id as string | null) ?? null,
      metadata: (entry.metadata as Record<string, any> | null) ?? {},
    })
  }

  // Cost-code metadata for every code referenced by actuals or the budget.
  const codeIdSet = new Set<string>()
  for (const e of costEntries) if (e.costCodeId) codeIdSet.add(e.costCodeId)
  for (const row of (budgetData?.breakdown ?? []) as any[]) if (row.cost_code_id) codeIdSet.add(String(row.cost_code_id))
  const codeIds = Array.from(codeIdSet)

  // QBO expense-account names for the entries' source bills/expenses. Used when a
  // cost has no cost code, or when the whole report is grouped by account.
  const billIds = new Set<string>()
  const expenseIds = new Set<string>()
  for (const e of costEntries) {
    if (e.sourceType === "vendor_bill_line" && e.metadata?.bill_id) billIds.add(String(e.metadata.bill_id))
    else if (e.sourceType === "project_expense" && e.sourceId) expenseIds.add(e.sourceId)
  }

  const [costCodesResult, billAccountsResult, expenseAccountsResult] = await Promise.all([
    codeIds.length === 0
      ? Promise.resolve({ data: [] as any[], error: null })
      : supabase.from("cost_codes").select("id, code, name, category, division").eq("org_id", resolvedOrgId).in("id", codeIds),
    billIds.size === 0
      ? Promise.resolve({ data: [] as any[], error: null })
      : supabase.from("vendor_bills").select("id, qbo_expense_account_name").eq("org_id", resolvedOrgId).in("id", Array.from(billIds)),
    expenseIds.size === 0
      ? Promise.resolve({ data: [] as any[], error: null })
      : supabase
          .from("project_expenses")
          .select("id, qbo_expense_account_name")
          .eq("org_id", resolvedOrgId)
          .in("id", Array.from(expenseIds)),
  ])

  if ((costCodesResult as any).error) throw new Error(`Failed to load cost codes: ${(costCodesResult as any).error.message}`)

  const costCodeMeta = new Map<string, { category: string | null; division: string | null }>()
  for (const code of (costCodesResult as any).data ?? []) {
    costCodeMeta.set(code.id, { category: code.category ?? null, division: code.division ?? null })
  }
  const billAccountById = new Map<string, string | null>()
  for (const b of (billAccountsResult as any).data ?? []) billAccountById.set(b.id, b.qbo_expense_account_name ?? null)
  const expenseAccountById = new Map<string, string | null>()
  for (const x of (expenseAccountsResult as any).data ?? []) expenseAccountById.set(x.id, x.qbo_expense_account_name ?? null)

  function categoryForCode(codeId: string): { key: string; label: string } {
    const meta = costCodeMeta.get(codeId)
    const category = meta?.category?.trim()
    if (category) return { key: `cat:${category.toLowerCase()}`, label: titleCase(category) }
    const division = meta?.division?.trim()
    if (division) return { key: `div:${division}`, label: `Division ${division}` }
    return { key: "other", label: "Other costs" }
  }

  function accountNameForEntry(e: CostEntry): string | null {
    if (e.sourceType === "vendor_bill_line") {
      const billName = e.metadata?.bill_id ? billAccountById.get(String(e.metadata.bill_id)) : null
      return billName ?? (e.metadata?.qbo_expense_account_name as string | undefined) ?? null
    }
    if (e.sourceType === "project_expense") {
      return (e.sourceId ? expenseAccountById.get(e.sourceId) : null) ?? null
    }
    return null
  }

  function accountGroupFor(e: CostEntry): { key: string; label: string } {
    const account = accountNameForEntry(e)?.trim()
    if (account) return { key: `acct:${account.toLowerCase()}`, label: account }
    if (e.sourceType === "time_entry") return { key: "labor", label: "Labor" }
    return { key: "uncategorized", label: "Uncategorized costs" }
  }

  // Suggest account grouping when most cost dollars aren't assigned to a cost code.
  const totalActualForRatio = costEntries.reduce((sum, e) => sum + e.amountCents, 0)
  const codedActual = costEntries.reduce((sum, e) => sum + (e.costCodeId ? e.amountCents : 0), 0)
  const suggestedGroupBy: ProfitabilityGroupBy =
    totalActualForRatio > 0 && codedActual / totalActualForRatio < 0.5 ? "account" : "category"
  const effectiveGroupBy: ProfitabilityGroupBy = groupBy ?? suggestedGroupBy

  // In category mode coded entries roll up by cost-code category and uncoded
  // entries fall back to their QBO account; account mode groups everything by account.
  const costByGroup = new Map<string, { label: string; amount_cents: number }>()
  for (const e of costEntries) {
    const group =
      effectiveGroupBy === "account" ? accountGroupFor(e) : e.costCodeId ? categoryForCode(e.costCodeId) : accountGroupFor(e)
    const existing = costByGroup.get(group.key) ?? { label: group.label, amount_cents: 0 }
    existing.amount_cents += e.amountCents
    costByGroup.set(group.key, existing)
  }

  // Budget per group — only meaningful when grouping by cost-code category.
  const budgetByGroup = new Map<string, number>()
  if (effectiveGroupBy === "category") {
    for (const row of (budgetData?.breakdown ?? []) as any[]) {
      if (!row.cost_code_id) continue
      const { key } = categoryForCode(String(row.cost_code_id))
      budgetByGroup.set(key, (budgetByGroup.get(key) ?? 0) + Number(row.adjusted_budget_cents ?? 0))
    }
  }

  const totalCostCents = Array.from(costByGroup.values()).reduce((sum, l) => sum + l.amount_cents, 0)

  const costLines: ProfitabilityLine[] = Array.from(costByGroup.entries())
    .map(([key, line]) => {
      const budget = budgetByGroup.get(key)
      const budgetCents = typeof budget === "number" ? budget : null
      return {
        key,
        label: line.label,
        amount_cents: line.amount_cents,
        budget_cents: budgetCents,
        variance_cents: budgetCents != null ? budgetCents - line.amount_cents : null,
        pct_of_income: totalIncomeCents > 0 ? line.amount_cents / totalIncomeCents : 0,
      }
    })
    .sort((a, b) => b.amount_cents - a.amount_cents)

  const budgetTotalCents = Number(budgetData?.summary?.adjusted_budget_cents ?? 0)
  const costBudgetTotalCents =
    effectiveGroupBy === "category" ? costLines.reduce((sum, l) => sum + (l.budget_cents ?? 0), 0) : 0

  // ---- Totals & KPIs ---------------------------------------------------------
  const grossProfitCents = totalIncomeCents - totalCostCents
  const netProfitCents = grossProfitCents

  const contractValueCents = await getContractValueCents(supabase, resolvedOrgId, projectId)

  const budgetedMarginPercent =
    contractValueCents && contractValueCents > 0 && budgetTotalCents > 0
      ? marginPercent(contractValueCents - budgetTotalCents, contractValueCents)
      : null

  return {
    project_id: projectId,
    project_name: projectName,
    org_name: orgName,
    org_logo_url: orgLogoUrl,
    basis,
    from,
    to,
    generated_at: new Date().toISOString(),
    group_by: effectiveGroupBy,
    suggested_group_by: suggestedGroupBy,
    income: {
      key: "income",
      label: "Income",
      lines: incomeLines,
      total_cents: totalIncomeCents,
    },
    cost_of_work: {
      key: "cost_of_work",
      label: "Cost of work",
      lines: costLines,
      total_cents: totalCostCents,
      budget_total_cents: costBudgetTotalCents || null,
      variance_total_cents: costBudgetTotalCents ? costBudgetTotalCents - totalCostCents : null,
    },
    gross_profit_cents: grossProfitCents,
    gross_margin_percent: marginPercent(grossProfitCents, totalIncomeCents),
    total_income_cents: totalIncomeCents,
    total_cost_cents: totalCostCents,
    net_profit_cents: netProfitCents,
    net_margin_percent: marginPercent(netProfitCents, totalIncomeCents),
    contract_value_cents: contractValueCents,
    budget_total_cents: budgetTotalCents,
    budgeted_margin_percent: budgetedMarginPercent,
    percent_billed:
      contractValueCents && contractValueCents > 0 ? Math.round((totalIncomeCents / contractValueCents) * 1000) / 10 : null,
    percent_budget_spent: budgetTotalCents > 0 ? Math.round((totalCostCents / budgetTotalCents) * 1000) / 10 : null,
  }
}

async function getContractValueCents(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  projectId: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("contracts")
    .select("total_cents, snapshot, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("status", { ascending: true })
    .limit(5)

  if (!data || data.length === 0) return null
  const active = data.find((c: any) => c.status === "active") ?? data[0]
  const revised = (active as any)?.snapshot?.revised_total_cents
  return Number(revised ?? (active as any)?.total_cents ?? 0) || null
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}
