import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { resolveProjectBillingModel, type ProjectBillingModel } from "@/lib/financials/billing-model"
import type { Contract, Invoice, Project } from "@/lib/types"
import { requireAuthorization } from "@/lib/services/authorization"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createInvoice } from "@/lib/services/invoices"
import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"

export type GmpClassification = "inside_gmp" | "outside_gmp"
export type GmpImpact = "none" | "increase_gmp" | "decrease_gmp" | "outside_gmp"

export type ProjectGmpWarning = {
  code:
    | "missing_gmp"
    | "missing_budget_eac"
    | "approaching_gmp"
    | "gmp_overrun"
    | "outside_gmp_exposure"
    | "unposted_co_exposure"
    | "contingency_overdrawn"
  severity: "info" | "warning" | "critical"
  message: string
  amount_cents?: number
}

export type ProjectGmpControlSummary = {
  enabled: boolean
  reason?: string
  project_id: string
  contract_id?: string | null
  billing_model: ProjectBillingModel
  base_gmp_cents: number
  approved_gmp_change_cents: number
  revised_gmp_cents: number
  inside_gmp_eac_cents: number
  outside_gmp_eac_cents: number
  inside_gmp_actual_cents: number
  outside_gmp_actual_cents: number
  contingency_cents: number
  contingency_drawdown_cents: number
  contingency_remaining_cents: number
  savings_cents: number
  overrun_cents: number
  owner_savings_cents: number
  builder_savings_cents: number
  savings_settled_at?: string | null
  savings_settlement_invoice_ids?: string[]
  savings_settlement_credit_memo_id?: string | null
  savings_settlement_builder_invoice_id?: string | null
  percent_of_gmp: number | null
  status: "ok" | "watch" | "overrun" | "not_configured"
  warnings: ProjectGmpWarning[]
  generated_at: string
}

export type ProjectGmpSnapshotTrendPoint = {
  id: string
  snapshot_date: string
  revised_gmp_cents: number
  inside_gmp_eac_cents: number
  savings_cents: number
  overrun_cents: number
  status: ProjectGmpControlSummary["status"]
}

export type GmpContingencyEntry = {
  id: string
  org_id: string
  project_id: string
  contract_id?: string | null
  amount_cents: number
  reason: string
  approved_by?: string | null
  metadata: Record<string, any>
  created_at: string
}

export type GmpSavingsSettlementResult = {
  summary: ProjectGmpControlSummary
  owner_credit_invoice: Invoice | null
  builder_share_invoice: Invoice | null
  savings_settled_at: string
}

type ProjectRow = Pick<
  Project,
  "id" | "org_id" | "name" | "status" | "qbo_customer_id" | "qbo_customer_name" | "financial_settings" | "billing_contract"
>

const contingencyDrawdownInputSchema = z.object({
  projectId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
  metadata: z.record(z.unknown()).optional(),
})

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function normalizeClassification(value: unknown): GmpClassification {
  return value === "outside_gmp" ? "outside_gmp" : "inside_gmp"
}

export function normalizeGmpImpact(value: unknown): GmpImpact {
  if (value === "increase_gmp" || value === "decrease_gmp" || value === "outside_gmp") return value
  return "none"
}

export function calculateGmpDeltaCents(amountCents: number, impact: GmpImpact) {
  if (impact === "increase_gmp") return Math.abs(amountCents)
  if (impact === "decrease_gmp") return -Math.abs(amountCents)
  return 0
}

function calculateSavingsSplit({
  savingsCents,
  contract,
}: {
  savingsCents: number
  contract: Contract | null
}) {
  const ownerPct = numberOrZero(contract?.savings_split_owner_pct)
  const builderPct = numberOrZero(contract?.savings_split_builder_pct)
  const totalPct = ownerPct + builderPct

  if (savingsCents <= 0 || totalPct <= 0) {
    return { owner_savings_cents: 0, builder_savings_cents: 0 }
  }

  const ownerSavings = Math.round(savingsCents * (ownerPct / totalPct))
  return {
    owner_savings_cents: ownerSavings,
    builder_savings_cents: savingsCents - ownerSavings,
  }
}

