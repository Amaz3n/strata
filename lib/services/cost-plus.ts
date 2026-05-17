import { getBudgetWithActuals } from "@/lib/services/budgets"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createHash, randomBytes, randomUUID } from "crypto"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { sendEmail } from "@/lib/services/mailer"
import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import { enqueueProjectExpenseSync } from "@/lib/services/qbo-sync"
import { requireAuthorization } from "@/lib/services/authorization"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { validatePortalToken } from "@/lib/services/portal-access"
import { supportsApprovedCostInvoicing } from "@/lib/financials/billing-model"
import {
  approvalDecisionSchema,
  generateInvoiceFromCostsInputSchema,
  markupRuleInputSchema,
  projectExpenseInputSchema,
  timeEntryInputSchema,
  timeEntryUpdateSchema,
  type GenerateInvoiceFromCostsInput,
  type MarkupRuleInput,
  type ProjectExpenseInput,
  type TimeEntryInput,
  type TimeEntryUpdateInput,
} from "@/lib/validation/cost-plus"

type MarkupSource = "line" | "cost_code" | "contract" | "org" | "default"
type CostSourceType = "vendor_bill_line" | "project_expense" | "time_entry" | "manual_adjustment" | "allowance_overage"

export interface BillableCost {
  id: string
  org_id: string
  project_id: string
  cost_code_id?: string | null
  cost_code_code?: string | null
  cost_code_name?: string | null
  source_type: CostSourceType
  source_id: string
  source_company_id?: string | null
  occurred_on: string
  description?: string | null
  cost_cents: number
  markup_percent_resolved: number
  markup_cents: number
  billable_cents: number
  is_billable: boolean
  invoice_id?: string | null
  invoice_line_id?: string | null
  billed_at?: string | null
  status: "open" | "locked" | "billed" | "excluded" | "voided"
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface InvoiceDraftLine {
  cost_code_id?: string | null
  cost_code_code?: string | null
  cost_code_name?: string | null
  description: string
  cost_cents: number
  markup_cents: number
  billable_cents: number
  markup_percent: number
  billable_cost_ids: string[]
}

export interface InvoiceDraft {
  projectId: string
  title: string
  issueDate: string
  dueDate: string
  groupBy: "cost_code" | "detail"
  lines: InvoiceDraftLine[]
  totals: {
    cost_cents: number
    markup_cents: number
    billable_cents: number
  }
}

export interface GenerateInvoiceFromCostsResult {
  invoiceId?: string
  invoicePreview: InvoiceDraft
  costCount: number
  totalCostCents: number
  totalMarkupCents: number
  totalBillableCents: number
  excludedCount: number
  warnings: Array<{ code: string; message: string; billableCostId?: string }>
}

export interface GMPSnapshot {
  contractId: string
  gmpCents: number
  costToDateCents: number
  committedCents: number
  forecastFinalCostCents: number
  burnPercent: number
  projectedSavingsCents: number
  ownerSharePct: number
  builderSharePct: number
  ownerSavingsCents: number
  builderSavingsCents: number
}

export interface MarkupRule {
  id: string
  org_id: string
  scope: "org" | "contract" | "cost_code"
  contract_id?: string | null
  contract_name?: string | null
  cost_code_id?: string | null
  cost_code_code?: string | null
  cost_code_name?: string | null
  markup_percent: number
  applies_to_category?: string | null
  effective_from?: string | null
  effective_to?: string | null
  created_at?: string
}

function toDateOnly(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString().slice(0, 10)
}

function addDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function calculateMarkupCents(costCents: number, percent: number) {
  return Math.round((costCents * percent) / 100)
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function mapBillableCost(row: any): BillableCost {
  const costCode = row.cost_code ?? {}
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    cost_code_id: row.cost_code_id ?? null,
    cost_code_code: costCode.code ?? null,
    cost_code_name: costCode.name ?? null,
    source_type: row.source_type,
    source_id: row.source_id,
    source_company_id: row.source_company_id ?? null,
    occurred_on: row.occurred_on,
    description: row.description ?? null,
    cost_cents: row.cost_cents ?? 0,
    markup_percent_resolved: Number(row.markup_percent_resolved ?? 0),
    markup_cents: row.markup_cents ?? 0,
    billable_cents: row.billable_cents ?? (row.cost_cents ?? 0) + (row.markup_cents ?? 0),
    is_billable: row.is_billable !== false,
    invoice_id: row.invoice_id ?? null,
    invoice_line_id: row.invoice_line_id ?? null,
    billed_at: row.billed_at ?? null,
    status: row.status ?? "open",
    metadata: row.metadata ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapMarkupRule(row: any): MarkupRule {
  return {
    id: row.id,
    org_id: row.org_id,
    scope: row.scope,
    contract_id: row.contract_id ?? null,
    contract_name: row.contract?.title ?? null,
    cost_code_id: row.cost_code_id ?? null,
    cost_code_code: row.cost_code?.code ?? null,
    cost_code_name: row.cost_code?.name ?? null,
    markup_percent: Number(row.markup_percent ?? 0),
    applies_to_category: row.applies_to_category ?? null,
    effective_from: row.effective_from ?? null,
    effective_to: row.effective_to ?? null,
    created_at: row.created_at,
  }
}

export async function listMarkupRules(orgId?: string): Promise<MarkupRule[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "org.member",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "markup_rule",
  })

  const { data, error } = await supabase
    .from("markup_rules")
    .select("*, contract:contracts(id, title), cost_code:cost_codes(id, code, name)")
    .eq("org_id", resolvedOrgId)
    .order("scope", { ascending: true })
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load markup rules: ${error.message}`)
  return (data ?? []).map(mapMarkupRule)
}

export async function createMarkupRule(input: MarkupRuleInput, orgId?: string): Promise<MarkupRule> {
  const parsed = markupRuleInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "org.admin",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "markup_rule",
  })

  const payload = {
    org_id: resolvedOrgId,
    scope: parsed.scope,
    contract_id: parsed.scope === "contract" ? parsed.contractId : null,
    cost_code_id: parsed.scope === "cost_code" ? parsed.costCodeId : null,
    markup_percent: parsed.markupPercent,
    applies_to_category: parsed.appliesToCategory ?? null,
    effective_from: parsed.effectiveFrom ? toDateOnly(parsed.effectiveFrom) : null,
    effective_to: parsed.effectiveTo ? toDateOnly(parsed.effectiveTo) : null,
  }

  const { data, error } = await supabase
    .from("markup_rules")
    .insert(payload)
    .select("*, contract:contracts(id, title), cost_code:cost_codes(id, code, name)")
    .single()

  if (error || !data) throw new Error(`Failed to create markup rule: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "markup_rule", entityId: data.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "markup_rule_created", entityType: "markup_rule", entityId: data.id, payload: { scope: parsed.scope } })
  return mapMarkupRule(data)
}

