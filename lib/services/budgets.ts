import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getProjectJobCostActualsByCostCode } from "@/lib/services/job-cost-actuals"
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

  const { data: latestBudget, error: latestError } = await supabase
    .from("budgets")
    .select("version")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", parsed.project_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestError) {
    throw new Error(`Failed to determine next budget version: ${latestError.message}`)
  }

  const nextVersion = (latestBudget?.version ?? 0) + 1
  const totalCents = parsed.lines.reduce((sum, line) => sum + line.amount_cents, 0)

  const { data: budget, error: budgetError } = await supabase
    .from("budgets")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      version: nextVersion,
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

export async function duplicateBudgetVersion({
  projectId,
  fromBudgetId,
  orgId,
}: {
  projectId: string
  fromBudgetId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: latestBudget, error: latestError } = await supabase
    .from("budgets")
    .select("version")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestError) {
    throw new Error(`Failed to determine next budget version: ${latestError.message}`)
  }

  const nextVersion = (latestBudget?.version ?? 0) + 1

  const { data: fromBudget, error: fromBudgetError } = await supabase
    .from("budgets")
    .select("id, org_id, project_id, status, total_cents, currency, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", fromBudgetId)
    .maybeSingle()

  if (fromBudgetError || !fromBudget) {
    throw new Error("Source budget not found")
  }

  const { data: fromLines, error: linesError } = await supabase
    .from("budget_lines")
    .select("cost_code_id, description, amount_cents, sort_order, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("budget_id", fromBudgetId)
    .order("sort_order", { ascending: true })

  if (linesError) {
    throw new Error(`Failed to load budget lines: ${linesError.message}`)
  }

  const { data: newBudget, error: newBudgetError } = await supabase
    .from("budgets")
    .insert({
      org_id: resolvedOrgId,
      project_id: projectId,
      version: nextVersion,
      status: "draft",
      total_cents: fromBudget.total_cents ?? 0,
      currency: fromBudget.currency ?? "usd",
      metadata: fromBudget.metadata ?? {},
    })
    .select("*")
    .single()

  if (newBudgetError || !newBudget) {
    throw new Error(`Failed to create budget version: ${newBudgetError?.message}`)
  }

  if (fromLines?.length) {
    const insertLines = fromLines.map((line: any, idx: number) => ({
      org_id: resolvedOrgId,
      budget_id: newBudget.id,
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      amount_cents: line.amount_cents ?? 0,
      sort_order: idx,
      metadata: line.metadata ?? {},
    }))

    const { error: insertLinesError } = await supabase.from("budget_lines").insert(insertLines)
    if (insertLinesError) {
      throw new Error(`Failed to copy budget lines: ${insertLinesError.message}`)
    }
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "budget",
    entityId: newBudget.id,
    after: { ...newBudget, source_budget_id: fromBudgetId },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "budget_created",
    entityType: "budget",
    entityId: newBudget.id,
    payload: { project_id: projectId, status: "draft", version: nextVersion },
  })

  return newBudget
}

export async function updateBudgetStatus({
  budgetId,
  status,
  orgId,
}: {
  budgetId: string
  status: "draft" | "approved" | "locked"
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: existingError } = await supabase
    .from("budgets")
    .select("id, org_id, project_id, status, total_cents, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", budgetId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Budget not found")
  }

  const nextMetadata = {
    ...(existing.metadata ?? {}),
    approved_at: status === "approved" ? (existing.metadata?.approved_at ?? new Date().toISOString()) : existing.metadata?.approved_at,
    approved_by: status === "approved" ? (existing.metadata?.approved_by ?? userId) : existing.metadata?.approved_by,
    locked_at: status === "locked" ? (existing.metadata?.locked_at ?? new Date().toISOString()) : existing.metadata?.locked_at,
    locked_by: status === "locked" ? (existing.metadata?.locked_by ?? userId) : existing.metadata?.locked_by,
  }

  const { data, error } = await supabase
    .from("budgets")
    .update({ status, metadata: nextMetadata })
    .eq("org_id", resolvedOrgId)
    .eq("id", budgetId)
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update budget status: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "budget",
    entityId: budgetId,
    before: existing,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "budget_updated",
    entityType: "budget",
    entityId: budgetId,
    payload: { project_id: existing.project_id, status },
  })

  return data
}

