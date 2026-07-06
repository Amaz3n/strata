import { checkVarianceAlerts } from "@/lib/services/budgets"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createHash, randomBytes, randomUUID } from "crypto"

import {
  assertApprovalAllowed,
  getExpenseApprovalBlockingReasons,
  getTimeEntryApprovalBlockingReasons,
  loadApprovalGateSettings,
} from "@/lib/financials/approval-gates"
import { assertCostSourceCanEnterBillableLedger } from "@/lib/financials/billable-ledger-rules"
import {
  resolveContractFeePresentation,
  resolveProjectBillingModel,
  shouldExposeOpenBookCostDetail,
  type FeePresentation,
} from "@/lib/financials/billing-model"
import { recordAudit } from "@/lib/services/audit"
import { createApprovedCostInvoiceFromPreview } from "@/lib/services/approved-cost-invoicing"
import {
  assertBillingPeriodCanInvoice,
  getProjectBillingPeriod,
  linkInvoiceToBillingPeriod,
} from "@/lib/services/billing-periods"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import {
  getProjectFeeBillingSummary,
  prepareProjectFeeBillingForOwnerInvoice,
  recordProjectFeeBillingForInvoice,
  type PreparedProjectFeeBilling,
} from "@/lib/services/fee-billing"
import {
  calculateTimeEntryCostCents,
  postJobCostEntryFromProjectExpense,
  postJobCostEntryFromExpenseLine,
  postJobCostEntryFromTimeEntry,
  postJobCostEntryFromBillLine,
  voidJobCostEntryForSource,
} from "@/lib/services/job-cost-actuals"
import {
  resolveTimeAndMaterialsMaterialMarkup,
  resolveTimeAndMaterialsRateForTimeEntry,
} from "@/lib/services/billing-rate-schedules"
import { sendEmail, getOrgSenderEmail, renderStandardEmailLayout } from "@/lib/services/mailer"
import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import { enqueueProjectExpenseSync } from "@/lib/services/qbo-sync"
import { requireAuthorization } from "@/lib/services/authorization"
import { getProjectGmpControlSummary } from "@/lib/services/gmp-control"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
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

type MarkupSource =
  | "line"
  | "cost_code"
  | "contract"
  | "org"
  | "default"
  | "tm_rate_schedule"
  | "tm_material_schedule"
  | "tm_project_override"
  | "tm_membership_fallback"
type CostSourceType = "vendor_bill_line" | "project_expense" | "project_expense_line" | "time_entry" | "manual_adjustment" | "allowance_overage"

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
  gmp_classification?: "inside_gmp" | "outside_gmp" | null
  invoice_id?: string | null
  invoice_line_id?: string | null
  billing_period_id?: string | null
  late_to_billing_period_id?: string | null
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
  unit?: string | null
  cost_cents: number
  markup_cents: number
  billable_cents: number
  markup_percent: number
  billable_cost_ids: string[]
  sort_order?: number
  metadata?: Record<string, any>
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
    gross_billable_cents?: number
    retainage_cents?: number
    earned_fee_cents?: number
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

export function calculateMarkupCents(costCents: number, percent: number) {
  return Math.round((costCents * percent) / 100)
}

function formatCurrencyCents(cents: number) {
  return `$${(Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function applyRetainageToInvoiceDraft(draft: InvoiceDraft, retainagePercent: number | null | undefined): InvoiceDraft {
  const effectivePercent = Number(retainagePercent ?? 0)
  if (!Number.isFinite(effectivePercent) || effectivePercent <= 0 || draft.totals.billable_cents <= 0) return draft

  const retainageBaseCents = draft.lines.reduce((sum, line) => {
    if (line.unit === "retainage") return sum
    if (line.metadata?.fee_line_kind === "fixed_fee_earned") return sum
    return sum + Number(line.billable_cents ?? 0)
  }, 0)
  const retainageCents = Math.round(Math.max(retainageBaseCents, 0) * (effectivePercent / 100))
  if (retainageCents <= 0) return draft

  const retainageLine: InvoiceDraftLine = {
    description: `Retainage held (${effectivePercent}%)`,
    unit: "retainage",
    cost_cents: 0,
    markup_cents: 0,
    billable_cents: -Math.abs(retainageCents),
    markup_percent: 0,
    billable_cost_ids: [],
    sort_order: draft.lines.length,
    metadata: {
      system_generated_kind: "retainage_hold",
      retainage_percent: effectivePercent,
      retainage_amount_cents: retainageCents,
    },
  }

  return {
    ...draft,
    lines: [...draft.lines, retainageLine],
    totals: {
      ...draft.totals,
      gross_billable_cents: draft.totals.billable_cents,
      retainage_cents: retainageCents,
      billable_cents: draft.totals.billable_cents - retainageCents,
    },
  }
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
    gmp_classification: row.gmp_classification ?? "inside_gmp",
    invoice_id: row.invoice_id ?? null,
    invoice_line_id: row.invoice_line_id ?? null,
    billing_period_id: row.billing_period_id ?? null,
    late_to_billing_period_id: row.late_to_billing_period_id ?? null,
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

export async function getProjectCostContract(supabase: SupabaseClient, orgId: string, projectId: string) {
  const { data, error } = await supabase
    .from("contracts")
    .select("id, status, contract_type, markup_percent, gmp_cents, fixed_fee_cents, fee_presentation, savings_split_owner_pct, savings_split_builder_pct, labor_burden_multiplier, requires_client_cost_approval, open_book, retainage_percent, rate_schedule_id, snapshot")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Failed to load contract: ${error.message}`)
  return data as any | null
}

function isCostPlusContract(contract: any | null) {
  return supportsApprovedCostInvoicing(contract as any)
}

function isTimeAndMaterialsContract(contract: any | null) {
  return contract?.contract_type === "time_materials" || contract?.snapshot?.billing_model === "time_and_materials"
}

function derivedMarkupPercent(costCents: number, markupCents: number) {
  if (costCents <= 0) return 0
  return Number(((markupCents / costCents) * 100).toFixed(4))
}

async function resolveMaterialMarkupForContract(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  contract: any
  costCodeId?: string | null
  costCodeCategory?: string | null
  occurredOn: Date | string
  lineOverride?: number | null
}) {
  if (isTimeAndMaterialsContract(args.contract)) {
    const tmMarkup = await resolveTimeAndMaterialsMaterialMarkup({
      supabase: args.supabase,
      orgId: args.orgId,
      projectId: args.projectId,
      contract: args.contract,
      costCodeId: args.costCodeId ?? null,
      costCodeCategory: args.costCodeCategory ?? null,
      occurredOn: args.occurredOn,
    })
    if (tmMarkup) {
      return {
        percent: tmMarkup.percent,
        source: tmMarkup.source as MarkupSource,
        scheduleId: tmMarkup.scheduleId ?? null,
        rateId: tmMarkup.rateId ?? null,
        overrideId: tmMarkup.overrideId ?? null,
      }
    }
  }

  const markup = await resolveMarkupPercent({
    supabase: args.supabase,
    orgId: args.orgId,
    contractId: args.contract.id,
    costCodeId: args.costCodeId ?? null,
    costCodeCategory: args.costCodeCategory ?? null,
    occurredOn: new Date(args.occurredOn),
    lineOverride: args.lineOverride,
  })

  return {
    percent: markup.percent,
    source: markup.source,
    scheduleId: null,
    rateId: null,
    overrideId: null,
  }
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

    const { data: existingRows, error: existingError } = await supabase
      .from("billable_costs")
      .select("id, source_id, status, cost_cents, metadata")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("source_type", "allowance_overage")
      .neq("status", "voided")

    if (existingError) throw new Error(`Failed to load allowance overage ledger rows: ${existingError.message}`)
    const allowanceRows = (existingRows ?? []).filter(
      (row: any) => row.source_id === allowance.id || row.metadata?.allowance_id === allowance.id,
    )
    const postedOverageCents = allowanceRows.reduce((sum: number, row: any) => sum + Number(row.cost_cents ?? 0), 0)
    const deltaCents = overageCents - postedOverageCents
    if (deltaCents <= 0) continue

    const markup = await resolveMarkupPercent({
      supabase,
      orgId,
      contractId,
      costCodeId: null,
      occurredOn,
    })
    const sequence = allowanceRows.length + 1
    const payload = {
      org_id: orgId,
      project_id: projectId,
      cost_code_id: null,
      source_type: "allowance_overage",
      source_id: sequence === 1 ? allowance.id : `${allowance.id}:${sequence}`,
      source_company_id: null,
      occurred_on: toDateOnly(occurredOn),
      description:
        sequence === 1
          ? `Allowance overage: ${allowance.name ?? "Allowance"}`
          : `Allowance overage (additional): ${allowance.name ?? "Allowance"}`,
      cost_cents: deltaCents,
      markup_percent_resolved: markup.percent,
      markup_cents: calculateMarkupCents(deltaCents, markup.percent),
      is_billable: true,
      status: "open",
      metadata: {
        allowance_id: allowance.id,
        allowance_name: allowance.name ?? null,
        allowance_budget_cents: allowance.budget_cents ?? 0,
        allowance_used_cents: allowance.used_cents ?? 0,
        allowance_overage_cents: overageCents,
        previously_posted_overage_cents: postedOverageCents,
        sequence,
        markup_source: markup.source,
      },
    }

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
  const [resolution] = await resolveMarkupPercentsBatch({
    supabase: args.supabase,
    orgId: args.orgId,
    contractId: args.contractId,
    costs: [
      {
        costCodeId: args.costCodeId,
        costCodeCategory: args.costCodeCategory,
        occurredOn: args.occurredOn,
        lineOverride: args.lineOverride,
      },
    ],
  })
  return resolution ?? { percent: 0, source: "default" }
}