export async function deleteMarkupRule(ruleId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "org.admin",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "markup_rule",
    resourceId: ruleId,
  })

  const { data: before, error: beforeError } = await supabase
    .from("markup_rules")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", ruleId)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Markup rule not found")

  const { error } = await supabase.from("markup_rules").delete().eq("org_id", resolvedOrgId).eq("id", ruleId)
  if (error) throw new Error(`Failed to delete markup rule: ${error.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "delete", entityType: "markup_rule", entityId: ruleId, before })
}

async function requireProjectFinancialAccess({
  supabase,
  orgId,
  userId,
  projectId,
  permission = "invoice.write",
}: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  permission?: string
}) {
  await requireAuthorization({
    permission,
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })
}

async function getProjectCostContract(supabase: SupabaseClient, orgId: string, projectId: string) {
  const { data, error } = await supabase
    .from("contracts")
    .select("id, contract_type, markup_percent, gmp_cents, savings_split_owner_pct, savings_split_builder_pct, labor_burden_multiplier, requires_client_cost_approval, open_book, snapshot")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Failed to load contract: ${error.message}`)
  return data as any | null
}

function isCostPlusContract(contract: any | null) {
  return supportsApprovedCostInvoicing(contract as any)
}

async function ensureAllowanceOverageBillableCosts({
  supabase,
  orgId,
  projectId,
  contractId,
  occurredOn,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  contractId: string | null
  occurredOn: Date
}) {
  const { data: allowances, error } = await supabase
    .from("allowances")
    .select("id, name, budget_cents, used_cents, overage_handling")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .gt("used_cents", 0)

  if (error) throw new Error(`Failed to load allowances: ${error.message}`)

  for (const allowance of allowances ?? []) {
    const overageCents = Number(allowance.used_cents ?? 0) - Number(allowance.budget_cents ?? 0)
    if (overageCents <= 0) continue
    if (allowance.overage_handling === "absorb" || allowance.overage_handling === "client_direct") continue

    const markup = await resolveMarkupPercent({
      supabase,
      orgId,
      contractId,
      costCodeId: null,
      occurredOn,
    })
    const payload = {
      org_id: orgId,
      project_id: projectId,
      cost_code_id: null,
      source_type: "allowance_overage",
      source_id: allowance.id,
      source_company_id: null,
      occurred_on: toDateOnly(occurredOn),
      description: `Allowance overage: ${allowance.name ?? "Allowance"}`,
      cost_cents: overageCents,
      markup_percent_resolved: markup.percent,
      markup_cents: calculateMarkupCents(overageCents, markup.percent),
      is_billable: true,
      status: "open",
      metadata: {
        allowance_id: allowance.id,
        allowance_name: allowance.name ?? null,
        allowance_budget_cents: allowance.budget_cents ?? 0,
        allowance_used_cents: allowance.used_cents ?? 0,
        markup_source: markup.source,
      },
    }

    const { data: existing, error: existingError } = await supabase
      .from("billable_costs")
      .select("id, status")
      .eq("org_id", orgId)
      .eq("source_type", "allowance_overage")
      .eq("source_id", allowance.id)
      .neq("status", "voided")
      .maybeSingle()

    if (existingError) throw new Error(`Failed to load allowance overage ledger row: ${existingError.message}`)
    if (existing?.status === "open") {
      const { error: updateError } = await supabase
        .from("billable_costs")
        .update(payload)
        .eq("org_id", orgId)
        .eq("id", existing.id)
      if (updateError) throw new Error(`Failed to update allowance overage ledger row: ${updateError.message}`)
      continue
    }
    if (existing) continue

    await insertOrReturnBillableCost(
      supabase,
      orgId,
      payload,
      "allowance_overage",
    )
  }
}

export async function resolveMarkupPercent(args: {
  supabase: SupabaseClient
  orgId: string
  contractId: string | null
  costCodeId: string | null
  costCodeCategory?: string | null
  occurredOn: Date
  lineOverride?: number | null
}): Promise<{ percent: number; source: MarkupSource }> {
  if (typeof args.lineOverride === "number" && Number.isFinite(args.lineOverride)) {
    return { percent: args.lineOverride, source: "line" }
  }

  const occurredOn = toDateOnly(args.occurredOn)

  if (args.costCodeId) {
    const { data: costCode, error } = await args.supabase
      .from("cost_codes")
      .select("default_markup_percent, category")
      .eq("org_id", args.orgId)
      .eq("id", args.costCodeId)
      .maybeSingle()

    if (error) throw new Error(`Failed to load cost code markup: ${error.message}`)
    if (typeof costCode?.default_markup_percent === "number") {
      return { percent: Number(costCode.default_markup_percent), source: "cost_code" }
    }
  }

  const ruleSelect = "scope, markup_percent, applies_to_category"
  if (args.costCodeId) {
    const { data: rule, error } = await args.supabase
      .from("markup_rules")
      .select(ruleSelect)
      .eq("org_id", args.orgId)
      .eq("scope", "cost_code")
      .eq("cost_code_id", args.costCodeId)
      .or(`effective_from.is.null,effective_from.lte.${occurredOn}`)
      .or(`effective_to.is.null,effective_to.gte.${occurredOn}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw new Error(`Failed to resolve cost code markup: ${error.message}`)
    if (rule && (!rule.applies_to_category || rule.applies_to_category === args.costCodeCategory)) {
      return { percent: Number(rule.markup_percent), source: "cost_code" }
    }
  }

  if (args.contractId) {
    const { data: rule, error } = await args.supabase
      .from("markup_rules")
      .select(ruleSelect)
      .eq("org_id", args.orgId)
      .eq("scope", "contract")
      .eq("contract_id", args.contractId)
      .or(`effective_from.is.null,effective_from.lte.${occurredOn}`)
      .or(`effective_to.is.null,effective_to.gte.${occurredOn}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw new Error(`Failed to resolve contract markup: ${error.message}`)
    if (rule && (!rule.applies_to_category || rule.applies_to_category === args.costCodeCategory)) {
      return { percent: Number(rule.markup_percent), source: "contract" }
    }

    const { data: contract, error: contractError } = await args.supabase
      .from("contracts")
      .select("markup_percent")
      .eq("org_id", args.orgId)
      .eq("id", args.contractId)
      .maybeSingle()

    if (contractError) throw new Error(`Failed to load contract markup: ${contractError.message}`)
    if (typeof contract?.markup_percent === "number") {
      return { percent: Number(contract.markup_percent), source: "contract" }
    }
  }

  const { data: orgRule, error: orgRuleError } = await args.supabase
    .from("markup_rules")
    .select(ruleSelect)
    .eq("org_id", args.orgId)
    .eq("scope", "org")
    .or(`effective_from.is.null,effective_from.lte.${occurredOn}`)
    .or(`effective_to.is.null,effective_to.gte.${occurredOn}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (orgRuleError) throw new Error(`Failed to resolve org markup: ${orgRuleError.message}`)
  if (orgRule && (!orgRule.applies_to_category || orgRule.applies_to_category === args.costCodeCategory)) {
    return { percent: Number(orgRule.markup_percent), source: "org" }
  }

  return { percent: 0, source: "default" }
}

async function insertOrReturnBillableCost(
  supabase: SupabaseClient,
  orgId: string,
  payload: Record<string, any>,
  sourceLabel: CostSourceType,
) {
  const { data, error } = await supabase
    .from("billable_costs")
    .insert(payload)
    .select("*, cost_code:cost_codes(code, name)")
    .single()

  if (!error && data) {
    await recordEvent({
      orgId,
      eventType: "cost_ledger_row_created",
      entityType: "billable_cost",
      entityId: data.id,
      payload: { source_type: sourceLabel, cost_cents: data.cost_cents, project_id: data.project_id },
    })
    return mapBillableCost(data)
  }

  const duplicate = error?.code === "23505" || String(error?.message ?? "").toLowerCase().includes("duplicate")
  if (!duplicate) throw new Error(`Failed to create billable cost: ${error?.message}`)

  const { data: existing, error: existingError } = await supabase
    .from("billable_costs")
    .select("*, cost_code:cost_codes(code, name)")
    .eq("org_id", orgId)
    .eq("source_type", payload.source_type)
    .eq("source_id", payload.source_id)
    .neq("status", "voided")
    .maybeSingle()

  if (existingError || !existing) throw new Error(`Failed to load existing billable cost: ${existingError?.message}`)
  return mapBillableCost(existing)
}

export async function upsertBillableCostFromBillLine(args: { billLineId: string; orgId?: string }): Promise<BillableCost> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)

  const { data: line, error } = await supabase
    .from("bill_lines")
    .select(`
      id, org_id, bill_id, cost_code_id, description, quantity, unit_cost_cents,
      cost_code:cost_codes(id, category, is_reimbursable_default),
      bill:vendor_bills(id, org_id, project_id, bill_number, bill_date, status, commitment:commitments(company_id))
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", args.billLineId)
    .maybeSingle()

  if (error || !line) throw new Error("Bill line not found")
  const bill = (line as any).bill
  if (!bill?.project_id) throw new Error("Bill line is missing project context")

  const contract = await getProjectCostContract(supabase, resolvedOrgId, bill.project_id)
  if (!isCostPlusContract(contract)) throw new Error("Project contract is not cost-plus or T&M")

  const costCents = Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1))
  const markup = await resolveMarkupPercent({
    supabase,
    orgId: resolvedOrgId,
    contractId: contract.id,
    costCodeId: line.cost_code_id ?? null,
    costCodeCategory: (line as any).cost_code?.category ?? null,
    occurredOn: new Date(bill.bill_date ?? new Date()),
  })
  const isBillable = (line as any).cost_code?.is_reimbursable_default !== false

  return insertOrReturnBillableCost(
    supabase,
    resolvedOrgId,
    {
      org_id: resolvedOrgId,
      project_id: bill.project_id,
      cost_code_id: line.cost_code_id ?? null,
      source_type: "vendor_bill_line",
      source_id: line.id,
      source_company_id: bill.commitment?.company_id ?? null,
      occurred_on: bill.bill_date ?? toDateOnly(new Date()),
      description: line.description || `Bill ${bill.bill_number ?? ""}`.trim(),
      cost_cents: costCents,
      markup_percent_resolved: markup.percent,
      markup_cents: calculateMarkupCents(costCents, markup.percent),
      is_billable: isBillable,
      status: isBillable ? "open" : "excluded",
      metadata: { markup_source: markup.source, bill_id: bill.id, bill_number: bill.bill_number },
    },
    "vendor_bill_line",
  )
}