export async function replaceBudgetLines({
  budgetId,
  lines,
  orgId,
}: {
  budgetId: string
  lines: Array<{ cost_code_id?: string | null; description: string; amount_cents: number; metadata?: Record<string, any> }>
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: budget, error: budgetError } = await supabase
    .from("budgets")
    .select("id, org_id, project_id, status, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", budgetId)
    .maybeSingle()

  if (budgetError || !budget) {
    throw new Error("Budget not found")
  }

  if (budget.status === "locked") {
    throw new Error("Budget is locked and cannot be edited")
  }

  const totalCents = lines.reduce((sum, line) => sum + (line.amount_cents ?? 0), 0)

  const { error: deleteError } = await supabase
    .from("budget_lines")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("budget_id", budgetId)

  if (deleteError) {
    throw new Error(`Failed to replace budget lines: ${deleteError.message}`)
  }

  if (lines.length > 0) {
    const toInsert = lines.map((line, idx) => ({
      org_id: resolvedOrgId,
      budget_id: budgetId,
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      amount_cents: line.amount_cents,
      sort_order: idx,
      metadata: line.metadata ?? {},
    }))

    const { error: insertError } = await supabase.from("budget_lines").insert(toInsert)
    if (insertError) {
      throw new Error(`Failed to replace budget lines: ${insertError.message}`)
    }
  }

  const { data: updatedBudget, error: updateError } = await supabase
    .from("budgets")
    .update({ total_cents: totalCents })
    .eq("org_id", resolvedOrgId)
    .eq("id", budgetId)
    .select("*")
    .single()

  if (updateError || !updatedBudget) {
    throw new Error(`Failed to update budget totals: ${updateError?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "budget",
    entityId: budgetId,
    after: { ...updatedBudget, lines_count: lines.length },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "budget_updated",
    entityType: "budget",
    entityId: budgetId,
    payload: { project_id: budget.project_id, total_cents: totalCents },
  })

  return updatedBudget
}

export async function listVarianceAlertsForProject(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("variance_alerts")
    .select("id, project_id, cost_code_id, alert_type, threshold_percent, current_percent, budget_cents, actual_cents, variance_cents, status, acknowledged_by, acknowledged_at, metadata, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("status", { ascending: true })
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list variance alerts: ${error.message}`)
  }

  return data ?? []
}

export async function getBudgetWithActuals(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  return getBudgetWithActualsInternal(supabase, projectId, resolvedOrgId)
}

/**
 * Latest budget's lines for a project, used as the cost-bucket picker when a
 * project has cost codes disabled (the budget line is the bucket).
 */
export async function listProjectBudgetLines(
  projectId: string,
  orgId?: string,
): Promise<Array<{ id: string; description: string | null; amount_cents: number | null }>> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data: budget } = await supabase
    .from("budgets")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!budget) return []
  const { data: lines } = await supabase
    .from("budget_lines")
    .select("id, description, amount_cents, sort_order")
    .eq("org_id", resolvedOrgId)
    .eq("budget_id", budget.id)
    .order("sort_order", { ascending: true })
  return (lines ?? []).map((line) => ({
    id: line.id as string,
    description: (line.description as string | null) ?? null,
    amount_cents: (line.amount_cents as number | null) ?? null,
  }))
}