async function loadProjectAndContract({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}) {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select(
      `
      id,
      org_id,
      name,
      status,
      qbo_customer_id,
      qbo_customer_name,
      financial_settings:project_financial_settings(*),
      billing_contract:contracts(
        id,
        org_id,
        project_id,
        title,
        status,
        contract_type,
        total_cents,
        currency,
        markup_percent,
        gmp_cents,
        contingency_cents,
        savings_split_owner_pct,
        savings_split_builder_pct,
        labor_burden_multiplier,
        requires_client_cost_approval,
        open_book,
        retainage_percent,
        snapshot,
        created_at,
        updated_at
      )
    `,
    )
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()

  if (projectError) {
    throw new Error(`Failed to load GMP project context: ${projectError.message}`)
  }
  if (!project) {
    throw new Error("Project not found")
  }

  const row = project as any
  const contracts = Array.isArray(row.billing_contract) ? row.billing_contract : row.billing_contract ? [row.billing_contract] : []
  const activeContract = (contracts.find((contract: Contract) => contract.status === "active") ?? contracts[0] ?? null) as Contract | null

  return {
    project: {
      id: row.id,
      org_id: row.org_id,
      name: row.name,
      status: row.status,
      qbo_customer_id: row.qbo_customer_id ?? null,
      qbo_customer_name: row.qbo_customer_name ?? null,
      financial_settings: Array.isArray(row.financial_settings) ? row.financial_settings[0] ?? null : row.financial_settings ?? null,
      billing_contract: activeContract,
    } as ProjectRow,
    contract: activeContract,
  }
}

async function sumApprovedGmpChangeOrders({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}) {
  const { data, error } = await supabase
    .from("change_order_lines")
    .select(
      `
      gmp_classification,
      gmp_impact,
      gmp_delta_cents,
      metadata,
      change_order:change_orders!inner(id, project_id, status)
    `,
    )
    .eq("org_id", orgId)
    .eq("change_order.project_id", projectId)
    .eq("change_order.status", "approved")

  if (error) {
    throw new Error(`Failed to load GMP change order lines: ${error.message}`)
  }

  return (data ?? []).reduce(
    (totals, row: any) => {
      const metadata = row.metadata ?? {}
      const classification = normalizeClassification(row.gmp_classification ?? metadata.gmp_classification)
      const impact = normalizeGmpImpact(row.gmp_impact ?? metadata.gmp_impact)
      const delta = numberOrZero(row.gmp_delta_cents) || numberOrZero(metadata.gmp_delta_cents)

      if (classification === "outside_gmp") {
        totals.outside_line_count += 1
      }
      totals.approved_gmp_change_cents += delta
      if (impact !== "none") {
        totals.impacted_line_count += 1
      }
      return totals
    },
    {
      approved_gmp_change_cents: 0,
      outside_line_count: 0,
      impacted_line_count: 0,
    },
  )
}

async function sumOutsideGmpBudgetExposure({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}) {
  const { data, error } = await supabase
    .from("budget_revision_lines")
    .select(
      `
      amount_cents,
      gmp_classification,
      metadata,
      budget_revision:budget_revisions!inner(project_id, status)
    `,
    )
    .eq("org_id", orgId)
    .eq("budget_revision.project_id", projectId)
    .eq("budget_revision.status", "posted")

  if (error) {
    throw new Error(`Failed to load GMP budget revision exposure: ${error.message}`)
  }

  return (data ?? []).reduce((sum, row: any) => {
    const classification = normalizeClassification(row.gmp_classification ?? row.metadata?.gmp_classification)
    return classification === "outside_gmp" ? sum + numberOrZero(row.amount_cents) : sum
  }, 0)
}

async function sumGmpActuals({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}) {
  const { data, error } = await supabase
    .from("job_cost_entries")
    .select("cost_cents, gmp_classification, metadata")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["approved", "posted"])

  if (error) {
    throw new Error(`Failed to load GMP actuals: ${error.message}`)
  }

  return (data ?? []).reduce(
    (totals, row: any) => {
      const classification = normalizeClassification(row.gmp_classification ?? row.metadata?.gmp_classification)
      const costCents = numberOrZero(row.cost_cents)
      if (classification === "outside_gmp") {
        totals.outside_gmp_actual_cents += costCents
      } else {
        totals.inside_gmp_actual_cents += costCents
      }
      return totals
    },
    { inside_gmp_actual_cents: 0, outside_gmp_actual_cents: 0 },
  )
}