export async function upsertBillableCostFromExpense(args: { expenseId: string; orgId?: string }): Promise<BillableCost> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { data: expense, error } = await supabase
    .from("project_expenses")
    .select("*, cost_code:cost_codes(id, category, is_reimbursable_default)")
    .eq("org_id", resolvedOrgId)
    .eq("id", args.expenseId)
    .maybeSingle()

  if (error || !expense) throw new Error("Expense not found")
  if (expense.status !== "approved") throw new Error("Expense must be approved before it enters the ledger")

  const contract = await getProjectCostContract(supabase, resolvedOrgId, expense.project_id)
  if (!isCostPlusContract(contract)) throw new Error("Project contract is not cost-plus or T&M")

  const costCents = Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0)
  const markup = await resolveMarkupPercent({
    supabase,
    orgId: resolvedOrgId,
    contractId: contract.id,
    costCodeId: expense.cost_code_id ?? null,
    costCodeCategory: (expense as any).cost_code?.category ?? null,
    occurredOn: new Date(expense.expense_date),
    lineOverride: expense.markup_percent_override,
  })
  const isBillable = expense.is_billable !== false && (expense as any).cost_code?.is_reimbursable_default !== false

  const billable = await insertOrReturnBillableCost(
    supabase,
    resolvedOrgId,
    {
      org_id: resolvedOrgId,
      project_id: expense.project_id,
      cost_code_id: expense.cost_code_id ?? null,
      source_type: "project_expense",
      source_id: expense.id,
      source_company_id: expense.vendor_company_id ?? null,
      occurred_on: expense.expense_date,
      description: expense.description || expense.vendor_name_text || "Project expense",
      cost_cents: costCents,
      markup_percent_resolved: markup.percent,
      markup_cents: calculateMarkupCents(costCents, markup.percent),
      is_billable: isBillable,
      status: isBillable ? "open" : "excluded",
      metadata: { markup_source: markup.source, receipt_file_id: expense.receipt_file_id ?? null },
    },
    "project_expense",
  )

  await supabase.from("project_expenses").update({ billable_cost_id: billable.id }).eq("org_id", resolvedOrgId).eq("id", expense.id)
  return billable
}

export async function upsertBillableCostFromTimeEntry(args: { timeEntryId: string; orgId?: string }): Promise<BillableCost> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { data: entry, error } = await supabase
    .from("time_entries")
    .select("*, cost_code:cost_codes(id, category, is_reimbursable_default)")
    .eq("org_id", resolvedOrgId)
    .eq("id", args.timeEntryId)
    .maybeSingle()

  if (error || !entry) throw new Error("Time entry not found")
  const contract = await getProjectCostContract(supabase, resolvedOrgId, entry.project_id)
  if (!isCostPlusContract(contract)) throw new Error("Project contract is not cost-plus or T&M")

  const requiredStatus = contract.requires_client_cost_approval ? "client_approved" : "pm_approved"
  if (entry.status !== requiredStatus) throw new Error("Time entry is not approved for billing")

  const costCents = Number(entry.cost_cents ?? 0)
  const markup = await resolveMarkupPercent({
    supabase,
    orgId: resolvedOrgId,
    contractId: contract.id,
    costCodeId: entry.cost_code_id ?? null,
    costCodeCategory: (entry as any).cost_code?.category ?? null,
    occurredOn: new Date(entry.work_date),
  })
  const isBillable = entry.is_billable !== false && (entry as any).cost_code?.is_reimbursable_default !== false

  const billable = await insertOrReturnBillableCost(
    supabase,
    resolvedOrgId,
    {
      org_id: resolvedOrgId,
      project_id: entry.project_id,
      cost_code_id: entry.cost_code_id ?? null,
      source_type: "time_entry",
      source_id: entry.id,
      source_company_id: entry.worker_company_id ?? null,
      occurred_on: entry.work_date,
      description: entry.notes || `${entry.worker_name} - ${entry.hours} hours`,
      cost_cents: costCents,
      markup_percent_resolved: markup.percent,
      markup_cents: calculateMarkupCents(costCents, markup.percent),
      is_billable: isBillable,
      status: isBillable ? "open" : "excluded",
      metadata: {
        markup_source: markup.source,
        worker_name: entry.worker_name,
        hours: entry.hours,
        base_rate_cents: entry.base_rate_cents,
        burden_multiplier: entry.burden_multiplier,
      },
    },
    "time_entry",
  )

  await supabase.from("time_entries").update({ billable_cost_id: billable.id }).eq("org_id", resolvedOrgId).eq("id", entry.id)
  return billable
}