export async function resolveMarkupPercentsBatch(args: {
  supabase: SupabaseClient
  orgId: string
  contractId: string | null
  costs: Array<{
    costCodeId: string | null
    costCodeCategory?: string | null
    occurredOn: Date | string
    lineOverride?: number | null
  }>
}): Promise<Array<{ percent: number; source: MarkupSource }>> {
  if (args.costs.length === 0) return []

  const costCodeIds = Array.from(
    new Set(args.costs.map((cost) => cost.costCodeId).filter((id): id is string => Boolean(id))),
  )

  const [costCodesResult, contractResult, rulesResult] = await Promise.all([
    costCodeIds.length
      ? args.supabase
          .from("cost_codes")
          .select("id, default_markup_percent, category")
          .eq("org_id", args.orgId)
          .in("id", costCodeIds)
      : Promise.resolve({ data: [], error: null }),
    args.contractId
      ? args.supabase
          .from("contracts")
          .select("id, markup_percent")
          .eq("org_id", args.orgId)
          .eq("id", args.contractId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    args.supabase
      .from("markup_rules")
      .select("scope, contract_id, cost_code_id, markup_percent, applies_to_category, effective_from, effective_to, created_at")
      .eq("org_id", args.orgId)
      .order("created_at", { ascending: false }),
  ])

  if (costCodesResult.error) throw new Error(`Failed to load cost code markups: ${costCodesResult.error.message}`)
  if (contractResult.error) throw new Error(`Failed to load contract markup: ${contractResult.error.message}`)
  if (rulesResult.error) throw new Error(`Failed to load markup rules: ${rulesResult.error.message}`)

  const costCodeById = new Map<string, any>((costCodesResult.data ?? []).map((costCode: any) => [costCode.id, costCode]))
  const rules = rulesResult.data ?? []

  const matchesRule = (rule: any, cost: { costCodeCategory?: string | null; occurredOn: Date | string }) => {
    const occurredOn = toDateOnly(cost.occurredOn)
    const appliesFrom = !rule.effective_from || rule.effective_from <= occurredOn
    const appliesTo = !rule.effective_to || rule.effective_to >= occurredOn
    const appliesCategory = !rule.applies_to_category || rule.applies_to_category === cost.costCodeCategory
    return appliesFrom && appliesTo && appliesCategory
  }

  return args.costs.map((cost) => {
    if (typeof cost.lineOverride === "number" && Number.isFinite(cost.lineOverride)) {
      return { percent: cost.lineOverride, source: "line" }
    }

    const costCode = cost.costCodeId ? costCodeById.get(cost.costCodeId) : null
    const costCodeCategory = cost.costCodeCategory ?? costCode?.category ?? null
    const costWithCategory = { ...cost, costCodeCategory }
    const defaultCostCodeMarkup = Number(costCode?.default_markup_percent)
    if (costCode?.default_markup_percent != null && costCode.default_markup_percent !== "" && Number.isFinite(defaultCostCodeMarkup)) {
      return { percent: defaultCostCodeMarkup, source: "cost_code" }
    }

    if (cost.costCodeId) {
      const costCodeRule = rules.find(
        (rule: any) =>
          rule.scope === "cost_code" &&
          rule.cost_code_id === cost.costCodeId &&
          matchesRule(rule, costWithCategory),
      )
      if (costCodeRule) return { percent: Number(costCodeRule.markup_percent), source: "cost_code" }
    }

    if (args.contractId) {
      const contractRule = rules.find(
        (rule: any) =>
          rule.scope === "contract" &&
          rule.contract_id === args.contractId &&
          matchesRule(rule, costWithCategory),
      )
      if (contractRule) return { percent: Number(contractRule.markup_percent), source: "contract" }

      const rawContractMarkup = (contractResult.data as any)?.markup_percent
      const contractMarkup = Number(rawContractMarkup)
      if (rawContractMarkup != null && rawContractMarkup !== "" && Number.isFinite(contractMarkup)) {
        return { percent: contractMarkup, source: "contract" }
      }
    }

    const orgRule = rules.find((rule: any) => rule.scope === "org" && matchesRule(rule, costWithCategory))
    if (orgRule) return { percent: Number(orgRule.markup_percent), source: "org" }

    return { percent: 0, source: "default" }
  })
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
      id, org_id, bill_id, project_id, cost_code_id, description, quantity, unit_cost_cents, metadata,
      cost_code:cost_codes(id, category, is_reimbursable_default),
      bill:vendor_bills(id, org_id, project_id, bill_number, bill_date, status, commitment:commitments(company_id))
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", args.billLineId)
    .maybeSingle()

  if (error || !line) throw new Error("Bill line not found")
  const bill = (line as any).bill
  const projectId = (line as any).project_id ?? bill?.project_id
  if (!projectId) throw new Error("Bill line is missing project context")

  const contract = await getProjectCostContract(supabase, resolvedOrgId, projectId)
  if (!isCostPlusContract(contract)) throw new Error("Project contract is not cost-plus or T&M")
  assertCostSourceCanEnterBillableLedger({
    billingModel: contract.contract_type === "time_materials" ? "time_and_materials" : contract.gmp_cents ? "cost_plus_gmp" : "cost_plus_percent",
    sourceType: "vendor_bill_line",
    sourceStatus: String(bill.status),
  })

  const costCents = Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1))
  const markup = await resolveMaterialMarkupForContract({
    supabase,
    orgId: resolvedOrgId,
    projectId,
    contract,
    costCodeId: line.cost_code_id ?? null,
    costCodeCategory: (line as any).cost_code?.category ?? null,
    occurredOn: new Date(bill.bill_date ?? new Date()),
  })
  const isBillable =
    (line as any).metadata?.billable_to_customer === true &&
    (line as any).cost_code?.is_reimbursable_default !== false

  return insertOrReturnBillableCost(
    supabase,
    resolvedOrgId,
    {
      org_id: resolvedOrgId,
      project_id: projectId,
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
      metadata: {
        markup_source: markup.source,
        bill_id: bill.id,
        bill_number: bill.bill_number,
        rate_schedule_id: markup.scheduleId,
        billing_rate_id: markup.rateId,
        billing_rate_override_id: markup.overrideId,
      },
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
  assertCostSourceCanEnterBillableLedger({
    billingModel: contract.contract_type === "time_materials" ? "time_and_materials" : contract.gmp_cents ? "cost_plus_gmp" : "cost_plus_percent",
    sourceType: "project_expense",
    sourceStatus: String(expense.status),
  })

  const costCents = Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0)
  const markup = await resolveMaterialMarkupForContract({
    supabase,
    orgId: resolvedOrgId,
    projectId: expense.project_id,
    contract,
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
      metadata: {
        markup_source: markup.source,
        receipt_file_id: expense.receipt_file_id ?? null,
        rate_schedule_id: markup.scheduleId,
        billing_rate_id: markup.rateId,
        billing_rate_override_id: markup.overrideId,
      },
    },
    "project_expense",
  )

  await supabase.from("project_expenses").update({ billable_cost_id: billable.id }).eq("org_id", resolvedOrgId).eq("id", expense.id)
  return billable
}