async function getBudgetWithActualsInternal(
  supabase: SupabaseClient,
  projectId: string,
  orgId: string,
) {
  // When a project disables cost codes, budget lines themselves are the cost
  // bucket: actuals/commitments group by budget_line_id instead of cost_code_id.
  const { data: settingsRow } = await supabase
    .from("project_financial_settings")
    .select("cost_codes_enabled")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()
  const costCodesEnabled = settingsRow?.cost_codes_enabled ?? true
  const groupBy = costCodesEnabled ? "cost_code" : "budget_line"

  // Bucket key for a row: the cost code (codes on) or the budget line (codes off).
  // Rows without the relevant id fall into a shared "uncoded" bucket.
  const bucketKey = (row: { cost_code_id?: string | null; budget_line_id?: string | null }) =>
    (costCodesEnabled ? row.cost_code_id : row.budget_line_id) ?? "uncoded"

  const { data: budget, error: budgetError } = await supabase
    .from("budgets")
    .select(
      `
      *,
      lines:budget_lines(
        id, cost_code_id, description, amount_cents, sort_order, metadata,
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

  const invoiceIds = await selectIds(
    supabase
      .from("invoices")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["sent", "partial", "paid", "overdue"]),
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
          .select("cost_code_id, budget_line_id, unit_cost_cents, quantity")
          .eq("org_id", orgId)
          .in("commitment_id", commitmentIds)

  if (commitmentsError) {
    throw new Error(`Failed to load commitments: ${commitmentsError.message}`)
  }

  const jobCostActuals = await getProjectJobCostActualsByCostCode({ projectId, orgId, supabase, groupBy })

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
          .select("cost_code_id, budget_line_id, unit_cost_cents, quantity, metadata")
          .eq("org_id", orgId)
          .in("change_order_id", changeOrderIds)

  if (coLinesError) {
    throw new Error(`Failed to load change order lines: ${coLinesError.message}`)
  }

  const { data: revisionLines, error: revisionLinesError } = await supabase
    .from("budget_revision_lines")
    .select("cost_code_id, budget_line_id, amount_cents, allowance_draw_cents, revision:budget_revisions!inner(project_id, status)")
    .eq("org_id", orgId)
    .eq("revision.project_id", projectId)
    .eq("revision.status", "posted")

  if (revisionLinesError) {
    throw new Error(`Failed to load budget revisions: ${revisionLinesError.message}`)
  }

  const { data: progressList } = await supabase
    .from("project_cost_code_progress")
    .select("cost_code_id, percent_complete, estimate_remaining_cents")
    .eq("org_id", orgId)
    .eq("project_id", projectId)

  const byCostCode = new Map<
    string,
    {
      budget_cents: number
      committed_cents: number
      actual_cents: number
      invoiced_cents: number
      co_adjustment_cents: number
      percent_complete: number | null
      estimate_remaining_cents: number | null
    }
  >()

  for (const line of budget.lines ?? []) {
    // In code-off mode each budget line is its own bucket (keyed by its row id).
    const key = costCodesEnabled ? line.cost_code_id ?? "uncoded" : line.id
    const existing =
      byCostCode.get(key) ?? {
        budget_cents: 0,
        committed_cents: 0,
        actual_cents: 0,
        invoiced_cents: 0,
        co_adjustment_cents: 0,
        percent_complete: null,
        estimate_remaining_cents: null,
      }
    existing.budget_cents += line.amount_cents ?? 0
    byCostCode.set(key, existing)
  }

  for (const line of commitments ?? []) {
    const key = bucketKey(line)
    const existing =
      byCostCode.get(key) ?? {
        budget_cents: 0,
        committed_cents: 0,
        actual_cents: 0,
        invoiced_cents: 0,
        co_adjustment_cents: 0,
        percent_complete: null,
        estimate_remaining_cents: null,
      }
    existing.committed_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  for (const actual of jobCostActuals) {
    const key = bucketKey(actual)
    const existing =
      byCostCode.get(key) ?? {
        budget_cents: 0,
        committed_cents: 0,
        actual_cents: 0,
        invoiced_cents: 0,
        co_adjustment_cents: 0,
        percent_complete: null,
        estimate_remaining_cents: null,
      }
    existing.actual_cents += actual.actual_cents
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
        percent_complete: null,
        estimate_remaining_cents: null,
      }
    existing.invoiced_cents += (line.unit_price_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  const postedRevisionLines = revisionLines ?? []
  const coAdjustmentSource = postedRevisionLines.length > 0 ? postedRevisionLines : coLines ?? []

  for (const line of coAdjustmentSource) {
    const key = bucketKey(line)
    const existing =
      byCostCode.get(key) ?? {
        budget_cents: 0,
        committed_cents: 0,
        actual_cents: 0,
        invoiced_cents: 0,
        co_adjustment_cents: 0,
        percent_complete: null,
        estimate_remaining_cents: null,
      }
    const sourceLine = line as any
    const metadata = (sourceLine.metadata ?? {}) as Record<string, any>
    if ("amount_cents" in sourceLine) {
      existing.co_adjustment_cents += sourceLine.amount_cents ?? 0
    } else {
      const allowanceCents = metadata.allowance_draw_cents ?? metadata.allowance_cents ?? 0
      const postedRevisionCents = metadata.budget_revision_cents
      existing.co_adjustment_cents +=
        typeof postedRevisionCents === "number"
          ? postedRevisionCents
          : (sourceLine.unit_cost_cents ?? 0) * (sourceLine.quantity ?? 1) + allowanceCents
    }
    byCostCode.set(key, existing)
  }

  for (const prog of progressList ?? []) {
    const key = prog.cost_code_id ?? "uncoded"
    const existing =
      byCostCode.get(key) ?? {
        budget_cents: 0,
        committed_cents: 0,
        actual_cents: 0,
        invoiced_cents: 0,
        co_adjustment_cents: 0,
        percent_complete: null,
        estimate_remaining_cents: null,
      }
    existing.percent_complete = prog.percent_complete
    existing.estimate_remaining_cents = prog.estimate_remaining_cents
    byCostCode.set(key, existing)
  }

  let totalBudget = 0
  let totalCommitted = 0
  let totalActual = 0
  let totalInvoiced = 0
  let totalCOAdjustment = 0
  let totalEac = 0
  let totalCtc = 0
  let totalVac = 0

  const breakdown = Array.from(byCostCode.entries()).map(([bucketId, values]) => {
    const resolvedId = bucketId === "uncoded" ? null : bucketId
    const costCodeId = costCodesEnabled ? resolvedId : null
    const budgetLineId = costCodesEnabled ? null : resolvedId
    totalBudget += values.budget_cents
    totalCommitted += values.committed_cents
    totalActual += values.actual_cents
    totalInvoiced += values.invoiced_cents
    totalCOAdjustment += values.co_adjustment_cents

    const adjustedBudget = values.budget_cents + values.co_adjustment_cents
    const variance = adjustedBudget - values.actual_cents
    const variancePercent = adjustedBudget > 0 ? Math.round((values.actual_cents / adjustedBudget) * 100) : 0

    const eac_cents = values.estimate_remaining_cents != null
      ? values.actual_cents + values.estimate_remaining_cents
      : Math.max(adjustedBudget, values.actual_cents, values.committed_cents)
    const cost_to_complete_cents = Math.max(0, eac_cents - values.actual_cents)
    const variance_at_completion_cents = adjustedBudget - eac_cents

    totalEac += eac_cents
    totalCtc += cost_to_complete_cents
    totalVac += variance_at_completion_cents

    return {
      cost_code_id: costCodeId,
      budget_line_id: budgetLineId,
      budget_cents: values.budget_cents,
      co_adjustment_cents: values.co_adjustment_cents,
      adjusted_budget_cents: adjustedBudget,
      committed_cents: values.committed_cents,
      actual_cents: values.actual_cents,
      invoiced_cents: values.invoiced_cents,
      variance_cents: variance,
      variance_percent: variancePercent,
      percent_complete: values.percent_complete,
      eac_cents,
      cost_to_complete_cents,
      variance_at_completion_cents,
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
      total_eac_cents: totalEac,
      total_ctc_cents: totalCtc,
      total_vac_cents: totalVac,
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
    // variance_alerts is keyed on cost_code_id; for cost-code-disabled projects
    // (budget-line buckets) we can't dedupe per line yet, so skip per-line alerts
    // here — the inline over-budget status still renders. Margin warning below
    // still fires project-wide.
    if (!line.cost_code_id && (line as any).budget_line_id) continue
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
  query: any,
  label: string,
): Promise<string[]> {
  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load ${label}: ${error.message}`)
  }

  return Array.from(new Set((data ?? []).map((row: any) => row.id)))
}

export async function updateCostCodeProgress({
  orgId,
  projectId,
  costCodeId,
  percentComplete,
  estimateRemainingCents,
  notes,
}: {
  orgId: string
  projectId: string
  costCodeId: string
  percentComplete: number | null
  estimateRemainingCents: number | null
  notes: string | null
}) {
  const supabase = createServiceSupabaseClient()

  // For server action calls we need the user session to know who recorded this.
  // Assuming this is only called from authorized server actions:
  const { data: userResponse } = await supabase.auth.getUser()

  const { error } = await supabase
    .from("project_cost_code_progress")
    .upsert({
      org_id: orgId,
      project_id: projectId,
      cost_code_id: costCodeId,
      percent_complete: percentComplete,
      estimate_remaining_cents: estimateRemainingCents,
      notes: notes,
      recorded_by_user_id: userResponse.user?.id ?? "00000000-0000-0000-0000-000000000000",
    }, {
      onConflict: "org_id, project_id, cost_code_id"
    })

  if (error) {
    throw new Error(`Failed to update cost code progress: ${error.message}`)
  }
}