export async function propagateApprovalToLedger(args: {
  source: "vendor_bill" | "project_expense" | "time_entry"
  sourceId: string
  orgId?: string
}): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)

  if (args.source === "vendor_bill") {
    const { data: lines, error } = await supabase
      .from("bill_lines")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("bill_id", args.sourceId)

    if (error) throw new Error(`Failed to load bill lines: ${error.message}`)
    for (const line of lines ?? []) {
      await upsertBillableCostFromBillLine({ billLineId: line.id, orgId: resolvedOrgId })
    }
    return
  }

  if (args.source === "project_expense") {
    await upsertBillableCostFromExpense({ expenseId: args.sourceId, orgId: resolvedOrgId })
    return
  }

  await upsertBillableCostFromTimeEntry({ timeEntryId: args.sourceId, orgId: resolvedOrgId })
}

export async function createTimeEntry(input: TimeEntryInput, orgId?: string) {
  const parsed = timeEntryInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: parsed.projectId, permission: "bill.write" })

  const contract = await getProjectCostContract(supabase, resolvedOrgId, parsed.projectId)
  let burdenMultiplier = parsed.burdenMultiplier ?? Number(contract?.labor_burden_multiplier ?? 1)
  let baseRateCents = parsed.baseRateCents ?? 0
  let isBillable = parsed.isBillable

  let workerName = parsed.workerName?.trim()
  let workerUserId = parsed.workerUserId ?? null
  if (!workerName) {
    workerUserId = workerUserId ?? userId
    const { data: profile } = await supabase
      .from("app_users")
      .select("full_name, email")
      .eq("id", workerUserId)
      .maybeSingle()
    workerName = profile?.full_name?.trim() || profile?.email || "Crew member"
  }

  if (workerUserId) {
    const { data: laborDefaults } = await supabase
      .from("memberships")
      .select("labor_cost_rate_cents, labor_burden_multiplier, labor_is_billable_default")
      .eq("org_id", resolvedOrgId)
      .eq("user_id", workerUserId)
      .maybeSingle()

    if (laborDefaults) {
      if (!baseRateCents) baseRateCents = laborDefaults.labor_cost_rate_cents ?? 0
      if (!parsed.burdenMultiplier || parsed.burdenMultiplier === 1) {
        burdenMultiplier = Number(laborDefaults.labor_burden_multiplier ?? burdenMultiplier)
      }
      if (input.isBillable === undefined) {
        isBillable = laborDefaults.labor_is_billable_default ?? true
      }
    }
  }

  const payload = {
    org_id: resolvedOrgId,
    project_id: parsed.projectId,
    cost_code_id: parsed.costCodeId ?? null,
    worker_user_id: workerUserId,
    worker_company_id: parsed.workerCompanyId ?? null,
    worker_name: workerName,
    work_date: toDateOnly(parsed.workDate),
    hours: parsed.hours,
    base_rate_cents: baseRateCents,
    burden_multiplier: burdenMultiplier,
    is_billable: isBillable,
    is_overtime: parsed.isOvertime,
    notes: parsed.notes ?? null,
    attached_file_ids: parsed.attachedFileIds ?? [],
    status: "submitted",
  }

  const { data, error } = await supabase.from("time_entries").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to create time entry: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "time_entry", entityId: data.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "time_entry_submitted", entityType: "time_entry", entityId: data.id, payload: { project_id: parsed.projectId, hours: parsed.hours } })
  return data
}

export async function updateTimeEntry(timeEntryId: string, input: TimeEntryUpdateInput, orgId?: string) {
  const parsed = timeEntryUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: before, error: beforeError } = await supabase
    .from("time_entries")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Time entry not found")
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: before.project_id, permission: "bill.approve" })

  const updates: Record<string, unknown> = {}
  if (parsed.costCodeId !== undefined) updates.cost_code_id = parsed.costCodeId ?? null
  if (parsed.baseRateCents !== undefined) updates.base_rate_cents = parsed.baseRateCents
  if (parsed.burdenMultiplier !== undefined) updates.burden_multiplier = parsed.burdenMultiplier
  if (parsed.isBillable !== undefined) updates.is_billable = parsed.isBillable
  if (parsed.isOvertime !== undefined) updates.is_overtime = parsed.isOvertime
  if (parsed.workerName !== undefined) updates.worker_name = parsed.workerName
  if (parsed.notes !== undefined) updates.notes = parsed.notes ?? null

  if (Object.keys(updates).length === 0) return before

  const { data, error } = await supabase
    .from("time_entries")
    .update(updates)
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)
    .select("*")
    .single()
  if (error || !data) throw new Error(`Failed to update time entry: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "time_entry", entityId: data.id, before, after: data })
  return data
}

export async function approveTimeEntry(timeEntryId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: before, error: beforeError } = await supabase
    .from("time_entries")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)
    .maybeSingle()

  if (beforeError || !before) throw new Error("Time entry not found")
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: before.project_id, permission: "bill.approve" })

  const contract = await getProjectCostContract(supabase, resolvedOrgId, before.project_id)
  const nextStatus = contract?.requires_client_cost_approval ? "pm_approved" : "pm_approved"
  const { data, error } = await supabase
    .from("time_entries")
    .update({ status: nextStatus, approved_by_pm_at: new Date().toISOString(), approved_by_pm_user_id: userId })
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)
    .select("*")
    .single()

  if (error || !data) throw new Error(`Failed to approve time entry: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "time_entry", entityId: data.id, before, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "time_entry_pm_approved", entityType: "time_entry", entityId: data.id, payload: { project_id: data.project_id } })

  if (!contract?.requires_client_cost_approval) {
    await propagateApprovalToLedger({ source: "time_entry", sourceId: data.id, orgId: resolvedOrgId })
  }
  return data
}