async function sumGmpContingencyEntries({
  supabase,
  orgId,
  projectId,
  contractId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  contractId?: string | null
}) {
  let query = supabase
    .from("gmp_contingency_entries")
    .select("amount_cents")
    .eq("org_id", orgId)
    .eq("project_id", projectId)

  if (contractId) {
    query = query.eq("contract_id", contractId)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to load GMP contingency entries: ${error.message}`)
  }

  return (data ?? []).reduce(
    (totals, row: any) => {
      const amount = numberOrZero(row.amount_cents)
      totals.net_cents += amount
      if (amount < 0) totals.drawdown_cents += Math.abs(amount)
      return totals
    },
    { net_cents: 0, drawdown_cents: 0 },
  )
}

function getSavingsSettlementSnapshot(contract: Contract | null) {
  const snapshot = (contract?.snapshot ?? {}) as Record<string, any>
  const settlement = (snapshot.gmp_savings_settlement ?? {}) as Record<string, any>
  const invoiceIds = Array.isArray(settlement.invoice_ids)
    ? settlement.invoice_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
    : []

  return {
    savings_settled_at: typeof snapshot.savings_settled_at === "string" ? snapshot.savings_settled_at : null,
    savings_settlement_invoice_ids: invoiceIds,
    savings_settlement_credit_memo_id:
      typeof settlement.owner_credit_invoice_id === "string" ? settlement.owner_credit_invoice_id : null,
    savings_settlement_builder_invoice_id:
      typeof settlement.builder_share_invoice_id === "string" ? settlement.builder_share_invoice_id : null,
  }
}

function formatInvoiceMoney(cents: number) {
  return Math.abs(cents / 100)
}

export async function getProjectGmpControlSummary(
  projectId: string,
  orgId?: string,
): Promise<ProjectGmpControlSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project_gmp_control",
    resourceId: projectId,
  })

  const [{ project, contract }, budgetData, coTotals, outsideBudgetExposure, actuals] = await Promise.all([
    loadProjectAndContract({ supabase, orgId: resolvedOrgId, projectId }),
    getBudgetWithActuals(projectId, resolvedOrgId).catch(() => null),
    sumApprovedGmpChangeOrders({ supabase, orgId: resolvedOrgId, projectId }),
    sumOutsideGmpBudgetExposure({ supabase, orgId: resolvedOrgId, projectId }),
    sumGmpActuals({ supabase, orgId: resolvedOrgId, projectId }),
  ])

  const billingModel = resolveProjectBillingModel(project as any, contract)
  const baseGmpCents = numberOrZero(contract?.gmp_cents)
  const enabled = billingModel === "cost_plus_gmp" || baseGmpCents > 0
  const generatedAt = new Date().toISOString()

  if (!enabled) {
    return {
      enabled: false,
      reason: "GMP control is only available on cost-plus GMP projects.",
      project_id: projectId,
      contract_id: contract?.id ?? null,
      billing_model: billingModel,
      base_gmp_cents: baseGmpCents,
      approved_gmp_change_cents: 0,
      revised_gmp_cents: baseGmpCents,
      inside_gmp_eac_cents: 0,
      outside_gmp_eac_cents: 0,
      inside_gmp_actual_cents: actuals.inside_gmp_actual_cents,
      outside_gmp_actual_cents: actuals.outside_gmp_actual_cents,
      contingency_cents: 0,
      contingency_drawdown_cents: 0,
      contingency_remaining_cents: 0,
      savings_cents: 0,
      overrun_cents: 0,
      owner_savings_cents: 0,
      builder_savings_cents: 0,
      savings_settled_at: null,
      savings_settlement_invoice_ids: [],
      savings_settlement_credit_memo_id: null,
      savings_settlement_builder_invoice_id: null,
      percent_of_gmp: null,
      status: "not_configured",
      warnings: [],
      generated_at: generatedAt,
    }
  }

  const approvedGmpChangeCents = coTotals.approved_gmp_change_cents
  const revisedGmpCents = Math.max(0, baseGmpCents + approvedGmpChangeCents)
  const contingencyCents = numberOrZero(contract?.contingency_cents ?? contract?.snapshot?.contingency_cents)
  const contingencyLedger = await sumGmpContingencyEntries({
    supabase,
    orgId: resolvedOrgId,
    projectId,
    contractId: contract?.id ?? null,
  })
  const contingencyRemainingCents = contingencyCents + contingencyLedger.net_cents
  const totalEacCents = numberOrZero(budgetData?.summary?.total_eac_cents)
  const outsideGmpEacCents = Math.max(
    0,
    outsideBudgetExposure,
    actuals.outside_gmp_actual_cents,
  )
  const insideGmpEacCents = Math.max(0, totalEacCents - outsideGmpEacCents)
  const savingsCents = Math.max(0, revisedGmpCents - insideGmpEacCents)
  const overrunCents = Math.max(0, insideGmpEacCents - revisedGmpCents)
  const savingsSplit = calculateSavingsSplit({ savingsCents, contract })
  const percentOfGmp = revisedGmpCents > 0 ? insideGmpEacCents / revisedGmpCents : null

  const warnings: ProjectGmpWarning[] = []
  if (baseGmpCents <= 0) {
    warnings.push({
      code: "missing_gmp",
      severity: "critical",
      message: "This project is marked cost-plus GMP but the active contract does not have a GMP amount.",
    })
  }
  if (!budgetData?.summary || totalEacCents <= 0) {
    warnings.push({
      code: "missing_budget_eac",
      severity: "warning",
      message: "Budget EAC is missing, so GMP exposure cannot be trusted yet.",
    })
  }
  if (overrunCents > 0) {
    warnings.push({
      code: "gmp_overrun",
      severity: "critical",
      message: "Inside-GMP EAC is forecast above the revised GMP.",
      amount_cents: overrunCents,
    })
  } else if (percentOfGmp != null && percentOfGmp >= 0.9) {
    warnings.push({
      code: "approaching_gmp",
      severity: "warning",
      message: "Inside-GMP EAC is within 10% of the revised GMP.",
      amount_cents: revisedGmpCents - insideGmpEacCents,
    })
  }
  if (outsideGmpEacCents > 0) {
    warnings.push({
      code: "outside_gmp_exposure",
      severity: "info",
      message: "Outside-GMP exposure is being tracked separately from the owner cap.",
      amount_cents: outsideGmpEacCents,
    })
  }
  if (contingencyRemainingCents < 0) {
    warnings.push({
      code: "contingency_overdrawn",
      severity: "warning",
      message: "GMP contingency drawdowns exceed the active contract contingency.",
      amount_cents: Math.abs(contingencyRemainingCents),
    })
  }

  const status: ProjectGmpControlSummary["status"] =
    baseGmpCents <= 0 ? "not_configured" : overrunCents > 0 ? "overrun" : warnings.some((warning) => warning.severity === "warning") ? "watch" : "ok"
  const settlement = getSavingsSettlementSnapshot(contract)

  return {
    enabled: true,
    project_id: projectId,
    contract_id: contract?.id ?? null,
    billing_model: billingModel,
    base_gmp_cents: baseGmpCents,
    approved_gmp_change_cents: approvedGmpChangeCents,
    revised_gmp_cents: revisedGmpCents,
    inside_gmp_eac_cents: insideGmpEacCents,
    outside_gmp_eac_cents: outsideGmpEacCents,
    inside_gmp_actual_cents: actuals.inside_gmp_actual_cents,
    outside_gmp_actual_cents: actuals.outside_gmp_actual_cents,
    contingency_cents: contingencyCents,
    contingency_drawdown_cents: contingencyLedger.drawdown_cents,
    contingency_remaining_cents: contingencyRemainingCents,
    savings_cents: savingsCents,
    overrun_cents: overrunCents,
    owner_savings_cents: savingsSplit.owner_savings_cents,
    builder_savings_cents: savingsSplit.builder_savings_cents,
    ...settlement,
    percent_of_gmp: percentOfGmp,
    status,
    warnings,
    generated_at: generatedAt,
  }
}

export async function recordProjectGmpSnapshot(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const summary = await getProjectGmpControlSummary(projectId, resolvedOrgId)
  const today = new Date().toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from("project_gmp_snapshots")
    .upsert(
      {
        org_id: resolvedOrgId,
        project_id: projectId,
        contract_id: summary.contract_id ?? null,
        snapshot_date: today,
        billing_model: summary.billing_model,
        base_gmp_cents: summary.base_gmp_cents,
        approved_gmp_change_cents: summary.approved_gmp_change_cents,
        revised_gmp_cents: summary.revised_gmp_cents,
        inside_gmp_eac_cents: summary.inside_gmp_eac_cents,
        outside_gmp_eac_cents: summary.outside_gmp_eac_cents,
        inside_gmp_actual_cents: summary.inside_gmp_actual_cents,
        outside_gmp_actual_cents: summary.outside_gmp_actual_cents,
        savings_cents: summary.savings_cents,
        overrun_cents: summary.overrun_cents,
        owner_savings_cents: summary.owner_savings_cents,
        builder_savings_cents: summary.builder_savings_cents,
        status: summary.status,
        warnings: summary.warnings,
        metadata: {
          generated_at: summary.generated_at,
          percent_of_gmp: summary.percent_of_gmp,
          enabled: summary.enabled,
          reason: summary.reason ?? null,
          contingency_cents: summary.contingency_cents,
          contingency_drawdown_cents: summary.contingency_drawdown_cents,
          contingency_remaining_cents: summary.contingency_remaining_cents,
          savings_settled_at: summary.savings_settled_at ?? null,
        },
        created_by: userId,
        updated_by: userId,
      },
      { onConflict: "org_id,project_id,snapshot_date" },
    )
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to record GMP snapshot: ${error?.message}`)
  }

  return { snapshot: data, summary }
}

