import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const budgetLineSchema = z.object({
  cost_code_id: z.string().uuid().optional(),
  description: z.string().min(1),
  amount_cents: z.number().int().min(0),
  metadata: z.record(z.any()).optional(),
})

const createBudgetSchema = z.object({
  project_id: z.string().uuid(),
  lines: z.array(budgetLineSchema),
  status: z.enum(["draft", "approved", "locked"]).default("draft"),
})

export async function createBudget(input: z.infer<typeof createBudgetSchema>, orgId?: string) {
  const parsed = createBudgetSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const totalCents = parsed.lines.reduce((sum, line) => sum + line.amount_cents, 0)

  const { data: budget, error: budgetError } = await supabase
    .from("budgets")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      status: parsed.status,
      total_cents: totalCents,
    })
    .select("*")
    .single()

  if (budgetError || !budget) {
    throw new Error(`Failed to create budget: ${budgetError?.message}`)
  }

  if (parsed.lines.length > 0) {
    const linesToInsert = parsed.lines.map((line, idx) => ({
      org_id: resolvedOrgId,
      budget_id: budget.id,
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      amount_cents: line.amount_cents,
      sort_order: idx,
      metadata: line.metadata ?? {},
    }))

    const { error: linesError } = await supabase.from("budget_lines").insert(linesToInsert)
    if (linesError) {
      throw new Error(`Failed to create budget lines: ${linesError.message}`)
    }
  }

  await recordAudit({
    orgId: resolvedOrgId,
    action: "insert",
    entityType: "budget",
    entityId: budget.id,
    after: { ...budget, lines: parsed.lines },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "budget_created",
    entityType: "budget",
    entityId: budget.id,
    payload: { project_id: parsed.project_id, status: parsed.status, total_cents: totalCents },
  })

  return budget
}

export async function getBudgetWithActuals(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  return getBudgetWithActualsInternal(supabase, projectId, resolvedOrgId)
}