export async function rejectTimeEntry(timeEntryId: string, input: { rejectionReason?: string | null } = {}, orgId?: string) {
  const parsed = approvalDecisionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: before, error: beforeError } = await supabase
    .from("time_entries")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)
    .maybeSingle()

  if (beforeError || !before) throw new Error("Time entry not found")
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: before.project_id, permission: "bill.approve" })

  const { data, error } = await supabase
    .from("time_entries")
    .update({ status: "rejected", rejection_reason: parsed.rejectionReason ?? null })
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)
    .select("*")
    .single()

  if (error || !data) throw new Error(`Failed to reject time entry: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "time_entry", entityId: data.id, before, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "time_entry_rejected", entityType: "time_entry", entityId: data.id, payload: { project_id: data.project_id } })
  return data
}

export async function createTimeEntryApprovalLink(timeEntryId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: entry, error } = await supabase
    .from("time_entries")
    .select("id, project_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)
    .maybeSingle()

  if (error || !entry) throw new Error("Time entry not found")
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: entry.project_id, permission: "bill.approve" })

  if (!["submitted", "pm_approved"].includes(entry.status)) {
    throw new Error("Only submitted or PM-approved time entries can be sent for client approval")
  }

  const token = randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
  const { error: updateError } = await supabase
    .from("time_entries")
    .update({
      status: "pm_approved",
      approved_by_pm_at: new Date().toISOString(),
      approved_by_pm_user_id: userId,
      approval_token_hash: hashToken(token),
      approval_token_expires_at: expiresAt,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)

  if (updateError) throw new Error(`Failed to create approval link: ${updateError.message}`)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  return {
    token,
    expiresAt,
    url: appUrl ? `${appUrl}/api/time-entries/approve/${token}` : `/api/time-entries/approve/${token}`,
  }
}

export async function sendTimeEntryClientApprovalEmail(timeEntryId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: entry, error } = await supabase
    .from("time_entries")
    .select("id, project_id, worker_name, work_date, hours, notes, cost_cents, project:projects(name)")
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)
    .maybeSingle()

  if (error || !entry) throw new Error("Time entry not found")
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: entry.project_id, permission: "bill.approve" })

  const approval = await createTimeEntryApprovalLink(timeEntryId, resolvedOrgId)
  const { data: tokenRow } = await supabase
    .from("portal_access_tokens")
    .select("contact:contacts(email, full_name)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", entry.project_id)
    .eq("portal_type", "client")
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const contact = Array.isArray((tokenRow as any)?.contact) ? (tokenRow as any).contact[0] : (tokenRow as any)?.contact
  const recipientEmail = contact?.email
  if (!recipientEmail) {
    throw new Error("No client portal contact email found for this project")
  }

  const projectName = Array.isArray((entry as any).project) ? (entry as any).project[0]?.name : (entry as any).project?.name
  const amount = `$${(Number(entry.cost_cents ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const sent = await sendEmail({
    to: [recipientEmail],
    subject: `Approval needed: ${Number(entry.hours ?? 0).toFixed(2)} hours on ${projectName ?? "your project"}`,
    html: `
      <p>${contact?.full_name ? `Hi ${contact.full_name},` : "Hi,"}</p>
      <p>A time entry is ready for your approval.</p>
      <p><strong>Project:</strong> ${projectName ?? "Project"}<br/>
      <strong>Worker:</strong> ${entry.worker_name ?? "Crew time"}<br/>
      <strong>Date:</strong> ${entry.work_date}<br/>
      <strong>Hours:</strong> ${Number(entry.hours ?? 0).toFixed(2)}<br/>
      <strong>Cost:</strong> ${amount}</p>
      ${entry.notes ? `<p>${entry.notes}</p>` : ""}
      <p><a href="${approval.url}">Approve time entry</a></p>
    `,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "time_entry_client_approval_sent",
    entityType: "time_entry",
    entityId: timeEntryId,
    payload: { project_id: entry.project_id, sent_to: recipientEmail, delivered_to_provider: sent, expires_at: approval.expiresAt },
    channel: "notification",
  })

  return { ...approval, sent_to: recipientEmail, email_sent: sent }
}

export async function approveTimeEntryByToken(token: string) {
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(token)
  const { data: entry, error } = await supabase
    .from("time_entries")
    .select("*")
    .eq("approval_token_hash", tokenHash)
    .maybeSingle()

  if (error || !entry) throw new Error("Approval link is invalid")
  if (entry.approval_token_expires_at && new Date(entry.approval_token_expires_at) < new Date()) {
    throw new Error("Approval link has expired")
  }
  if (entry.status === "client_approved") return entry
  if (entry.status !== "pm_approved") throw new Error("Time entry is not ready for client approval")

  const { data, error: updateError } = await supabase
    .from("time_entries")
    .update({
      status: "client_approved",
      approved_by_client_at: new Date().toISOString(),
      approval_token_hash: null,
      approval_token_expires_at: null,
    })
    .eq("id", entry.id)
    .select("*")
    .single()

  if (updateError || !data) throw new Error(`Failed to approve time entry: ${updateError?.message}`)
  await recordEvent({
    orgId: data.org_id,
    eventType: "time_entry_client_approved",
    entityType: "time_entry",
    entityId: data.id,
    payload: { project_id: data.project_id },
  })
  await propagateApprovalToLedger({ source: "time_entry", sourceId: data.id, orgId: data.org_id })
  return data
}

export async function createProjectExpense(input: ProjectExpenseInput, orgId?: string) {
  const parsed = projectExpenseInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: parsed.projectId, permission: "bill.write" })

  const payload = {
    org_id: resolvedOrgId,
    project_id: parsed.projectId,
    cost_code_id: parsed.costCodeId ?? null,
    vendor_company_id: parsed.vendorCompanyId ?? null,
    vendor_name_text: parsed.vendorNameText ?? null,
    expense_date: toDateOnly(parsed.expenseDate),
    description: parsed.description ?? null,
    amount_cents: parsed.amountCents,
    tax_cents: parsed.taxCents ?? 0,
    payment_method: parsed.paymentMethod ?? null,
    receipt_file_id: parsed.receiptFileId ?? null,
    is_billable: parsed.isBillable,
    markup_percent_override: parsed.markupPercentOverride ?? null,
    qbo_transaction_type: parsed.qboTransactionType ?? null,
    qbo_expense_account_id: parsed.qboExpenseAccountId ?? null,
    qbo_expense_account_name: parsed.qboExpenseAccountName ?? null,
    qbo_payment_account_id: parsed.qboPaymentAccountId ?? null,
    qbo_payment_account_name: parsed.qboPaymentAccountName ?? null,
    qbo_ap_account_id: parsed.qboApAccountId ?? null,
    qbo_ap_account_name: parsed.qboApAccountName ?? null,
    submitted_by_user_id: userId,
    status: "submitted",
  }

  const { data, error } = await supabase.from("project_expenses").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to create project expense: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "project_expense", entityId: data.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "expense_submitted", entityType: "project_expense", entityId: data.id, payload: { project_id: parsed.projectId, amount_cents: parsed.amountCents } })
  return data
}

export async function approveProjectExpense(expenseId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: before, error: beforeError } = await supabase
    .from("project_expenses")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", expenseId)
    .maybeSingle()

  if (beforeError || !before) throw new Error("Expense not found")
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: before.project_id, permission: "bill.approve" })

  const { data, error } = await supabase
    .from("project_expenses")
    .update({ status: "approved", approved_by_pm_at: new Date().toISOString(), approved_by_pm_user_id: userId })
    .eq("org_id", resolvedOrgId)
    .eq("id", expenseId)
    .select("*")
    .single()

  if (error || !data) throw new Error(`Failed to approve expense: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "project_expense", entityId: data.id, before, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "expense_approved", entityType: "project_expense", entityId: data.id, payload: { project_id: data.project_id, amount_cents: data.amount_cents } })
  await propagateApprovalToLedger({ source: "project_expense", sourceId: data.id, orgId: resolvedOrgId })
  await enqueueProjectExpenseSync(data.id, resolvedOrgId)
  return data
}

export async function rejectProjectExpense(expenseId: string, input: { rejectionReason?: string | null } = {}, orgId?: string) {
  const parsed = approvalDecisionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: before, error: beforeError } = await supabase
    .from("project_expenses")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", expenseId)
    .maybeSingle()

  if (beforeError || !before) throw new Error("Expense not found")
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: before.project_id, permission: "bill.approve" })

  const { data, error } = await supabase
    .from("project_expenses")
    .update({ status: "rejected", rejection_reason: parsed.rejectionReason ?? null })
    .eq("org_id", resolvedOrgId)
    .eq("id", expenseId)
    .select("*")
    .single()

  if (error || !data) throw new Error(`Failed to reject expense: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "project_expense", entityId: data.id, before, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "expense_rejected", entityType: "project_expense", entityId: data.id, payload: { project_id: data.project_id } })
  return data
}