export async function listProjectGmpSnapshotTrend(
  projectId: string,
  orgId?: string,
  limit = 30,
): Promise<ProjectGmpSnapshotTrendPoint[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project_gmp_snapshots",
    resourceId: projectId,
  })

  const { data, error } = await supabase
    .from("project_gmp_snapshots")
    .select("id, snapshot_date, revised_gmp_cents, inside_gmp_eac_cents, savings_cents, overrun_cents, status")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("snapshot_date", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 120)))

  if (error) {
    throw new Error(`Failed to load GMP snapshot trend: ${error.message}`)
  }

  return (data ?? [])
    .map((row: any) => ({
      id: row.id,
      snapshot_date: row.snapshot_date,
      revised_gmp_cents: numberOrZero(row.revised_gmp_cents),
      inside_gmp_eac_cents: numberOrZero(row.inside_gmp_eac_cents),
      savings_cents: numberOrZero(row.savings_cents),
      overrun_cents: numberOrZero(row.overrun_cents),
      status: (row.status ?? "ok") as ProjectGmpControlSummary["status"],
    }))
    .reverse()
}

export async function recordGmpContingencyDrawdown(input: unknown, orgId?: string) {
  const parsed = contingencyDrawdownInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId: resolvedOrgId,
    projectId: parsed.projectId,
    supabase,
    logDecision: true,
    resourceType: "gmp_contingency_entry",
    resourceId: parsed.projectId,
  })

  const summary = await getProjectGmpControlSummary(parsed.projectId, resolvedOrgId)
  if (!summary.enabled || !summary.contract_id) {
    throw new Error(summary.reason ?? "GMP contingency is only available on active GMP projects.")
  }
  if (parsed.amountCents > Math.max(0, summary.contingency_remaining_cents)) {
    throw new Error("Contingency drawdown cannot exceed the remaining contingency.")
  }

  const payload = {
    org_id: resolvedOrgId,
    project_id: parsed.projectId,
    contract_id: summary.contract_id,
    amount_cents: -Math.abs(parsed.amountCents),
    reason: parsed.reason,
    approved_by: userId,
    metadata: {
      ...(parsed.metadata ?? {}),
      entry_type: "drawdown",
      contingency_remaining_before_cents: summary.contingency_remaining_cents,
      contingency_remaining_after_cents: summary.contingency_remaining_cents - parsed.amountCents,
    },
  }

  const { data, error } = await supabase
    .from("gmp_contingency_entries")
    .insert(payload)
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to record GMP contingency drawdown: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "gmp_contingency_entry",
    entityId: data.id,
    after: data,
    source: "gmp_control",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "gmp_contingency_drawdown_recorded",
    entityType: "gmp_contingency_entry",
    entityId: data.id,
    payload: {
      project_id: parsed.projectId,
      contract_id: summary.contract_id,
      amount_cents: parsed.amountCents,
      reason: parsed.reason,
      contingency_remaining_after_cents: summary.contingency_remaining_cents - parsed.amountCents,
    },
  })

  return {
    entry: data as GmpContingencyEntry,
    summary: await getProjectGmpControlSummary(parsed.projectId, resolvedOrgId),
  }
}