export async function upsertBillableCostFromExpenseLine(args: { expenseLineId: string; orgId?: string }): Promise<BillableCost> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { data: line, error } = await supabase
    .from("project_expense_lines")
    .select(`
      id, org_id, expense_id, project_id, cost_code_id, description, amount_cents,
      cost_code:cost_codes(id, category, is_reimbursable_default),
      expense:project_expenses(id, org_id, project_id, expense_date, status, is_billable, markup_percent_override, vendor_company_id, vendor_name_text, description, receipt_file_id)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", args.expenseLineId)
    .maybeSingle()

  if (error || !line) throw new Error("Expense split not found")
  const expense = (line as any).expense
  if (!expense) throw new Error("Expense split is missing its expense")
  if (expense.status !== "approved") throw new Error("Expense must be approved before it enters the ledger")
  const lineProjectId = (line as any).project_id ?? expense.project_id
  if (!lineProjectId) throw new Error("Expense split is missing project context")

  const contract = await getProjectCostContract(supabase, resolvedOrgId, lineProjectId)
  if (!isCostPlusContract(contract)) throw new Error("Project contract is not cost-plus or T&M")
  assertCostSourceCanEnterBillableLedger({
    billingModel: contract.contract_type === "time_materials" ? "time_and_materials" : contract.gmp_cents ? "cost_plus_gmp" : "cost_plus_percent",
    sourceType: "project_expense",
    sourceStatus: String(expense.status),
  })

  const costCents = Number(line.amount_cents ?? 0)
  const markup = await resolveMaterialMarkupForContract({
    supabase,
    orgId: resolvedOrgId,
    projectId: lineProjectId,
    contract,
    costCodeId: line.cost_code_id ?? null,
    costCodeCategory: (line as any).cost_code?.category ?? null,
    occurredOn: new Date(expense.expense_date),
    lineOverride: expense.markup_percent_override,
  })
  const isBillable = expense.is_billable !== false && (line as any).cost_code?.is_reimbursable_default !== false

  return insertOrReturnBillableCost(
    supabase,
    resolvedOrgId,
    {
      org_id: resolvedOrgId,
      project_id: lineProjectId,
      cost_code_id: line.cost_code_id ?? null,
      source_type: "project_expense_line",
      source_id: line.id,
      source_company_id: expense.vendor_company_id ?? null,
      occurred_on: expense.expense_date,
      description: line.description || expense.description || expense.vendor_name_text || "Project expense",
      cost_cents: costCents,
      markup_percent_resolved: markup.percent,
      markup_cents: calculateMarkupCents(costCents, markup.percent),
      is_billable: isBillable,
      status: isBillable ? "open" : "excluded",
      metadata: {
        markup_source: markup.source,
        expense_id: expense.id,
        receipt_file_id: expense.receipt_file_id ?? null,
        rate_schedule_id: markup.scheduleId,
        billing_rate_id: markup.rateId,
        billing_rate_override_id: markup.overrideId,
      },
    },
    "project_expense_line",
  )
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

  assertCostSourceCanEnterBillableLedger({
    billingModel: contract.contract_type === "time_materials" ? "time_and_materials" : contract.gmp_cents ? "cost_plus_gmp" : "cost_plus_percent",
    sourceType: "time_entry",
    sourceStatus: String(entry.status),
    clientCostApprovalRequired: contract.requires_client_cost_approval,
  })

  const costCents = calculateTimeEntryCostCents(entry)
  const tmRate = isTimeAndMaterialsContract(contract)
    ? await resolveTimeAndMaterialsRateForTimeEntry({
        supabase,
        orgId: resolvedOrgId,
        projectId: entry.project_id,
        contract,
        timeEntry: entry,
      })
    : null
  const markup = tmRate
    ? {
        percent: derivedMarkupPercent(costCents, tmRate.billableCents - costCents),
        source:
          tmRate.source === "project_override"
            ? ("tm_project_override" as MarkupSource)
            : tmRate.source === "membership_fallback"
              ? ("tm_membership_fallback" as MarkupSource)
              : ("tm_rate_schedule" as MarkupSource),
      }
    : await resolveMarkupPercent({
        supabase,
        orgId: resolvedOrgId,
        contractId: contract.id,
        costCodeId: entry.cost_code_id ?? null,
        costCodeCategory: (entry as any).cost_code?.category ?? null,
        occurredOn: new Date(entry.work_date),
      })
  const isBillable = entry.is_billable !== false && (entry as any).cost_code?.is_reimbursable_default !== false
  const markupCents = tmRate ? tmRate.billableCents - costCents : calculateMarkupCents(costCents, markup.percent)
  const billableCents = tmRate ? tmRate.billableCents : costCents + markupCents

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
      markup_cents: markupCents,
      billable_cents: billableCents,
      is_billable: isBillable,
      status: isBillable ? "open" : "excluded",
      metadata: {
        markup_source: markup.source,
        billing_method: tmRate ? "time_and_materials_rate" : "cost_plus_markup",
        worker_name: entry.worker_name,
        hours: entry.hours,
        base_rate_cents: entry.base_rate_cents,
        burden_multiplier: entry.burden_multiplier,
        is_overtime: entry.is_overtime,
        ot_multiplier: entry.ot_multiplier ?? 1.5,
        is_double_time: entry.is_double_time ?? false,
        dt_multiplier: entry.dt_multiplier ?? 2,
        bill_rate_cents: tmRate?.rateCents ?? null,
        bill_rate_unit: tmRate?.unit ?? null,
        bill_quantity: tmRate?.billQuantity ?? null,
        bill_multiplier: tmRate?.multiplier ?? null,
        billing_rate_source: tmRate?.source ?? null,
        rate_schedule_id: tmRate?.scheduleId ?? null,
        billing_rate_id: tmRate?.rateId ?? null,
        billing_rate_override_id: tmRate?.overrideId ?? null,
        billing_role_name: tmRate?.roleName ?? null,
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
  const scanVariance = async (projectIds: Array<string | null | undefined>) => {
    for (const projectId of Array.from(new Set(projectIds.filter((id): id is string => Boolean(id))))) {
      await checkVarianceAlerts(projectId, resolvedOrgId).catch((error) => {
        console.error("Variance scan after ledger post failed", { projectId, error })
      })
    }
  }

  if (args.source === "vendor_bill") {
    const { data: bill, error: billError } = await supabase
      .from("vendor_bills")
      .select("id, project_id")
      .eq("org_id", resolvedOrgId)
      .eq("id", args.sourceId)
      .maybeSingle()

    if (billError || !bill) throw new Error("Vendor bill not found")
    const contract = await getProjectCostContract(supabase, resolvedOrgId, bill.project_id)
    const shouldPostBillableCosts = isCostPlusContract(contract)

    const { data: lines, error } = await supabase
      .from("bill_lines")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("bill_id", args.sourceId)

    if (error) throw new Error(`Failed to load bill lines: ${error.message}`)
    await Promise.all((lines ?? []).map(async (line) => {
      if (shouldPostBillableCosts) {
        await upsertBillableCostFromBillLine({ billLineId: line.id, orgId: resolvedOrgId })
      }
      await postJobCostEntryFromBillLine({ billLineId: line.id, orgId: resolvedOrgId })
    }))
    await scanVariance([bill.project_id])
    return
  }

  if (args.source === "project_expense") {
    const { data: expense, error } = await supabase
      .from("project_expenses")
      .select("id, project_id")
      .eq("org_id", resolvedOrgId)
      .eq("id", args.sourceId)
      .maybeSingle()

    if (error || !expense) throw new Error("Expense not found")

    const { data: lines, error: linesError } = await supabase
      .from("project_expense_lines")
      .select("id, project_id")
      .eq("org_id", resolvedOrgId)
      .eq("expense_id", args.sourceId)
      .order("sort_order", { ascending: true })
    if (linesError) throw new Error(`Failed to load expense splits: ${linesError.message}`)

    if ((lines ?? []).length > 0) {
      // Split expense: post one ledger row per line, resolving the contract per the
      // line's project so cross-project allocations bill against the right contract.
      const projectIds = Array.from(new Set(lines!.map((line) => line.project_id ?? expense.project_id)))
      const contractEntries = await Promise.all(
        projectIds.map(async (projectId) => {
          const contract = await getProjectCostContract(supabase, resolvedOrgId, projectId)
          return [projectId, isCostPlusContract(contract)] as const
        }),
      )
      const contractByProject = new Map<string, boolean>(contractEntries)
      await Promise.all(lines!.map(async (line) => {
        const projectId = line.project_id ?? expense.project_id
        if (contractByProject.get(projectId)) {
          await upsertBillableCostFromExpenseLine({ expenseLineId: line.id, orgId: resolvedOrgId })
        }
        await postJobCostEntryFromExpenseLine({ expenseLineId: line.id, orgId: resolvedOrgId })
      }))
      await scanVariance(lines!.map((line) => line.project_id ?? expense.project_id))
      return
    }

    const contract = await getProjectCostContract(supabase, resolvedOrgId, expense.project_id)
    if (isCostPlusContract(contract)) {
      await upsertBillableCostFromExpense({ expenseId: args.sourceId, orgId: resolvedOrgId })
    }
    await postJobCostEntryFromProjectExpense({ expenseId: args.sourceId, orgId: resolvedOrgId })
    await scanVariance([expense.project_id])
    return
  }

  const { data: entry, error } = await supabase
    .from("time_entries")
    .select("id, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", args.sourceId)
    .maybeSingle()

  if (error || !entry) throw new Error("Time entry not found")
  const contract = await getProjectCostContract(supabase, resolvedOrgId, entry.project_id)
  if (isCostPlusContract(contract)) {
    await upsertBillableCostFromTimeEntry({ timeEntryId: args.sourceId, orgId: resolvedOrgId })
  }
  await postJobCostEntryFromTimeEntry({ timeEntryId: args.sourceId, orgId: resolvedOrgId })
  await scanVariance([entry.project_id])
}

export async function createTimeEntry(input: TimeEntryInput, orgId?: string) {
  const parsed = timeEntryInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: parsed.projectId, permission: "time.write" })

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
    ot_multiplier: parsed.otMultiplier,
    is_double_time: parsed.isDoubleTime,
    dt_multiplier: parsed.dtMultiplier,
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
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: before.project_id, permission: "time.write" })

  const updates: Record<string, unknown> = {}
  if (parsed.costCodeId !== undefined) updates.cost_code_id = parsed.costCodeId ?? null
  if (parsed.baseRateCents !== undefined) updates.base_rate_cents = parsed.baseRateCents
  if (parsed.burdenMultiplier !== undefined) updates.burden_multiplier = parsed.burdenMultiplier
  if (parsed.isBillable !== undefined) updates.is_billable = parsed.isBillable
  if (parsed.isOvertime !== undefined) updates.is_overtime = parsed.isOvertime
  if (parsed.otMultiplier !== undefined) updates.ot_multiplier = parsed.otMultiplier
  if (parsed.isDoubleTime !== undefined) updates.is_double_time = parsed.isDoubleTime
  if (parsed.dtMultiplier !== undefined) updates.dt_multiplier = parsed.dtMultiplier
  if (parsed.workerName !== undefined) updates.worker_name = parsed.workerName
  if (parsed.notes !== undefined) updates.notes = parsed.notes ?? null

  if (Object.keys(updates).length === 0) return before

  const impactsPostedLedger =
    before.status === "pm_approved" || before.status === "client_approved"
      ? [
          "cost_code_id",
          "base_rate_cents",
          "burden_multiplier",
          "is_billable",
          "is_overtime",
          "ot_multiplier",
          "is_double_time",
          "dt_multiplier",
        ].some((key) => Object.prototype.hasOwnProperty.call(updates, key))
      : false

  if (impactsPostedLedger) {
    const { data: existingCosts, error: costError } = await supabase
      .from("billable_costs")
      .select("id, invoice_id, status")
      .eq("org_id", resolvedOrgId)
      .eq("source_type", "time_entry")
      .eq("source_id", timeEntryId)
      .neq("status", "voided")

    if (costError) throw new Error(`Failed to load time entry ledger rows: ${costError.message}`)
    if ((existingCosts ?? []).some((cost: any) => cost.invoice_id || cost.status === "billed")) {
      throw new Error("This time entry has costs already billed on an invoice. Remove them from the invoice before changing the time entry.")
    }
  }

  const { data, error } = await supabase
    .from("time_entries")
    .update(updates)
    .eq("org_id", resolvedOrgId)
    .eq("id", timeEntryId)
    .select("*")
    .single()
  if (error || !data) throw new Error(`Failed to update time entry: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "time_entry", entityId: data.id, before, after: data })

  if (impactsPostedLedger) {
    await voidJobCostEntryForSource({ sourceType: "time_entry", sourceId: data.id, orgId: resolvedOrgId })
    const { error: voidCostError } = await supabase
      .from("billable_costs")
      .update({ status: "voided" })
      .eq("org_id", resolvedOrgId)
      .eq("source_type", "time_entry")
      .eq("source_id", data.id)
      .is("invoice_id", null)

    if (voidCostError) throw new Error(`Failed to void time entry billable cost: ${voidCostError.message}`)

    const contract = await getProjectCostContract(supabase, resolvedOrgId, data.project_id)
    const canPostApprovedTime =
      data.status === "client_approved" || (data.status === "pm_approved" && !contract?.requires_client_cost_approval)
    if (canPostApprovedTime) {
      await propagateApprovalToLedger({ source: "time_entry", sourceId: data.id, orgId: resolvedOrgId })
    }
  }

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

  const gateSettings = await loadApprovalGateSettings({ supabase, orgId: resolvedOrgId, projectId: before.project_id })
  assertApprovalAllowed(getTimeEntryApprovalBlockingReasons(before, gateSettings))

  const contract = await getProjectCostContract(supabase, resolvedOrgId, before.project_id)
  // PM approval is the canonical internal approval state; client-gated projects
  // stay here until the client approval token moves them to `client_approved`.
  const nextStatus = "pm_approved"
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
  if (["pm_approved", "client_approved", "locked"].includes(String(before.status))) {
    await voidJobCostEntryForSource({ sourceType: "time_entry", sourceId: data.id, orgId: resolvedOrgId })
  }
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
  const [{ data: entry, error }, { data: org }] = await Promise.all([
    supabase
      .from("time_entries")
      .select("id, project_id, worker_name, work_date, hours, notes, cost_cents, project:projects(name)")
      .eq("org_id", resolvedOrgId)
      .eq("id", timeEntryId)
      .maybeSingle(),
    supabase.from("orgs").select("name, logo_url, slug").eq("id", resolvedOrgId).maybeSingle(),
  ])

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
  
  const title = `Time Entry Approval Requested`
  const messageHtml = `
    <p style="margin: 0 0 12px 0; font-size: 14px; line-height: 1.6; color: #2f2f2f;">${contact?.full_name ? `Hi ${contact.full_name},` : "Hi,"}</p>
    <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #2f2f2f;">A time entry is ready for your approval.</p>
    
    <div style="margin-top: 16px; padding: 14px 16px; border: 1px solid #e1e1e1; background-color: #fafafa;">
      <p style="margin: 0 0 8px 0; color: #424242; font-size: 13px; line-height: 1.5;"><span style="color: #6a6a6a; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;">Project:</span> <span style="color: #111111; font-weight: 600;">${projectName ?? "Project"}</span></p>
      <p style="margin: 0 0 8px 0; color: #424242; font-size: 13px; line-height: 1.5;"><span style="color: #6a6a6a; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;">Worker:</span> <span style="color: #111111; font-weight: 600;">${entry.worker_name ?? "Crew time"}</span></p>
      <p style="margin: 0 0 8px 0; color: #424242; font-size: 13px; line-height: 1.5;"><span style="color: #6a6a6a; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;">Date:</span> <span style="color: #111111; font-weight: 600;">${entry.work_date}</span></p>
      <p style="margin: 0 0 8px 0; color: #424242; font-size: 13px; line-height: 1.5;"><span style="color: #6a6a6a; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;">Hours:</span> <span style="color: #111111; font-weight: 600;">${Number(entry.hours ?? 0).toFixed(2)}</span></p>
      <p style="margin: 0; color: #424242; font-size: 13px; line-height: 1.5;"><span style="color: #6a6a6a; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;">Cost:</span> <span style="color: #111111; font-weight: 700;">${amount}</span></p>
    </div>
    
    ${entry.notes ? `
      <div style="margin-top: 16px; padding: 16px; border: 1px solid #e1e1e1; background-color: #ffffff;">
        <p style="margin: 0 0 8px 0; color: #626262; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px;">Notes</p>
        <p style="margin: 0; color: #222222; font-size: 13px; line-height: 1.6; white-space: pre-wrap;">${entry.notes}</p>
      </div>
    ` : ""}
  `
  const html = renderStandardEmailLayout({
    title,
    messageHtml,
    buttonText: "Approve Time Entry",
    buttonUrl: approval.url,
    orgName: org?.name ?? "Arc",
    orgLogoUrl: org?.logo_url ?? null,
  })

  const sent = await sendEmail({
    to: [recipientEmail],
    subject: `Approval needed: ${Number(entry.hours ?? 0).toFixed(2)} hours on ${projectName ?? "your project"}`,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
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

export interface ProjectExpenseLineInput {
  project_id?: string | null
  cost_code_id?: string | null
  budget_line_id?: string | null
  description?: string | null
  amount_cents: number
  qbo_expense_account_id?: string | null
  qbo_expense_account_name?: string | null
}

/**
 * Replace the cost-allocation splits on an expense (mirrors replaceBillLineCoding).
 * Lines must sum to the expense total (amount + tax). Passing an empty array clears
 * the splits and reverts the expense to its single-line behaviour.
 */
export async function replaceProjectExpenseLines(args: {
  expenseId: string
  lines: ProjectExpenseLineInput[]
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(args.orgId)

  const { data: expense, error: expenseError } = await supabase
    .from("project_expenses")
    .select("id, project_id, amount_cents, tax_cents, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", args.expenseId)
    .maybeSingle()
  if (expenseError || !expense) throw new Error("Expense not found")

  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: expense.project_id, permission: "bill.write" })

  // Capture the previous splits up-front: if the expense already posted to the cost
  // ledger we must void those rows and re-post against the new allocation.
  const { data: priorLines } = await supabase
    .from("project_expense_lines")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("expense_id", args.expenseId)
  const priorLineIds = (priorLines ?? []).map((line) => line.id as string)
  const alreadyPosted = ["approved", "locked"].includes(String(expense.status))

  if (alreadyPosted) {
    // Block edits that would rewrite a cost that's already been billed on an invoice.
    const billed = await supabase
      .from("billable_costs")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .not("invoice_id", "is", null)
      .or(
        [
          `and(source_type.eq.project_expense,source_id.eq.${args.expenseId})`,
          priorLineIds.length > 0 ? `and(source_type.eq.project_expense_line,source_id.in.(${priorLineIds.join(",")}))` : null,
        ]
          .filter(Boolean)
          .join(","),
      )
      .limit(1)
    if ((billed.data ?? []).length > 0) {
      throw new Error("This expense has costs already billed on an invoice. Remove them from the invoice before changing the split.")
    }
  }

  const lines = args.lines ?? []
  if (lines.length > 0) {
    const totalCents = Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0)
    const allocated = lines.reduce((sum, line) => sum + Math.round(Number(line.amount_cents ?? 0)), 0)
    if (allocated !== totalCents) {
      throw new Error(`Splits must total ${(totalCents / 100).toFixed(2)} (currently ${(allocated / 100).toFixed(2)})`)
    }

    const costCodeIds = Array.from(
      new Set(lines.map((line) => line.cost_code_id).filter((id): id is string => typeof id === "string" && id.length > 0)),
    )
    if (costCodeIds.length > 0) {
      const { data: costCodes, error: costCodeError } = await supabase
        .from("cost_codes")
        .select("id")
        .eq("org_id", resolvedOrgId)
        .in("id", costCodeIds)
      if (costCodeError || (costCodes ?? []).length !== costCodeIds.length) {
        throw new Error("Cost code not found")
      }
    }
  }

  const { error: deleteError } = await supabase
    .from("project_expense_lines")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("expense_id", args.expenseId)
  if (deleteError) throw new Error(`Failed to update expense splits: ${deleteError.message}`)

  if (lines.length > 0) {
    const rows = lines.map((line, index) => ({
      org_id: resolvedOrgId,
      expense_id: args.expenseId,
      project_id: line.project_id ?? expense.project_id,
      cost_code_id: line.cost_code_id ?? null,
      budget_line_id: line.budget_line_id ?? null,
      description: line.description?.trim() || null,
      amount_cents: Math.round(Number(line.amount_cents ?? 0)),
      qbo_expense_account_id: line.qbo_expense_account_id ?? null,
      qbo_expense_account_name: line.qbo_expense_account_name ?? null,
      sort_order: index,
    }))
    const { error: insertError } = await supabase.from("project_expense_lines").insert(rows)
    if (insertError) throw new Error(`Failed to update expense splits: ${insertError.message}`)

    // Keep the parent's primary coding coherent with the first split so single-line
    // consumers (budget rollups, QBO fallbacks) still resolve sensibly.
    const first = rows[0]
    await supabase
      .from("project_expenses")
      .update({
        cost_code_id: first.cost_code_id,
        budget_line_id: first.budget_line_id,
        qbo_expense_account_id: first.qbo_expense_account_id,
        qbo_expense_account_name: first.qbo_expense_account_name,
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", args.expenseId)
  }

  // If the expense has already entered the cost ledger, re-post it against the new
  // allocation so budget/WIP and cost-plus billable costs reflect the split immediately.
  if (alreadyPosted) {
    await resyncApprovedExpenseLedger(supabase, resolvedOrgId, {
      expenseId: args.expenseId,
      expenseProjectId: expense.project_id,
      priorLineIds,
      hasNewLines: lines.length > 0,
      // Billable costs only post for `approved` expenses; `locked` ones are past that stage.
      canPostBillable: expense.status === "approved",
    })
  }
}

/** Void the prior cost-ledger rows for an approved expense and re-post the current allocation. */
async function resyncApprovedExpenseLedger(
  supabase: SupabaseClient,
  orgId: string,
  args: { expenseId: string; expenseProjectId: string; priorLineIds: string[]; hasNewLines: boolean; canPostBillable: boolean },
) {
  // 1. Void the previous ledger rows (whole-expense + every prior split).
  await voidJobCostEntryForSource({ sourceType: "project_expense", sourceId: args.expenseId, orgId })
  await supabase
    .from("billable_costs")
    .update({ status: "voided" })
    .eq("org_id", orgId)
    .eq("source_type", "project_expense")
    .eq("source_id", args.expenseId)
    .is("invoice_id", null)

  for (const lineId of args.priorLineIds) {
    await voidJobCostEntryForSource({ sourceType: "project_expense_line", sourceId: lineId, orgId })
  }
  if (args.priorLineIds.length > 0) {
    await supabase
      .from("billable_costs")
      .update({ status: "voided" })
      .eq("org_id", orgId)
      .eq("source_type", "project_expense_line")
      .in("source_id", args.priorLineIds)
      .is("invoice_id", null)
  }

  // 2. Re-post against the new allocation, resolving each project's contract once.
  const contractCostPlusByProject = new Map<string, boolean>()
  const isCostPlusProject = async (projectId: string) => {
    if (!contractCostPlusByProject.has(projectId)) {
      const contract = await getProjectCostContract(supabase, orgId, projectId)
      contractCostPlusByProject.set(projectId, isCostPlusContract(contract))
    }
    return contractCostPlusByProject.get(projectId)!
  }

  if (args.hasNewLines) {
    await supabase.from("project_expenses").update({ billable_cost_id: null }).eq("org_id", orgId).eq("id", args.expenseId)
    const { data: newLines } = await supabase
      .from("project_expense_lines")
      .select("id, project_id")
      .eq("org_id", orgId)
      .eq("expense_id", args.expenseId)
      .order("sort_order", { ascending: true })
    for (const line of newLines ?? []) {
      const projectId = line.project_id ?? args.expenseProjectId
      if (args.canPostBillable && (await isCostPlusProject(projectId))) {
        await upsertBillableCostFromExpenseLine({ expenseLineId: line.id, orgId })
      }
      await postJobCostEntryFromExpenseLine({ expenseLineId: line.id, orgId })
    }
    return
  }

  // Collapsed back to a single allocation: re-post the whole-expense ledger rows.
  if (args.canPostBillable && (await isCostPlusProject(args.expenseProjectId))) {
    await upsertBillableCostFromExpense({ expenseId: args.expenseId, orgId })
  }
  await postJobCostEntryFromProjectExpense({ expenseId: args.expenseId, orgId })
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
    qbo_vendor_id: parsed.qboVendorId ?? null,
    qbo_vendor_name: parsed.qboVendorName ?? null,
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

  const gateSettings = await loadApprovalGateSettings({ supabase, orgId: resolvedOrgId, projectId: before.project_id })
  assertApprovalAllowed(getExpenseApprovalBlockingReasons(before, gateSettings))

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
  if (["approved", "locked"].includes(String(before.status))) {
    await voidJobCostEntryForSource({ sourceType: "project_expense", sourceId: data.id, orgId: resolvedOrgId })
    const { data: lines } = await supabase
      .from("project_expense_lines")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("expense_id", data.id)
    for (const line of lines ?? []) {
      await voidJobCostEntryForSource({ sourceType: "project_expense_line", sourceId: line.id, orgId: resolvedOrgId })
    }
  }
  return data
}

export async function createTimeEntryFromPortal({ token, input }: { token: string; input: TimeEntryInput }) {
  const portalToken = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_submit_time",
  })
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
    ot_multiplier: parsed.otMultiplier,
    is_double_time: parsed.isDoubleTime,
    dt_multiplier: parsed.dtMultiplier,
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
  const portalToken = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_submit_expenses",
  })
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