export async function createTimeEntryFromPortal({ token, input }: { token: string; input: TimeEntryInput }) {
  const portalToken = await validatePortalToken(token)
  if (!portalToken || portalToken.portal_type !== "sub" || !portalToken.company_id) {
    throw new Error("Invalid portal access")
  }
  const parsed = timeEntryInputSchema.parse({ ...input, projectId: portalToken.project_id })
  const supabase = createServiceSupabaseClient()
  const payload = {
    org_id: portalToken.org_id,
    project_id: portalToken.project_id,
    cost_code_id: parsed.costCodeId ?? null,
    worker_company_id: portalToken.company_id,
    worker_name: parsed.workerName,
    work_date: toDateOnly(parsed.workDate),
    hours: parsed.hours,
    base_rate_cents: parsed.baseRateCents,
    burden_multiplier: parsed.burdenMultiplier,
    is_billable: parsed.isBillable,
    is_overtime: parsed.isOvertime,
    notes: parsed.notes ?? null,
    attached_file_ids: parsed.attachedFileIds ?? [],
    status: "submitted",
    metadata: { submitted_via_portal: true, portal_token_id: portalToken.id },
  }
  const { data, error } = await supabase.from("time_entries").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to submit time entry: ${error?.message}`)
  await recordEvent({ orgId: portalToken.org_id, eventType: "time_entry_submitted", entityType: "time_entry", entityId: data.id, payload: { project_id: portalToken.project_id, via_portal: true } })
  return data
}

export async function createProjectExpenseFromPortal({ token, input }: { token: string; input: ProjectExpenseInput }) {
  const portalToken = await validatePortalToken(token)
  if (!portalToken || portalToken.portal_type !== "sub" || !portalToken.company_id) {
    throw new Error("Invalid portal access")
  }
  const parsed = projectExpenseInputSchema.parse({ ...input, projectId: portalToken.project_id, vendorCompanyId: portalToken.company_id })
  const supabase = createServiceSupabaseClient()
  const payload = {
    org_id: portalToken.org_id,
    project_id: portalToken.project_id,
    cost_code_id: parsed.costCodeId ?? null,
    vendor_company_id: portalToken.company_id,
    vendor_name_text: parsed.vendorNameText ?? null,
    expense_date: toDateOnly(parsed.expenseDate),
    description: parsed.description ?? null,
    amount_cents: parsed.amountCents,
    tax_cents: parsed.taxCents ?? 0,
    payment_method: parsed.paymentMethod ?? null,
    receipt_file_id: parsed.receiptFileId ?? null,
    is_billable: parsed.isBillable,
    markup_percent_override: parsed.markupPercentOverride ?? null,
    status: "submitted",
    metadata: { submitted_via_portal: true, portal_token_id: portalToken.id },
  }
  const { data, error } = await supabase.from("project_expenses").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to submit expense: ${error?.message}`)
  await recordEvent({ orgId: portalToken.org_id, eventType: "expense_submitted", entityType: "project_expense", entityId: data.id, payload: { project_id: portalToken.project_id, via_portal: true } })
  return data
}

export async function listCostPlusTabData(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId, permission: "invoice.read" })

  const [billableCosts, timeEntries, expenses, gmpSnapshot] = await Promise.all([
    supabase
      .from("billable_costs")
      .select("*, cost_code:cost_codes(code, name)")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .in("status", ["open", "excluded"])
      .order("occurred_on", { ascending: false }),
    supabase
      .from("time_entries")
      .select("*, cost_code:cost_codes(code, name)")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .order("work_date", { ascending: false })
      .limit(50),
    supabase
      .from("project_expenses")
      .select("*, cost_code:cost_codes(code, name), vendor_company:companies(name)")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .order("expense_date", { ascending: false })
      .limit(50),
    getGMPSnapshot(projectId, resolvedOrgId).catch(() => null),
  ])

  if (billableCosts.error) throw new Error(`Failed to load billable costs: ${billableCosts.error.message}`)
  if (timeEntries.error) throw new Error(`Failed to load time entries: ${timeEntries.error.message}`)
  if (expenses.error) throw new Error(`Failed to load expenses: ${expenses.error.message}`)

  return {
    billableCosts: (billableCosts.data ?? []).map(mapBillableCost),
    timeEntries: timeEntries.data ?? [],
    expenses: expenses.data ?? [],
    gmpSnapshot,
  }
}