async function createGmpSettlementInvoice(args: {
  orgId: string
  project: ProjectRow
  title: string
  description: string
  unit: string
  amountCents: number
  sourceType?: "manual" | "fee"
}) {
  const nextNumber = await getNextInvoiceNumber(args.orgId)
  const today = new Date().toISOString().slice(0, 10)

  return createInvoice({
    orgId: args.orgId,
    input: {
      project_id: args.project.id,
      invoice_number: nextNumber.number,
      reservation_id: nextNumber.reservation_id,
      title: args.title,
      status: "saved",
      issue_date: today,
      due_date: today,
      client_visible: false,
      tax_rate: 0,
      source_type: args.sourceType ?? "manual",
      customer_name: args.project.qbo_customer_name ?? undefined,
      qbo_customer_id: args.project.qbo_customer_id ?? undefined,
      qbo_customer_name: args.project.qbo_customer_name ?? undefined,
      lines: [
        {
          description: args.description,
          quantity: 1,
          unit: args.unit,
          unit_cost: args.amountCents < 0 ? -formatInvoiceMoney(args.amountCents) : formatInvoiceMoney(args.amountCents),
          taxable: false,
        },
      ],
      notes: "Generated from GMP savings closeout settlement.",
    },
  })
}

export async function settleGmpSavings(projectId: string, orgId?: string): Promise<GmpSavingsSettlementResult> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project_gmp_control",
    resourceId: projectId,
  })

  const { project, contract } = await loadProjectAndContract({ supabase, orgId: resolvedOrgId, projectId })
  if (project.status !== "completed") {
    throw new Error("GMP savings can only be settled after the project is marked complete.")
  }
  if (!contract?.id) {
    throw new Error("An active contract is required to settle GMP savings.")
  }

  const existingSettlement = getSavingsSettlementSnapshot(contract)
  if (existingSettlement.savings_settled_at) {
    throw new Error("GMP savings have already been settled for this contract.")
  }

  const summary = await getProjectGmpControlSummary(projectId, resolvedOrgId)
  if (!summary.enabled) {
    throw new Error(summary.reason ?? "GMP savings settlement is only available on GMP projects.")
  }
  if (summary.savings_cents <= 0) {
    throw new Error("There are no GMP savings to settle.")
  }

  const ownerShareCents = summary.owner_savings_cents
  const builderShareCents = summary.builder_savings_cents
  if (ownerShareCents <= 0 && builderShareCents <= 0) {
    throw new Error("The active contract savings split does not allocate any savings to settle.")
  }

  const ownerCreditInvoice =
    ownerShareCents > 0
      ? await createGmpSettlementInvoice({
          orgId: resolvedOrgId,
          project,
          title: "GMP savings credit",
          description: "Owner GMP savings credit",
          unit: "credit",
          amountCents: -Math.abs(ownerShareCents),
          sourceType: "manual",
        })
      : null

  const builderShareInvoice =
    builderShareCents > 0
      ? await createGmpSettlementInvoice({
          orgId: resolvedOrgId,
          project,
          title: "Builder GMP savings share",
          description: "Builder GMP savings share",
          unit: "fee",
          amountCents: builderShareCents,
          sourceType: "fee",
        })
      : null

  const settledAt = new Date().toISOString()
  const invoiceIds = [ownerCreditInvoice?.id, builderShareInvoice?.id].filter((value): value is string => Boolean(value))
  const before = contract as unknown as Record<string, unknown>
  const nextSnapshot = {
    ...(contract.snapshot ?? {}),
    savings_settled_at: settledAt,
    gmp_savings_settlement: {
      settled_at: settledAt,
      savings_cents: summary.savings_cents,
      owner_savings_cents: ownerShareCents,
      builder_savings_cents: builderShareCents,
      owner_credit_invoice_id: ownerCreditInvoice?.id ?? null,
      builder_share_invoice_id: builderShareInvoice?.id ?? null,
      invoice_ids: invoiceIds,
    },
  }

  const { data: updatedContract, error: contractError } = await supabase
    .from("contracts")
    .update({ snapshot: nextSnapshot })
    .eq("org_id", resolvedOrgId)
    .eq("id", contract.id)
    .select("*")
    .single()

  if (contractError || !updatedContract) {
    throw new Error(`Failed to mark GMP savings settled: ${contractError?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "contract",
    entityId: contract.id,
    before,
    after: updatedContract,
    source: "gmp_savings_settlement",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "gmp_savings_settled",
    entityType: "contract",
    entityId: contract.id,
    payload: {
      project_id: projectId,
      savings_cents: summary.savings_cents,
      owner_savings_cents: ownerShareCents,
      builder_savings_cents: builderShareCents,
      invoice_ids: invoiceIds,
    },
  })

  return {
    summary: await getProjectGmpControlSummary(projectId, resolvedOrgId),
    owner_credit_invoice: ownerCreditInvoice,
    builder_share_invoice: builderShareInvoice,
    savings_settled_at: settledAt,
  }
}