export async function listProjectTimeEntries(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId, permission: "time.read" })

  const [reviewableTimeEntries, recentTimeEntries] = await Promise.all([
    supabase
      .from("time_entries")
      .select("*, cost_code:cost_codes(code, name)")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .in("status", ["submitted", "pm_approved"])
      .order("work_date", { ascending: false }),
    supabase
      .from("time_entries")
      .select("*, cost_code:cost_codes(code, name)")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .in("status", ["client_approved", "locked", "rejected"])
      .order("work_date", { ascending: false })
      .limit(50),
  ])

  if (reviewableTimeEntries.error) throw new Error(`Failed to load reviewable time entries: ${reviewableTimeEntries.error.message}`)
  if (recentTimeEntries.error) throw new Error(`Failed to load recent time entries: ${recentTimeEntries.error.message}`)

  return Array.from(
    new Map([...(reviewableTimeEntries.data ?? []), ...(recentTimeEntries.data ?? [])].map((entry: any) => [entry.id, entry])).values(),
  )
}

export async function listCostPlusTabData(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId, permission: "invoice.read" })

  const [billableCosts, reviewableTimeEntries, recentTimeEntries, reviewableExpenses, recentExpenses, gmpSummary] = await Promise.all([
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
      .in("status", ["submitted", "pm_approved"])
      .order("work_date", { ascending: false }),
    supabase
      .from("time_entries")
      .select("*, cost_code:cost_codes(code, name)")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .in("status", ["client_approved", "locked", "rejected"])
      .order("work_date", { ascending: false })
      .limit(50),
    supabase
      .from("project_expenses")
      .select("*, cost_code:cost_codes(code, name), vendor_company:companies(name)")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .in("status", ["draft", "submitted"])
      .order("expense_date", { ascending: false }),
    supabase
      .from("project_expenses")
      .select("*, cost_code:cost_codes(code, name), vendor_company:companies(name)")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .in("status", ["approved", "locked", "rejected"])
      .order("expense_date", { ascending: false })
      .limit(50),
    getProjectGmpControlSummary(projectId, resolvedOrgId).catch(() => null),
  ])

  if (billableCosts.error) throw new Error(`Failed to load billable costs: ${billableCosts.error.message}`)
  if (reviewableTimeEntries.error) throw new Error(`Failed to load reviewable time entries: ${reviewableTimeEntries.error.message}`)
  if (recentTimeEntries.error) throw new Error(`Failed to load recent time entries: ${recentTimeEntries.error.message}`)
  if (reviewableExpenses.error) throw new Error(`Failed to load reviewable expenses: ${reviewableExpenses.error.message}`)
  if (recentExpenses.error) throw new Error(`Failed to load recent expenses: ${recentExpenses.error.message}`)

  const timeRows = Array.from(
    new Map([...(reviewableTimeEntries.data ?? []), ...(recentTimeEntries.data ?? [])].map((entry: any) => [entry.id, entry])).values(),
  )
  const expenseRows = Array.from(
    new Map([...(reviewableExpenses.data ?? []), ...(recentExpenses.data ?? [])].map((expense: any) => [expense.id, expense])).values(),
  )
  const expenseIds = expenseRows.map((expense) => expense.id).filter(Boolean)
  const linesByExpense = new Map<string, any[]>()
  if (expenseIds.length > 0) {
    const { data: lineRows, error: lineError } = await supabase
      .from("project_expense_lines")
      .select("*, cost_code:cost_codes(code, name)")
      .eq("org_id", resolvedOrgId)
      .in("expense_id", expenseIds)
      .order("sort_order", { ascending: true })
    if (lineError) throw new Error(`Failed to load expense lines: ${lineError.message}`)
    for (const line of lineRows ?? []) {
      const existing = linesByExpense.get(line.expense_id)
      if (existing) existing.push(line)
      else linesByExpense.set(line.expense_id, [line])
    }
  }

  return {
    billableCosts: (billableCosts.data ?? []).map(mapBillableCost),
    timeEntries: timeRows,
    expenses: expenseRows.map((expense) => ({ ...expense, lines: linesByExpense.get(expense.id) ?? [] })),
    gmpSummary,
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
  if (!shouldExposeOpenBookCostDetail(contract?.open_book)) return []

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

export function buildInvoiceDraft({
  projectId,
  costs,
  groupBy,
  feePresentation = "embedded",
}: {
  projectId: string
  costs: BillableCost[]
  groupBy: "cost_code" | "detail"
  feePresentation?: FeePresentation
}): InvoiceDraft {
  const issueDate = toDateOnly(new Date())
  const lineMap = new Map<string, InvoiceDraftLine>()
  const feeLineMap = new Map<string, InvoiceDraftLine>()
  const separatesFee = feePresentation === "separate_total" || feePresentation === "separate_by_code"

  for (const cost of costs) {
    const key = groupBy === "detail" ? cost.id : cost.cost_code_id ?? "uncoded"
    const feeKey = feePresentation === "separate_by_code" ? cost.cost_code_id ?? "uncoded" : "builder_fee"
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
        markup_percent: separatesFee ? 0 : Number(cost.markup_percent_resolved ?? 0),
        billable_cost_ids: [],
        metadata: {
          fee_presentation: feePresentation,
          cost_line_kind: separatesFee ? "reimbursable_cost" : "embedded_cost",
        },
      } satisfies InvoiceDraftLine)

    current.cost_cents += cost.cost_cents
    current.markup_cents += separatesFee ? 0 : cost.markup_cents
    current.billable_cents += separatesFee ? cost.cost_cents : cost.billable_cents
    current.billable_cost_ids.push(cost.id)
    lineMap.set(key, current)

    if (separatesFee && cost.markup_cents !== 0) {
      const feeDescription =
        feePresentation === "separate_by_code"
          ? `Builder's fee - ${fallbackDescription}`
          : "Builder's fee"
      const feeLine =
        feeLineMap.get(feeKey) ??
        ({
          cost_code_id: feePresentation === "separate_by_code" ? cost.cost_code_id ?? null : null,
          cost_code_code: feePresentation === "separate_by_code" ? cost.cost_code_code ?? null : null,
          cost_code_name: feePresentation === "separate_by_code" ? cost.cost_code_name ?? null : null,
          description: feeDescription,
          unit: "fee",
          cost_cents: 0,
          markup_cents: 0,
          billable_cents: 0,
          markup_percent: 0,
          billable_cost_ids: [],
          metadata: {
            taxable: false,
            fee_presentation: feePresentation,
            fee_line_kind: "cost_markup",
            system_generated_kind: "cost_markup_fee",
            related_billable_cost_ids: [],
          },
        } satisfies InvoiceDraftLine)
      feeLine.markup_cents += cost.markup_cents
      feeLine.billable_cents += cost.markup_cents
      const relatedIds = (feeLine.metadata?.related_billable_cost_ids ?? []) as string[]
      relatedIds.push(cost.id)
      feeLine.metadata = { ...(feeLine.metadata ?? {}), related_billable_cost_ids: relatedIds }
      feeLineMap.set(feeKey, feeLine)
    }
  }

  const costLines = Array.from(lineMap.values()).sort((a, b) =>
    `${a.cost_code_code ?? ""}${a.description}`.localeCompare(`${b.cost_code_code ?? ""}${b.description}`),
  )
  const feeLines = Array.from(feeLineMap.values()).sort((a, b) =>
    `${a.cost_code_code ?? ""}${a.description}`.localeCompare(`${b.cost_code_code ?? ""}${b.description}`),
  )
  const lines = [...costLines, ...feeLines].map((line, index) => ({ ...line, sort_order: index }))
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