export async function listOpenBookCostDetailsForInvoice({
  invoiceId,
  orgId,
  projectId,
}: {
  invoiceId: string
  orgId: string
  projectId: string
}) {
  const supabase = createServiceSupabaseClient()
  const contract = await getProjectCostContract(supabase, orgId, projectId)
  if (contract?.open_book === false) return []

  const { data, error } = await supabase
    .from("billable_costs")
    .select("*, cost_code:cost_codes(code, name), source_company:companies(name)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("invoice_id", invoiceId)
    .order("occurred_on", { ascending: true })

  if (error) throw new Error(`Failed to load invoice cost detail: ${error.message}`)

  const timeEntryIds = (data ?? []).filter((row: any) => row.source_type === "time_entry").map((row: any) => row.source_id)
  const expenseIds = (data ?? []).filter((row: any) => row.source_type === "project_expense").map((row: any) => row.source_id)
  const billLineIds = (data ?? []).filter((row: any) => row.source_type === "vendor_bill_line").map((row: any) => row.source_id)

  const [timeEntries, expenses, billLines] = await Promise.all([
    timeEntryIds.length
      ? supabase.from("time_entries").select("id, status, attached_file_ids").eq("org_id", orgId).in("id", timeEntryIds)
      : Promise.resolve({ data: [], error: null }),
    expenseIds.length
      ? supabase.from("project_expenses").select("id, status, receipt_file_id").eq("org_id", orgId).in("id", expenseIds)
      : Promise.resolve({ data: [], error: null }),
    billLineIds.length
      ? supabase
          .from("bill_lines")
          .select("id, bill:vendor_bills(id, status, file_id)")
          .eq("org_id", orgId)
          .in("id", billLineIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (timeEntries.error) throw new Error(`Failed to load time proof: ${timeEntries.error.message}`)
  if (expenses.error) throw new Error(`Failed to load expense proof: ${expenses.error.message}`)
  if (billLines.error) throw new Error(`Failed to load bill proof: ${billLines.error.message}`)

  const sourceProofById = new Map<string, { status?: string | null; proof_file_id?: string | null }>()
  for (const row of timeEntries.data ?? []) {
    sourceProofById.set(`time_entry:${row.id}`, {
      status: row.status ?? null,
      proof_file_id: Array.isArray(row.attached_file_ids) ? row.attached_file_ids[0] ?? null : null,
    })
  }
  for (const row of expenses.data ?? []) {
    sourceProofById.set(`project_expense:${row.id}`, {
      status: row.status ?? null,
      proof_file_id: row.receipt_file_id ?? null,
    })
  }
  for (const row of billLines.data ?? []) {
    const bill = Array.isArray((row as any).bill) ? (row as any).bill[0] : (row as any).bill
    sourceProofById.set(`vendor_bill_line:${row.id}`, {
      status: bill?.status ?? null,
      proof_file_id: bill?.file_id ?? null,
    })
  }

  return (data ?? []).map((row: any) => ({
    ...mapBillableCost(row),
    source_company_name: row.source_company?.name ?? null,
    source_status: sourceProofById.get(`${row.source_type}:${row.source_id}`)?.status ?? null,
    proof_file_id: sourceProofById.get(`${row.source_type}:${row.source_id}`)?.proof_file_id ?? row.metadata?.receipt_file_id ?? null,
  }))
}

export async function voidBillableCostsForVendorBill({ billId, orgId }: { billId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: bill, error: billError } = await supabase
    .from("vendor_bills")
    .select("id, project_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()
  if (billError || !bill) throw new Error("Vendor bill not found")
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: bill.project_id, permission: "bill.approve" })

  const { data: costs, error } = await supabase
    .from("billable_costs")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("source_type", "vendor_bill_line")
    .eq("metadata->>bill_id", billId)
    .neq("status", "voided")

  if (error) throw new Error(`Failed to load billable costs for bill: ${error.message}`)
  for (const cost of costs ?? []) {
    if (cost.status === "billed") {
      const creditPayload = {
        org_id: resolvedOrgId,
        project_id: cost.project_id,
        cost_code_id: cost.cost_code_id ?? null,
        source_type: "manual_adjustment",
        source_id: randomUUID(),
        source_company_id: cost.source_company_id ?? null,
        occurred_on: toDateOnly(new Date()),
        description: `Credit for voided bill cost: ${cost.description ?? "Vendor bill"}`,
        cost_cents: -Math.abs(cost.cost_cents ?? 0),
        markup_percent_resolved: cost.markup_percent_resolved ?? 0,
        markup_cents: -Math.abs(cost.markup_cents ?? 0),
        is_billable: true,
        status: "open",
        metadata: {
          adjustment_reason: "vendor_bill_voided_after_billing",
          original_billable_cost_id: cost.id,
          original_bill_id: billId,
        },
      }
      await insertOrReturnBillableCost(supabase, resolvedOrgId, creditPayload, "manual_adjustment")
    } else {
      const { error: voidError } = await supabase
        .from("billable_costs")
        .update({ status: "voided" })
        .eq("org_id", resolvedOrgId)
        .eq("id", cost.id)
      if (voidError) throw new Error(`Failed to void billable cost: ${voidError.message}`)
    }
  }
}

function buildInvoiceDraft({
  projectId,
  costs,
  groupBy,
}: {
  projectId: string
  costs: BillableCost[]
  groupBy: "cost_code" | "detail"
}): InvoiceDraft {
  const issueDate = toDateOnly(new Date())
  const lineMap = new Map<string, InvoiceDraftLine>()

  for (const cost of costs) {
    const key = groupBy === "detail" ? cost.id : cost.cost_code_id ?? "uncoded"
    const fallbackDescription = cost.cost_code_code
      ? `${cost.cost_code_code} ${cost.cost_code_name ?? "Cost code"}`
      : "Uncoded costs"
    const current =
      lineMap.get(key) ??
      ({
        cost_code_id: cost.cost_code_id ?? null,
        cost_code_code: cost.cost_code_code ?? null,
        cost_code_name: cost.cost_code_name ?? null,
        description: groupBy === "detail" ? cost.description || fallbackDescription : fallbackDescription,
        cost_cents: 0,
        markup_cents: 0,
        billable_cents: 0,
        markup_percent: Number(cost.markup_percent_resolved ?? 0),
        billable_cost_ids: [],
      } satisfies InvoiceDraftLine)

    current.cost_cents += cost.cost_cents
    current.markup_cents += cost.markup_cents
    current.billable_cents += cost.billable_cents
    current.billable_cost_ids.push(cost.id)
    lineMap.set(key, current)
  }

  const lines = Array.from(lineMap.values()).sort((a, b) =>
    `${a.cost_code_code ?? ""}${a.description}`.localeCompare(`${b.cost_code_code ?? ""}${b.description}`),
  )
  const totals = lines.reduce(
    (sum, line) => ({
      cost_cents: sum.cost_cents + line.cost_cents,
      markup_cents: sum.markup_cents + line.markup_cents,
      billable_cents: sum.billable_cents + line.billable_cents,
    }),
    { cost_cents: 0, markup_cents: 0, billable_cents: 0 },
  )

  return {
    projectId,
    title: "Cost-plus billing",
    issueDate,
    dueDate: addDays(issueDate, 30),
    groupBy,
    lines,
    totals,
  }
}

export async function generateInvoiceFromCosts(
  input: GenerateInvoiceFromCostsInput,
  orgId?: string,
): Promise<GenerateInvoiceFromCostsResult> {
  const parsed = generateInvoiceFromCostsInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: parsed.projectId, permission: "invoice.write" })

  const from = toDateOnly(parsed.dateRange.from)
  const to = toDateOnly(parsed.dateRange.to)
  const today = toDateOnly(new Date())
  if (to > today) throw new Error("Cannot generate an invoice for a future date range")
  if (from > to) throw new Error("Date range start must be before the end date")

  const contract = await getProjectCostContract(supabase, resolvedOrgId, parsed.projectId)
  if (!isCostPlusContract(contract)) throw new Error("Project contract is not cost-plus or T&M")

  if (parsed.includeAllowanceVariances) {
    await ensureAllowanceOverageBillableCosts({
      supabase,
      orgId: resolvedOrgId,
      projectId: parsed.projectId,
      contractId: contract.id ?? null,
      occurredOn: parsed.dateRange.to,
    })
  }

  if (!parsed.dryRun && parsed.idempotencyKey) {
    const { data: existing } = await supabase
      .from("idempotency_keys")
      .select("response")
      .eq("org_id", resolvedOrgId)
      .eq("scope", "generate_invoice_from_costs")
      .eq("key", parsed.idempotencyKey)
      .maybeSingle()

    const invoiceId = (existing?.response as any)?.invoiceId
    if (invoiceId) {
      const preview = (existing?.response as any)?.invoicePreview
      return {
        invoiceId,
        invoicePreview: preview,
        costCount: preview?.lines?.reduce((sum: number, line: any) => sum + (line.billable_cost_ids?.length ?? 0), 0) ?? 0,
        totalCostCents: preview?.totals?.cost_cents ?? 0,
        totalMarkupCents: preview?.totals?.markup_cents ?? 0,
        totalBillableCents: preview?.totals?.billable_cents ?? 0,
        excludedCount: 0,
        warnings: [],
      }
    }
  }

  let query = supabase
    .from("billable_costs")
    .select("*, cost_code:cost_codes(code, name, category)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", parsed.projectId)
    .eq("status", "open")
    .eq("is_billable", true)
    .gte("occurred_on", from)
    .lte("occurred_on", to)
    .order("occurred_on", { ascending: true })

  if (parsed.costCodeIds?.length) query = query.in("cost_code_id", parsed.costCodeIds)
  if (parsed.billableCostIds?.length) query = query.in("id", parsed.billableCostIds)

  const { data: rawCosts, error } = await query
  if (error) throw new Error(`Failed to load billable costs: ${error.message}`)

  const refreshedCosts: BillableCost[] = []
  for (const rawCost of rawCosts ?? []) {
    const markup = await resolveMarkupPercent({
      supabase,
      orgId: resolvedOrgId,
      contractId: contract.id,
      costCodeId: rawCost.cost_code_id ?? null,
      costCodeCategory: rawCost.cost_code?.category ?? null,
      occurredOn: new Date(rawCost.occurred_on),
    })
    refreshedCosts.push(
      mapBillableCost({
        ...rawCost,
        markup_percent_resolved: markup.percent,
        markup_cents: calculateMarkupCents(rawCost.cost_cents ?? 0, markup.percent),
        metadata: { ...(rawCost.metadata ?? {}), markup_source: markup.source },
      }),
    )
  }

  const excludedCountQuery = supabase
    .from("billable_costs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("project_id", parsed.projectId)
    .eq("status", "excluded")
    .gte("occurred_on", from)
    .lte("occurred_on", to)
  const { count: excludedCount } = await excludedCountQuery

  const preview = buildInvoiceDraft({ projectId: parsed.projectId, costs: refreshedCosts, groupBy: parsed.groupBy })
  const resultBase = {
    invoicePreview: preview,
    costCount: refreshedCosts.length,
    totalCostCents: preview.totals.cost_cents,
    totalMarkupCents: preview.totals.markup_cents,
    totalBillableCents: preview.totals.billable_cents,
    excludedCount: excludedCount ?? 0,
    warnings: [] as Array<{ code: string; message: string; billableCostId?: string }>,
  }

  if (parsed.dryRun || refreshedCosts.length === 0) return resultBase

  const costIds = refreshedCosts.map((cost) => cost.id)
  const invoiceNumber = await getNextInvoiceNumber(resolvedOrgId)
  const token = randomUUID()
  const previewForRpc = {
    ...preview,
    lines: preview.lines.map((line, index) => ({ ...line, sort_order: index })),
  }

  const { data: rpcResult, error: rpcError } = await supabase.rpc("create_invoice_from_billable_costs_atomic", {
    p_org_id: resolvedOrgId,
    p_project_id: parsed.projectId,
    p_actor_id: userId,
    p_invoice_number: invoiceNumber.number,
    p_token: token,
    p_title: `Cost-plus billing ${from} to ${to}`,
    p_issue_date: preview.issueDate,
    p_due_date: preview.dueDate,
    p_from_date: from,
    p_to_date: to,
    p_group_by: parsed.groupBy,
    p_cost_ids: costIds,
    p_preview: previewForRpc,
    p_idempotency_key: parsed.idempotencyKey ?? null,
    p_reservation_id: invoiceNumber.reservation_id ?? null,
  })

  if (rpcError) {
    throw new Error(`Failed to create invoice from costs: ${rpcError.message}`)
  }

  const invoiceId = (rpcResult as any)?.invoiceId
  if (!invoiceId) throw new Error("Failed to create invoice from costs: missing invoice id")

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_generated_from_costs",
    entityType: "invoice",
    entityId: invoiceId,
    payload: {
      project_id: parsed.projectId,
      cost_count: refreshedCosts.length,
      total_cents: preview.totals.billable_cents,
      group_by: parsed.groupBy,
      billable_cost_ids: costIds,
    },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "invoice",
    entityId: invoiceId,
    after: {
      invoice_number: invoiceNumber.number,
      project_id: parsed.projectId,
      source_type: "from_costs",
      billable_cost_ids: costIds,
      totals: preview.totals,
    },
  })

  return { ...resultBase, invoiceId }
}