async function getBudgetWithActualsInternal(
  supabase: SupabaseClient,
  projectId: string,
  orgId: string,
) {
  const { data: budget, error: budgetError } = await supabase
    .from("budgets")
    .select(
      `
      *,
      lines:budget_lines(
        id, cost_code_id, description, amount_cents, sort_order,
        cost_code:cost_codes(id, code, name, category)
      )
    `,
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (budgetError) {
    throw new Error(`Failed to get budget: ${budgetError.message}`)
  }
  if (!budget) return null

  const commitmentIds = await selectIds(
    supabase
      .from("commitments")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "approved"),
    "commitments",
  )

  const billIds = await selectIds(
    supabase
      .from("vendor_bills")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["approved", "paid"]),
    "vendor bills",
  )

  const invoiceIds = await selectIds(
    supabase
      .from("invoices")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["sent", "paid"]),
    "invoices",
  )

  const changeOrderIds = await selectIds(
    supabase
      .from("change_orders")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "approved"),
    "change orders",
  )

  const { data: commitments, error: commitmentsError } =
    commitmentIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("commitment_lines")
          .select("cost_code_id, unit_cost_cents, quantity")
          .eq("org_id", orgId)
          .in("commitment_id", commitmentIds)

  if (commitmentsError) {
    throw new Error(`Failed to load commitments: ${commitmentsError.message}`)
  }

  const { data: billLines, error: billLinesError } =
    billIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("bill_lines")
          .select("cost_code_id, unit_cost_cents, quantity")
          .eq("org_id", orgId)
          .in("bill_id", billIds)

  if (billLinesError) {
    throw new Error(`Failed to load bill lines: ${billLinesError.message}`)
  }

  const { data: invoiceLines, error: invoiceLinesError } =
    invoiceIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("invoice_lines")
          .select("cost_code_id, unit_price_cents, quantity")
          .eq("org_id", orgId)
          .in("invoice_id", invoiceIds)

  if (invoiceLinesError) {
    throw new Error(`Failed to load invoice lines: ${invoiceLinesError.message}`)
  }

  const { data: coLines, error: coLinesError } =
    changeOrderIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("change_order_lines")
          .select("cost_code_id, unit_cost_cents, quantity")
          .eq("org_id", orgId)
          .in("change_order_id", changeOrderIds)

  if (coLinesError) {
    throw new Error(`Failed to load change order lines: ${coLinesError.message}`)
  }

  const byCostCode = new Map<
    string,
    {
      budget_cents: number
      committed_cents: number
      actual_cents: number
      invoiced_cents: number
      co_adjustment_cents: number
    }
  >()

  for (const line of budget.lines ?? []) {
    const key = line.cost_code_id ?? "uncoded"
    byCostCode.set(key, {
      budget_cents: line.amount_cents ?? 0,
      committed_cents: 0,
      actual_cents: 0,
      invoiced_cents: 0,
      co_adjustment_cents: 0,
    })
  }

  for (const line of commitments ?? []) {
    const key = line.cost_code_id ?? "uncoded"
    const existing =
      byCostCode.get(key) ?? {
        budget_cents: 0,
        committed_cents: 0,
        actual_cents: 0,
        invoiced_cents: 0,
        co_adjustment_cents: 0,
      }
    existing.committed_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  for (const line of billLines ?? []) {
    const key = line.cost_code_id ?? "uncoded"
    const existing =
      byCostCode.get(key) ?? {
        budget_cents: 0,
        committed_cents: 0,
        actual_cents: 0,
        invoiced_cents: 0,
        co_adjustment_cents: 0,
      }
    existing.actual_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  for (const line of invoiceLines ?? []) {
    const key = line.cost_code_id ?? "uncoded"
    const existing =
      byCostCode.get(key) ?? {
        budget_cents: 0,
        committed_cents: 0,
        actual_cents: 0,
        invoiced_cents: 0,
        co_adjustment_cents: 0,
      }
    existing.invoiced_cents += (line.unit_price_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  for (const line of coLines ?? []) {
    const key = line.cost_code_id ?? "uncoded"
    const existing =
      byCostCode.get(key) ?? {
        budget_cents: 0,
        committed_cents: 0,
        actual_cents: 0,
        invoiced_cents: 0,
        co_adjustment_cents: 0,
      }
    existing.co_adjustment_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  let totalBudget = 0
  let totalCommitted = 0
  let totalActual = 0
  let totalInvoiced = 0
  let totalCOAdjustment = 0

  const breakdown = Array.from(byCostCode.entries()).map(([costCodeId, values]) => {
    totalBudget += values.budget_cents
    totalCommitted += values.committed_cents
    totalActual += values.actual_cents
    totalInvoiced += values.invoiced_cents
    totalCOAdjustment += values.co_adjustment_cents

    const adjustedBudget = values.budget_cents + values.co_adjustment_cents
    const variance = adjustedBudget - values.actual_cents
    const variancePercent = adjustedBudget > 0 ? Math.round((values.actual_cents / adjustedBudget) * 100) : 0

    return {
      cost_code_id: costCodeId === "uncoded" ? null : costCodeId,
      budget_cents: values.budget_cents,
      co_adjustment_cents: values.co_adjustment_cents,
      adjusted_budget_cents: adjustedBudget,
      committed_cents: values.committed_cents,
      actual_cents: values.actual_cents,
      invoiced_cents: values.invoiced_cents,
      variance_cents: variance,
      variance_percent: variancePercent,
      status: variancePercent > 100 ? "over" : variancePercent > 90 ? "warning" : "ok",
    }
  })

  const adjustedTotalBudget = totalBudget + totalCOAdjustment
  const grossMarginCents = totalInvoiced - totalActual
  const grossMarginPercent = totalInvoiced > 0 ? Math.round((grossMarginCents / totalInvoiced) * 100) : 0

  return {
    budget,
    summary: {
      total_budget_cents: totalBudget,
      total_co_adjustment_cents: totalCOAdjustment,
      adjusted_budget_cents: adjustedTotalBudget,
      total_committed_cents: totalCommitted,
      total_actual_cents: totalActual,
      total_invoiced_cents: totalInvoiced,
      total_variance_cents: adjustedTotalBudget - totalActual,
      variance_percent: adjustedTotalBudget > 0 ? Math.round((totalActual / adjustedTotalBudget) * 100) : 0,
      gross_margin_cents: grossMarginCents,
      gross_margin_percent: grossMarginPercent,
      status: grossMarginPercent < 10 ? "critical" : grossMarginPercent < 20 ? "warning" : "healthy",
    },
    breakdown,
  }
}

export async function takeBudgetSnapshot(projectId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const data = await getBudgetWithActualsInternal(supabase, projectId, orgId)
  if (!data?.budget) return null

  const today = new Date().toISOString().split("T")[0]

  const { data: snapshot, error } = await supabase
    .from("budget_snapshots")
    .upsert(
      {
        org_id: orgId,
        project_id: projectId,
        budget_id: data.budget.id,
        snapshot_date: today,
        total_budget_cents: data.summary.adjusted_budget_cents,
        total_committed_cents: data.summary.total_committed_cents,
        total_actual_cents: data.summary.total_actual_cents,
        total_invoiced_cents: data.summary.total_invoiced_cents,
        variance_cents: data.summary.total_variance_cents,
        margin_percent: data.summary.gross_margin_percent,
        by_cost_code: data.breakdown,
      },
      { onConflict: "budget_id,snapshot_date" },
    )
    .select("*")
    .single()

  if (error) {
    throw new Error(`Failed to record budget snapshot: ${error.message}`)
  }

  return snapshot
}

export async function checkVarianceAlerts(projectId: string, orgId: string, thresholds = [25, 50, 100]) {
  const supabase = createServiceSupabaseClient()
  const data = await getBudgetWithActualsInternal(supabase, projectId, orgId)
  if (!data?.budget) return []

  const alerts: any[] = []

  for (const line of data.breakdown) {
    if (line.variance_percent >= thresholds[0]) {
      const { data: existing, error } = await supabase
        .from("variance_alerts")
        .select("id")
        .eq("project_id", projectId)
        .eq("cost_code_id", line.cost_code_id)
        .eq("status", "active")
        .maybeSingle()

      if (error) {
        throw new Error(`Failed to check existing variance alerts: ${error.message}`)
      }

      if (!existing) {
        const { data: alert, error: createError } = await supabase
          .from("variance_alerts")
          .insert({
            org_id: orgId,
            project_id: projectId,
            budget_id: data.budget.id,
            cost_code_id: line.cost_code_id,
            alert_type: line.variance_percent >= 100 ? "over_budget" : "threshold_exceeded",
            threshold_percent: thresholds.find((t) => line.variance_percent >= t),
            current_percent: line.variance_percent,
            budget_cents: line.adjusted_budget_cents,
            actual_cents: line.actual_cents,
            variance_cents: line.variance_cents,
          })
          .select("*")
          .single()

        if (createError) {
          throw new Error(`Failed to create variance alert: ${createError.message}`)
        }

        if (alert) alerts.push(alert)
      }
    }
  }

  if (data.summary.gross_margin_percent < 15) {
    const { data: existing, error } = await supabase
      .from("variance_alerts")
      .select("id")
      .eq("project_id", projectId)
      .eq("alert_type", "margin_warning")
      .eq("status", "active")
      .maybeSingle()

    if (error) {
      throw new Error(`Failed to check margin warning alerts: ${error.message}`)
    }

    if (!existing) {
      const { data: alert, error: createError } = await supabase
        .from("variance_alerts")
        .insert({
          org_id: orgId,
          project_id: projectId,
          budget_id: data.budget.id,
          alert_type: "margin_warning",
          current_percent: data.summary.gross_margin_percent,
          metadata: { message: `Gross margin is ${data.summary.gross_margin_percent}%` },
        })
        .select("*")
        .single()

      if (createError) {
        throw new Error(`Failed to create margin warning alert: ${createError.message}`)
      }

      if (alert) alerts.push(alert)
    }
  }

  return alerts
}

export async function acknowledgeVarianceAlert(alertId: string, status: "acknowledged" | "resolved" = "acknowledged", orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("variance_alerts")
    .update({ status, acknowledged_by: userId, acknowledged_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId)
    .eq("id", alertId)
    .select("id, status, acknowledged_at, acknowledged_by")
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to acknowledge variance alert: ${error.message}`)
  }

  return data
}

async function selectIds(
  query: ReturnType<SupabaseClient["from"]>,
  label: string,
): Promise<string[]> {
  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load ${label}: ${error.message}`)
  }

  return Array.from(new Set((data ?? []).map((row: any) => row.id)))
}

