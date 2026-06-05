import type { SupabaseClient } from "@supabase/supabase-js"

import { resolveProjectBillingModel, type ProjectBillingModel } from "@/lib/financials/billing-model"
import type { Contract, Project } from "@/lib/types"
import { requireAuthorization } from "@/lib/services/authorization"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import { requireOrgContext } from "@/lib/services/context"

export type GmpClassification = "inside_gmp" | "outside_gmp"
export type GmpImpact = "none" | "increase_gmp" | "decrease_gmp" | "outside_gmp"

export type ProjectGmpWarning = {
  code: "missing_gmp" | "missing_budget_eac" | "approaching_gmp" | "gmp_overrun" | "outside_gmp_exposure" | "unposted_co_exposure"
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
  savings_cents: number
  overrun_cents: number
  owner_savings_cents: number
  builder_savings_cents: number
  percent_of_gmp: number | null
  status: "ok" | "watch" | "overrun" | "not_configured"
  warnings: ProjectGmpWarning[]
  generated_at: string
}

type ProjectRow = Pick<Project, "id" | "org_id" | "status" | "financial_settings" | "billing_contract">

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
      status,
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
      status: row.status,
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
      savings_cents: 0,
      overrun_cents: 0,
      owner_savings_cents: 0,
      builder_savings_cents: 0,
      percent_of_gmp: null,
      status: "not_configured",
      warnings: [],
      generated_at: generatedAt,
    }
  }

  const approvedGmpChangeCents = coTotals.approved_gmp_change_cents
  const revisedGmpCents = Math.max(0, baseGmpCents + approvedGmpChangeCents)
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

  const status: ProjectGmpControlSummary["status"] =
    baseGmpCents <= 0 ? "not_configured" : overrunCents > 0 ? "overrun" : warnings.some((warning) => warning.severity === "warning") ? "watch" : "ok"

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
    savings_cents: savingsCents,
    overrun_cents: overrunCents,
    owner_savings_cents: savingsSplit.owner_savings_cents,
    builder_savings_cents: savingsSplit.builder_savings_cents,
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