export async function getGMPSnapshot(projectId: string, orgId?: string): Promise<GMPSnapshot | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const contract = await getProjectCostContract(supabase, resolvedOrgId, projectId)
  if (!contract?.gmp_cents) return null

  const budgetData = await getBudgetWithActuals(projectId, resolvedOrgId).catch(() => null)
  let forecastFinalCostCents = 0
  let costToDateCents = 0
  let committedCents = 0

  if (budgetData?.summary) {
    forecastFinalCostCents = budgetData.summary.total_eac_cents ?? 0
    costToDateCents = budgetData.summary.total_actual_cents ?? 0
    committedCents = budgetData.summary.total_committed_cents ?? 0
  } else {
    // Fallback if no budget exists
    const [ledger, commitments] = await Promise.all([
      supabase
        .from("billable_costs")
        .select("cost_cents")
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .in("status", ["open", "locked", "billed"]),
      supabase
        .from("commitments")
        .select("total_cents")
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .in("status", ["approved", "executed"]),
    ])

    if (ledger.error) throw new Error(`Failed to load cost ledger: ${ledger.error.message}`)
    if (commitments.error) throw new Error(`Failed to load commitments: ${commitments.error.message}`)

    costToDateCents = (ledger.data ?? []).reduce((sum, row) => sum + Number(row.cost_cents ?? 0), 0)
    committedCents = (commitments.data ?? []).reduce((sum, row) => sum + Number(row.total_cents ?? 0), 0)
    forecastFinalCostCents = Math.max(costToDateCents, committedCents)
  }

  const gmpCents = Number(contract.gmp_cents)
  const projectedSavingsCents = gmpCents - forecastFinalCostCents
  const ownerSharePct = Number(contract.savings_split_owner_pct ?? 0)
  const builderSharePct = Number(contract.savings_split_builder_pct ?? 0)

  if (forecastFinalCostCents > gmpCents) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "gmp_overrun_warning",
      entityType: "contract",
      entityId: contract.id,
      payload: { project_id: projectId, forecast_final_cents: forecastFinalCostCents, gmp_cents: gmpCents },
    }).catch(() => undefined)
  }

  return {
    contractId: contract.id,
    gmpCents,
    costToDateCents,
    committedCents,
    forecastFinalCostCents,
    burnPercent: gmpCents > 0 ? Math.round((forecastFinalCostCents / gmpCents) * 1000) / 10 : 0,
    projectedSavingsCents,
    ownerSharePct,
    builderSharePct,
    ownerSavingsCents: projectedSavingsCents > 0 ? Math.round((projectedSavingsCents * ownerSharePct) / 100) : 0,
    builderSavingsCents: projectedSavingsCents > 0 ? Math.round((projectedSavingsCents * builderSharePct) / 100) : 0,
  }
}