function appendEarnedFeeLineToDraft(draft: InvoiceDraft, amountCents: number): InvoiceDraft {
  if (amountCents <= 0) return draft
  const nextLines = [
    ...draft.lines,
    {
      description: "Construction management fee",
      unit: "fee",
      cost_cents: 0,
      markup_cents: 0,
      billable_cents: amountCents,
      markup_percent: 0,
      billable_cost_ids: [],
      sort_order: draft.lines.length,
      metadata: {
        taxable: false,
        fee_line_kind: "fixed_fee_earned",
        system_generated_kind: "earned_fee",
      },
    } satisfies InvoiceDraftLine,
  ]

  return {
    ...draft,
    title: "Cost-plus billing",
    lines: nextLines,
    totals: {
      ...draft.totals,
      billable_cents: draft.totals.billable_cents + amountCents,
      earned_fee_cents: amountCents,
    } as InvoiceDraft["totals"],
  }
}

export async function generateInvoiceFromCosts(
  input: GenerateInvoiceFromCostsInput,
  orgId?: string,
): Promise<GenerateInvoiceFromCostsResult> {
  const parsed = generateInvoiceFromCostsInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectFinancialAccess({ supabase, orgId: resolvedOrgId, userId, projectId: parsed.projectId, permission: "invoice.write" })

  const billingPeriod = parsed.billingPeriodId
    ? await getProjectBillingPeriod({
        supabase,
        orgId: resolvedOrgId,
        projectId: parsed.projectId,
        billingPeriodId: parsed.billingPeriodId,
      })
    : null
  if (parsed.billingPeriodId && !billingPeriod) throw new Error("Billing period not found")
  if (billingPeriod) assertBillingPeriodCanInvoice(billingPeriod)

  const from = billingPeriod?.period_start ?? toDateOnly(parsed.dateRange.from)
  const to = billingPeriod?.period_end ?? toDateOnly(parsed.dateRange.to)
  const today = toDateOnly(new Date())
  if (to > today) throw new Error("Cannot generate an invoice for a future date range")
  if (from > to) throw new Error("Date range start must be before the end date")

  const contract = await getProjectCostContract(supabase, resolvedOrgId, parsed.projectId)
  if (!isCostPlusContract(contract)) throw new Error("Project contract is not cost-plus or T&M")
  const billingModel = resolveProjectBillingModel(contract as any)
  const feePresentation = resolveContractFeePresentation(contract as any)

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
    .order("occurred_on", { ascending: true })

  if (parsed.costCodeIds?.length) query = query.in("cost_code_id", parsed.costCodeIds)
  if (parsed.billableCostIds?.length) {
    query = query.in("id", parsed.billableCostIds)
  } else {
    query = query.gte("occurred_on", from).lte("occurred_on", to)
  }

  const { data: rawCosts, error } = await query
  if (error) throw new Error(`Failed to load billable costs: ${error.message}`)

  const refreshedCosts: BillableCost[] = []
  const snapshotMarkupSources = new Set([
    "line",
    "tm_rate_schedule",
    "tm_material_schedule",
    "tm_project_override",
    "tm_membership_fallback",
  ])
  const costsNeedingMarkupRefresh = (rawCosts ?? []).filter(
    (rawCost: any) =>
      !snapshotMarkupSources.has(rawCost.metadata?.markup_source) &&
      rawCost.metadata?.billing_method !== "time_and_materials_rate",
  )
  const refreshedMarkups = await resolveMarkupPercentsBatch({
    supabase,
    orgId: resolvedOrgId,
    contractId: contract.id,
    costs: costsNeedingMarkupRefresh.map((rawCost: any) => ({
      costCodeId: rawCost.cost_code_id ?? null,
      costCodeCategory: rawCost.cost_code?.category ?? null,
      occurredOn: rawCost.occurred_on,
    })),
  })
  let refreshedMarkupIndex = 0
  for (const rawCost of rawCosts ?? []) {
    if (
      snapshotMarkupSources.has(rawCost.metadata?.markup_source) ||
      rawCost.metadata?.billing_method === "time_and_materials_rate"
    ) {
      refreshedCosts.push(mapBillableCost(rawCost))
      continue
    }

    const markup = refreshedMarkups[refreshedMarkupIndex++] ?? { percent: 0, source: "default" as MarkupSource }
    const markupCents = calculateMarkupCents(rawCost.cost_cents ?? 0, markup.percent)
    const billableCents = Number(rawCost.cost_cents ?? 0) + markupCents
    const refreshedMetadata = { ...(rawCost.metadata ?? {}), markup_source: markup.source }

    if (
      Number(rawCost.markup_percent_resolved ?? 0) !== markup.percent ||
      Number(rawCost.markup_cents ?? 0) !== markupCents ||
      Number(rawCost.billable_cents ?? 0) !== billableCents ||
      rawCost.metadata?.markup_source !== markup.source
    ) {
      const { error: refreshError } = await supabase
        .from("billable_costs")
        .update({
          markup_percent_resolved: markup.percent,
          markup_cents: markupCents,
          billable_cents: billableCents,
          metadata: refreshedMetadata,
        })
        .eq("org_id", resolvedOrgId)
        .eq("id", rawCost.id)
        .eq("status", "open")

      if (refreshError) throw new Error(`Failed to refresh billable cost markup: ${refreshError.message}`)
    }

    refreshedCosts.push(
      mapBillableCost({
        ...rawCost,
        markup_percent_resolved: markup.percent,
        markup_cents: markupCents,
        billable_cents: billableCents,
        metadata: refreshedMetadata,
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

  let preparedFeeBilling: PreparedProjectFeeBilling | null = null
  let earnedFeeCents = 0
  if (parsed.includeEarnedFee) {
    if (billingModel !== "cost_plus_fixed_fee") {
      throw new Error("Earned fee can only be included for cost-plus fixed-fee projects.")
    }
    if (parsed.dryRun) {
      const feeSummary = await getProjectFeeBillingSummary(parsed.projectId, resolvedOrgId)
      if (!feeSummary.enabled) throw new Error(feeSummary.reason ?? "Fee billing is not available for this project.")
      earnedFeeCents = feeSummary.billable_fee_cents
      if (earnedFeeCents <= 0) throw new Error("No earned fee is available to bill.")
    } else {
      preparedFeeBilling = await prepareProjectFeeBillingForOwnerInvoice({
        supabase,
        orgId: resolvedOrgId,
        projectId: parsed.projectId,
        userId,
      })
      earnedFeeCents = preparedFeeBilling.amountCents
    }
  }

  const costDraft = buildInvoiceDraft({
    projectId: parsed.projectId,
    costs: refreshedCosts,
    groupBy: parsed.groupBy,
    feePresentation,
  })
  const preview = applyRetainageToInvoiceDraft(
    earnedFeeCents > 0 ? appendEarnedFeeLineToDraft(costDraft, earnedFeeCents) : costDraft,
    contract.retainage_percent,
  )
  const warnings: Array<{ code: string; message: string; billableCostId?: string }> = []
  let gmpCapOverridden = false

  if (billingModel === "cost_plus_gmp") {
    const [gmpSummary, billedInsideGmp] = await Promise.all([
      getProjectGmpControlSummary(parsed.projectId, resolvedOrgId),
      supabase
        .from("billable_costs")
        .select("billable_cents")
        .eq("org_id", resolvedOrgId)
        .eq("project_id", parsed.projectId)
        .eq("gmp_classification", "inside_gmp")
        .neq("status", "voided")
        .not("invoice_id", "is", null),
    ])
    if (billedInsideGmp.error) throw new Error(`Failed to load billed GMP costs: ${billedInsideGmp.error.message}`)

    const alreadyBilledInsideGmpCents = (billedInsideGmp.data ?? []).reduce(
      (sum: number, row: any) => sum + Number(row.billable_cents ?? 0),
      0,
    )
    const invoiceInsideGmpCents = refreshedCosts
      .filter((cost) => cost.gmp_classification !== "outside_gmp")
      .reduce((sum, cost) => sum + Number(cost.billable_cents ?? 0), 0)
    const cumulativeInsideGmpCents = alreadyBilledInsideGmpCents + invoiceInsideGmpCents
    const overageCents = cumulativeInsideGmpCents - Number(gmpSummary.revised_gmp_cents ?? 0)

    if (gmpSummary.enabled && overageCents > 0) {
      const warning = {
        code: "gmp_cap_exceeded",
        message: `This invoice would exceed the revised GMP by ${formatCurrencyCents(overageCents)}.`,
      }
      warnings.push(warning)
      if (!parsed.dryRun && !parsed.overrideGmpCap) {
        throw new Error(`${warning.message} Check "bill anyway" to override the GMP cap.`)
      }
      gmpCapOverridden = !parsed.dryRun && parsed.overrideGmpCap
    }
  }

  const resultBase = {
    invoicePreview: preview,
    costCount: refreshedCosts.length,
    totalCostCents: preview.totals.cost_cents,
    totalMarkupCents: preview.totals.markup_cents,
    totalBillableCents: preview.totals.billable_cents,
    excludedCount: excludedCount ?? 0,
    warnings,
  }

  if (parsed.dryRun || refreshedCosts.length === 0) return resultBase

  const costIds = refreshedCosts.map((cost) => cost.id)
  const invoiceNumber = await getNextInvoiceNumber(resolvedOrgId)
  const token = randomUUID()
  const approvedCostInvoice = await createApprovedCostInvoiceFromPreview({
    supabase,
    orgId: resolvedOrgId,
    projectId: parsed.projectId,
    actorId: userId,
    invoiceNumber: invoiceNumber.number,
    token,
    title: `Cost-plus billing ${from} to ${to}`,
    issueDate: preview.issueDate,
    dueDate: preview.dueDate,
    fromDate: from,
    toDate: to,
    groupBy: parsed.groupBy,
    costIds,
    preview,
    idempotencyKey: parsed.idempotencyKey ?? null,
    reservationId: invoiceNumber.reservation_id ?? null,
    status: "saved",
    clientVisible: false,
    metadata: {
      source_type: "from_costs",
      created_by: userId,
      fee_presentation: feePresentation,
      include_earned_fee: earnedFeeCents > 0,
      earned_fee_cents: earnedFeeCents > 0 ? earnedFeeCents : null,
      retainage_percent: contract.retainage_percent ?? null,
      retainage_amount_cents: preview.totals.retainage_cents ?? null,
      gross_billable_cents: preview.totals.gross_billable_cents ?? preview.totals.billable_cents,
      gmp_cap_overridden: gmpCapOverridden,
      billing_period_id: billingPeriod?.id ?? null,
      billing_period_name: billingPeriod?.name ?? null,
      billing_period_start: billingPeriod?.period_start ?? null,
      billing_period_end: billingPeriod?.period_end ?? null,
    },
    auditLabel: "cost_inbox",
  })

  const invoiceId = approvedCostInvoice.invoiceId
  const finalPreview = approvedCostInvoice.invoicePreview ?? preview
  if (preparedFeeBilling) {
    const { data: feeLine, error: feeLineError } = await supabase
      .from("invoice_lines")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("invoice_id", invoiceId)
      .eq("unit", "fee")
      .eq("metadata->>fee_line_kind", "fixed_fee_earned")
      .maybeSingle()

    if (feeLineError) throw new Error(`Failed to load fee invoice line: ${feeLineError.message}`)
    if (!feeLine?.id) throw new Error("Approved-cost invoice was created without the earned fee line.")

    await recordProjectFeeBillingForInvoice({
      supabase,
      orgId: resolvedOrgId,
      projectId: parsed.projectId,
      userId,
      invoiceId,
      invoiceLineId: feeLine.id,
      billingPeriodId: billingPeriod?.id ?? null,
      prepared: preparedFeeBilling,
      source: "approved_cost_invoice",
      invoiceMetadata: {
        include_earned_fee: true,
        earned_fee_cents: preparedFeeBilling.amountCents,
      },
    })
  }
  if (billingPeriod) {
    await linkInvoiceToBillingPeriod({
      supabase,
      orgId: resolvedOrgId,
      projectId: parsed.projectId,
      billingPeriodId: billingPeriod.id,
      invoiceId,
      costIds,
    })
  }

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
      fee_presentation: feePresentation,
      earned_fee_cents: earnedFeeCents > 0 ? earnedFeeCents : null,
      billing_period_id: billingPeriod?.id ?? null,
    },
  })
  if (preparedFeeBilling) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "project_fee_billed_on_approved_cost_invoice",
      entityType: "invoice",
      entityId: invoiceId,
      payload: {
        project_id: parsed.projectId,
        schedule_id: preparedFeeBilling.summary.schedule?.id,
        amount_cents: preparedFeeBilling.amountCents,
        allocations: preparedFeeBilling.allocations,
      },
    })
  }
  if (gmpCapOverridden) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "gmp_cap_overridden",
      entityType: "invoice",
      entityId: invoiceId,
      payload: {
        project_id: parsed.projectId,
        total_cents: preview.totals.gross_billable_cents ?? preview.totals.billable_cents,
        billable_cost_ids: costIds,
      },
    })
  }
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
      totals: finalPreview.totals,
    },
  })

  return {
    ...resultBase,
    invoiceId,
    invoicePreview: finalPreview,
    totalBillableCents: finalPreview.totals.billable_cents,
  }
}
