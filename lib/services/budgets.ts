import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getProjectJobCostActualsByCostCode } from "@/lib/services/job-cost-actuals"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const budgetLineSchema = z.object({
  id: z.string().uuid().nullable().optional(),
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

async function requireBudgetAuth({
  permission,
  userId,
  orgId,
  projectId,
  supabase,
  resourceType = "project",
  resourceId = projectId,
}: {
  permission: "budget.read" | "budget.write"
  userId: string
  orgId: string
  projectId: string
  supabase: SupabaseClient
  resourceType?: string
  resourceId?: string
}) {
  await requireAuthorization({
    permission,
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType,
    resourceId,
  })
}

export async function createBudget(input: z.infer<typeof createBudgetSchema>, orgId?: string) {
  const parsed = createBudgetSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireBudgetAuth({
    permission: "budget.write",
    userId,
    orgId: resolvedOrgId,
    projectId: parsed.project_id,
    supabase,
  })

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
      id: line.id ?? undefined,
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
  await requireBudgetAuth({
    permission: "budget.write",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
  })

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

  await requireBudgetAuth({
    permission: "budget.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    resourceType: "budget",
    resourceId: budgetId,
  })

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
  lines: Array<{ id?: string | null; cost_code_id?: string | null; description: string; amount_cents: number; metadata?: Record<string, any> }>
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

  await requireBudgetAuth({
    permission: "budget.write",
    userId,
    orgId: resolvedOrgId,
    projectId: budget.project_id,
    supabase,
    resourceType: "budget",
    resourceId: budgetId,
  })

  if (budget.status === "locked") {
    throw new Error("Budget is locked and cannot be edited")
  }

  const totalCents = lines.reduce((sum, line) => sum + (line.amount_cents ?? 0), 0)

  const { data: existingLines, error: existingLinesError } = await supabase
    .from("budget_lines")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("budget_id", budgetId)

  if (existingLinesError) {
    throw new Error(`Failed to load budget lines: ${existingLinesError.message}`)
  }

  const existingIds = new Set((existingLines ?? []).map((line) => line.id as string))
  const incomingIds = new Set(lines.map((line) => line.id).filter((id): id is string => Boolean(id)))
  if (incomingIds.size > 0) {
    const { data: matchingIncoming, error: matchingIncomingError } = await supabase
      .from("budget_lines")
      .select("id, budget_id, org_id")
      .in("id", Array.from(incomingIds))

    if (matchingIncomingError) {
      throw new Error(`Failed to validate budget lines: ${matchingIncomingError.message}`)
    }

    const foreignLine = (matchingIncoming ?? []).find(
      (line) => line.org_id !== resolvedOrgId || line.budget_id !== budgetId,
    )
    if (foreignLine) {
      throw new Error("Budget line does not belong to this budget")
    }
  }

  const removedIds = Array.from(existingIds).filter((id) => !incomingIds.has(id))
  if (removedIds.length > 0) {
    const { error: deleteError } = await supabase
      .from("budget_lines")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq("budget_id", budgetId)
      .in("id", removedIds)

    if (deleteError) {
      throw new Error(`Failed to remove deleted budget lines: ${deleteError.message}`)
    }
  }

  if (lines.length > 0) {
    const rows = lines.map((line, idx) => ({
      id: line.id ?? undefined,
      org_id: resolvedOrgId,
      budget_id: budgetId,
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      amount_cents: line.amount_cents,
      sort_order: idx,
      metadata: line.metadata ?? {},
    }))

    const rowsWithIds = rows.filter((row) => row.id)
    const rowsWithoutIds = rows.filter((row) => !row.id)
    if (rowsWithIds.length > 0) {
      const { error: upsertError } = await supabase.from("budget_lines").upsert(rowsWithIds, { onConflict: "id" })
      if (upsertError) {
        throw new Error(`Failed to save budget lines: ${upsertError.message}`)
      }
    }
    if (rowsWithoutIds.length > 0) {
      const { error: insertError } = await supabase.from("budget_lines").insert(rowsWithoutIds)
      if (insertError) {
        throw new Error(`Failed to save budget lines: ${insertError.message}`)
      }
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

/**
 * Freezes the latest budget's current line amounts as its baseline ("Original").
 * Re-running overwrites the baseline (re-baseline). This does not lock editing —
 * the budget stays a living document; only the Original comparison point freezes.
 */
export async function lockBudgetBaseline(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: budget, error: budgetError } = await supabase
    .from("budgets")
    .select("id, project_id, lines:budget_lines(id, cost_code_id, description, amount_cents)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (budgetError) throw new Error(`Failed to load budget: ${budgetError.message}`)
  if (!budget) throw new Error("Create a budget before locking a baseline")

  await requireBudgetAuth({
    permission: "budget.write",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    resourceType: "budget",
    resourceId: budget.id as string,
  })

  const baselineLines = (budget.lines ?? []).map((line: any) => ({
    id: line.id ?? null,
    cost_code_id: line.cost_code_id ?? null,
    description: line.description ?? "",
    amount_cents: line.amount_cents ?? 0,
  }))

  const { error: updateError } = await supabase
    .from("budgets")
    .update({
      baseline_lines: baselineLines,
      baseline_locked_at: new Date().toISOString(),
      baseline_locked_by: userId,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", budget.id)

  if (updateError) throw new Error(`Failed to lock baseline: ${updateError.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "budget_baseline_locked",
    entityType: "budget",
    entityId: budget.id as string,
    payload: { project_id: projectId, line_count: baselineLines.length },
  })

  return { success: true, line_count: baselineLines.length }
}

export async function listVarianceAlertsForProject(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireBudgetAuth({
    permission: "budget.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
  })

  const { data, error } = await supabase
    .from("variance_alerts")
    .select("id, project_id, cost_code_id, budget_line_id, alert_type, threshold_percent, current_percent, budget_cents, actual_cents, variance_cents, status, acknowledged_by, acknowledged_at, metadata, created_at")
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireBudgetAuth({
    permission: "budget.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
  })
  return getBudgetWithActualsInternal(supabase, projectId, resolvedOrgId)
}

export type BudgetBucketChangeOrder = {
  id: string
  title: string
  status: string
  approved_at: string | null
  created_at: string | null
  amount_cents: number
}

/**
 * Approved change orders that adjusted a single budget bucket, summed per CO.
 * `bucketKey` is a cost_code_id (codes on) or budget_line_id (codes off);
 * `groupBy` selects which column on change_order_lines to match.
 */
export async function listBudgetBucketChangeOrders(
  projectId: string,
  bucketKey: string | null,
  groupBy: "cost_code" | "budget_line",
  orgId?: string,
): Promise<BudgetBucketChangeOrder[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireBudgetAuth({
    permission: "budget.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
  })
  if (!bucketKey) return []

  const { data: cos, error: coError } = await supabase
    .from("change_orders")
    .select("id, title, status, approved_at, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("status", "approved")

  if (coError) throw new Error(`Failed to load change orders: ${coError.message}`)
  const coById = new Map((cos ?? []).map((co) => [co.id as string, co]))
  if (coById.size === 0) return []

  const matchColumn = groupBy === "cost_code" ? "cost_code_id" : "budget_line_id"
  const { data: lines, error: linesError } = await supabase
    .from("change_order_lines")
    .select("change_order_id, unit_cost_cents, quantity, metadata")
    .eq("org_id", resolvedOrgId)
    .eq(matchColumn, bucketKey)
    .in("change_order_id", Array.from(coById.keys()))

  if (linesError) throw new Error(`Failed to load change order lines: ${linesError.message}`)

  const amountByCo = new Map<string, number>()
  for (const line of lines ?? []) {
    const coId = line.change_order_id as string
    const metadata = (line.metadata ?? {}) as Record<string, any>
    const allowanceCents = metadata.allowance_draw_cents ?? metadata.allowance_cents ?? 0
    const amount =
      typeof metadata.budget_revision_cents === "number"
        ? metadata.budget_revision_cents
        : (line.unit_cost_cents ?? 0) * (line.quantity ?? 1) + allowanceCents
    amountByCo.set(coId, (amountByCo.get(coId) ?? 0) + amount)
  }

  return Array.from(amountByCo.entries())
    .map(([coId, amount]) => {
      const co = coById.get(coId)!
      return {
        id: coId,
        title: (co.title as string) ?? "Change order",
        status: (co.status as string) ?? "approved",
        approved_at: (co.approved_at as string) ?? null,
        created_at: (co.created_at as string) ?? null,
        amount_cents: amount,
      }
    })
    .sort((a, b) => (b.approved_at ?? "").localeCompare(a.approved_at ?? ""))
}

/**
 * Latest budget's lines for a project, used as the cost-bucket picker when a
 * project has cost codes disabled (the budget line is the bucket).
 */
export async function listProjectBudgetLines(
  projectId: string,
  orgId?: string,
): Promise<Array<{ id: string; description: string | null; amount_cents: number | null }>> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireBudgetAuth({
    permission: "budget.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
  })
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

function emptyBudgetBucket() {
  return {
    budget_cents: 0,
    committed_cents: 0,
    committed_billed_cents: 0,
    pending_cost_cents: 0,
    actual_cents: 0,
    invoiced_cents: 0,
    co_adjustment_cents: 0,
    percent_complete: null as number | null,
    estimate_remaining_cents: null as number | null,
  }
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

  const pendingBillIds = await selectIds(
    supabase
      .from("vendor_bills")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "pending"),
    "pending vendor bills",
  )

  const approvedCommitmentBillIds = await selectIds(
    supabase
      .from("vendor_bills")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["approved", "partial", "paid"])
      .not("commitment_id", "is", null),
    "approved commitment bills",
  )

  const approvedCommitmentChangeOrderIds = await selectIds(
    supabase
      .from("commitment_change_orders")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "approved"),
    "approved commitment change orders",
  )

  const pendingCommitmentChangeOrderIds = await selectIds(
    supabase
      .from("commitment_change_orders")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "sent"),
    "pending commitment change orders",
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
          .select("cost_code_id, budget_line_id, unit_price_cents, quantity")
          .eq("org_id", orgId)
          .in("invoice_id", invoiceIds)

  if (invoiceLinesError) {
    throw new Error(`Failed to load invoice lines: ${invoiceLinesError.message}`)
  }

  const { data: pendingBillLines, error: pendingBillLinesError } =
    pendingBillIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("bill_lines")
          .select("cost_code_id, budget_line_id, unit_cost_cents, quantity")
          .eq("org_id", orgId)
          .in("bill_id", pendingBillIds)

  if (pendingBillLinesError) {
    throw new Error(`Failed to load pending bill exposure: ${pendingBillLinesError.message}`)
  }

  const { data: approvedCommitmentBillLines, error: approvedCommitmentBillLinesError } =
    approvedCommitmentBillIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("bill_lines")
          .select("cost_code_id, budget_line_id, unit_cost_cents, quantity")
          .eq("org_id", orgId)
          .in("bill_id", approvedCommitmentBillIds)

  if (approvedCommitmentBillLinesError) {
    throw new Error(`Failed to load commitment bill burn-down: ${approvedCommitmentBillLinesError.message}`)
  }

  const { data: approvedCommitmentCoLines, error: approvedCommitmentCoLinesError } =
    approvedCommitmentChangeOrderIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("commitment_change_order_lines")
          .select("cost_code_id, budget_line_id, amount_cents, unit_cost_cents, quantity")
          .eq("org_id", orgId)
          .in("commitment_change_order_id", approvedCommitmentChangeOrderIds)

  if (approvedCommitmentCoLinesError) {
    throw new Error(`Failed to load commitment change orders: ${approvedCommitmentCoLinesError.message}`)
  }

  const { data: pendingCommitmentCoLines, error: pendingCommitmentCoLinesError } =
    pendingCommitmentChangeOrderIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("commitment_change_order_lines")
          .select("cost_code_id, budget_line_id, amount_cents, unit_cost_cents, quantity")
          .eq("org_id", orgId)
          .in("commitment_change_order_id", pendingCommitmentChangeOrderIds)

  if (pendingCommitmentCoLinesError) {
    throw new Error(`Failed to load pending commitment exposure: ${pendingCommitmentCoLinesError.message}`)
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
    ReturnType<typeof emptyBudgetBucket>
  >()

  for (const line of budget.lines ?? []) {
    // In code-off mode each budget line is its own bucket (keyed by its row id).
    const key = costCodesEnabled ? line.cost_code_id ?? "uncoded" : line.id
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
    existing.budget_cents += line.amount_cents ?? 0
    byCostCode.set(key, existing)
  }

  for (const line of commitments ?? []) {
    const key = bucketKey(line)
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
    existing.committed_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  for (const line of approvedCommitmentCoLines ?? []) {
    const key = bucketKey(line)
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
    existing.committed_cents += line.amount_cents ?? (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  for (const actual of jobCostActuals) {
    const key = bucketKey(actual)
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
    existing.actual_cents += actual.actual_cents
    byCostCode.set(key, existing)
  }

  for (const line of invoiceLines ?? []) {
    const key = bucketKey(line)
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
    existing.invoiced_cents += (line.unit_price_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  for (const line of pendingBillLines ?? []) {
    const key = bucketKey(line)
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
    existing.pending_cost_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  for (const line of approvedCommitmentBillLines ?? []) {
    const key = bucketKey(line)
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
    existing.committed_billed_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  for (const line of pendingCommitmentCoLines ?? []) {
    const key = bucketKey(line)
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
    existing.pending_cost_cents += line.amount_cents ?? (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  const postedRevisionLines = revisionLines ?? []
  const coAdjustmentSource = postedRevisionLines.length > 0 ? postedRevisionLines : coLines ?? []

  for (const line of coAdjustmentSource) {
    const key = bucketKey(line)
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
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
    const existing = byCostCode.get(key) ?? emptyBudgetBucket()
    existing.percent_complete = prog.percent_complete
    existing.estimate_remaining_cents = prog.estimate_remaining_cents
    byCostCode.set(key, existing)
  }

  // Baseline (frozen "Original" budget) is stored on the budget row. Match by
  // cost_code_id when codes are on; by budget_line id when codes are off, with
  // description as a legacy fallback for baselines captured before line ids were stored.
  const baselineLines = (Array.isArray((budget as any).baseline_lines)
    ? (budget as any).baseline_lines
    : []) as Array<{ id?: string | null; cost_code_id?: string | null; description?: string | null; amount_cents?: number | null }>
  const hasBaseline = baselineLines.length > 0
  const baselineByCostCode = new Map<string, number>()
  const baselineByLineId = new Map<string, number>()
  const baselineByDescription = new Map<string, number>()
  for (const bl of baselineLines) {
    const amount = bl.amount_cents ?? 0
    if (bl.id) {
      baselineByLineId.set(bl.id, (baselineByLineId.get(bl.id) ?? 0) + amount)
    }
    if (bl.cost_code_id) {
      baselineByCostCode.set(bl.cost_code_id, (baselineByCostCode.get(bl.cost_code_id) ?? 0) + amount)
    }
    const desc = (bl.description ?? "").trim().toLowerCase()
    if (desc) baselineByDescription.set(desc, (baselineByDescription.get(desc) ?? 0) + amount)
  }
  const lineDescById = new Map<string, string>()
  for (const line of budget.lines ?? []) {
    lineDescById.set(line.id, (line.description ?? "").trim().toLowerCase())
  }

  let totalBudget = 0
  let totalCommitted = 0
  let totalCommittedBilled = 0
  let totalPendingCost = 0
  let totalActual = 0
  let totalInvoiced = 0
  let totalCOAdjustment = 0
  let totalEac = 0
  let totalCtc = 0
  let totalVac = 0
  let totalBaseline = 0

  const breakdown = Array.from(byCostCode.entries()).map(([bucketId, values]) => {
    const resolvedId = bucketId === "uncoded" ? null : bucketId
    const costCodeId = costCodesEnabled ? resolvedId : null
    const budgetLineId = costCodesEnabled ? null : resolvedId
    totalBudget += values.budget_cents
    totalCommitted += values.committed_cents
    totalCommittedBilled += values.committed_billed_cents
    totalPendingCost += values.pending_cost_cents
    totalActual += values.actual_cents
    totalInvoiced += values.invoiced_cents
    totalCOAdjustment += values.co_adjustment_cents

    let baseline_cents: number | null = null
    if (hasBaseline) {
      if (costCodesEnabled) {
        baseline_cents = resolvedId ? baselineByCostCode.get(resolvedId) ?? 0 : 0
      } else {
        const byLineId = resolvedId ? baselineByLineId.get(resolvedId) : undefined
        const desc = lineDescById.get(bucketId)
        baseline_cents = byLineId ?? (desc ? baselineByDescription.get(desc) ?? 0 : 0)
      }
      totalBaseline += baseline_cents ?? 0
    }

    const adjustedBudget = values.budget_cents + values.co_adjustment_cents
    const variance = adjustedBudget - values.actual_cents
    const variancePercent = adjustedBudget > 0 ? Math.round((values.actual_cents / adjustedBudget) * 100) : 0
    const exposure_cents = values.actual_cents + values.pending_cost_cents
    const remaining_commitment_cents = values.committed_cents - values.committed_billed_cents
    const isOverbilled = values.committed_cents > 0 && values.committed_billed_cents > values.committed_cents

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
      baseline_cents,
      co_adjustment_cents: values.co_adjustment_cents,
      adjusted_budget_cents: adjustedBudget,
      committed_cents: values.committed_cents,
      committed_billed_cents: values.committed_billed_cents,
      remaining_commitment_cents,
      pending_cost_cents: values.pending_cost_cents,
      exposure_cents,
      actual_cents: values.actual_cents,
      invoiced_cents: values.invoiced_cents,
      variance_cents: variance,
      variance_percent: variancePercent,
      percent_complete: values.percent_complete,
      eac_cents,
      cost_to_complete_cents,
      variance_at_completion_cents,
      status:
        variance_at_completion_cents < 0 || isOverbilled
          ? "over"
          : values.percent_complete != null && variancePercent > values.percent_complete + 15
            ? "warning"
            : "ok",
    }
  })

  const adjustedTotalBudget = totalBudget + totalCOAdjustment
  const grossMarginCents = totalInvoiced - totalActual
  const grossMarginPercent = totalInvoiced > 0 ? Math.round((grossMarginCents / totalInvoiced) * 100) : 0

  return {
    budget,
    summary: {
      total_budget_cents: totalBudget,
      total_baseline_cents: hasBaseline ? totalBaseline : null,
      baseline_locked_at: ((budget as any).baseline_locked_at as string | null) ?? null,
      total_co_adjustment_cents: totalCOAdjustment,
      adjusted_budget_cents: adjustedTotalBudget,
      total_committed_cents: totalCommitted,
      total_committed_billed_cents: totalCommittedBilled,
      total_remaining_commitment_cents: totalCommitted - totalCommittedBilled,
      total_pending_cost_cents: totalPendingCost,
      total_exposure_cents: totalActual + totalPendingCost,
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

export async function checkVarianceAlerts(projectId: string, orgId: string, thresholds = [15], actorUserId?: string) {
  const supabase = createServiceSupabaseClient()
  if (actorUserId) {
    await requireBudgetAuth({
      permission: "budget.write",
      userId: actorUserId,
      orgId,
      projectId,
      supabase,
    })
  }
  const data = await getBudgetWithActualsInternal(supabase, projectId, orgId)
  if (!data?.budget) return []

  const alerts: any[] = []

  for (const line of data.breakdown) {
    const projectedOverrun = line.variance_at_completion_cents < 0
    const spendPaceDelta =
      line.percent_complete != null ? line.variance_percent - line.percent_complete : 0
    const isSpendOutpacingProgress = spendPaceDelta >= thresholds[0]
    if (projectedOverrun || isSpendOutpacingProgress) {
      const alertType = projectedOverrun ? "over_budget" : "threshold_exceeded"
      const currentPercent =
        projectedOverrun && line.adjusted_budget_cents > 0
          ? Math.round((Math.abs(line.variance_at_completion_cents) / line.adjusted_budget_cents) * 100)
          : Math.round(spendPaceDelta)
      const matchedThreshold = thresholds.find((t) => currentPercent >= t) ?? thresholds[0] ?? 0

      let existingQuery = supabase
        .from("variance_alerts")
        .select("id")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("alert_type", alertType)
        .eq("status", "active")

      if (line.cost_code_id) {
        existingQuery = existingQuery.eq("cost_code_id", line.cost_code_id).is("budget_line_id", null)
      } else if (line.budget_line_id) {
        existingQuery = existingQuery.eq("budget_line_id", line.budget_line_id).is("cost_code_id", null)
      } else {
        existingQuery = existingQuery.is("cost_code_id", null).is("budget_line_id", null)
      }

      const { data: existing, error } = await existingQuery.maybeSingle()

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
            budget_line_id: line.budget_line_id,
            alert_type: alertType,
            threshold_percent: matchedThreshold,
            current_percent: currentPercent,
            budget_cents: line.adjusted_budget_cents,
            actual_cents: line.actual_cents,
            variance_cents: projectedOverrun ? line.variance_at_completion_cents : line.variance_cents,
            metadata: {
              reason: projectedOverrun ? "projected_overrun" : "spent_outpacing_progress",
              percent_complete: line.percent_complete,
              percent_spent: line.variance_percent,
              eac_cents: line.eac_cents,
              vac_cents: line.variance_at_completion_cents,
            },
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
  await requirePermission("budget.write", { supabase, orgId: resolvedOrgId, userId })

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
  userId,
  projectId,
  costCodeId,
  percentComplete,
  estimateRemainingCents,
  notes,
}: {
  orgId: string
  userId: string
  projectId: string
  costCodeId: string
  percentComplete: number | null
  estimateRemainingCents: number | null
  notes: string | null
}) {
  const supabase = createServiceSupabaseClient()
  await requireBudgetAuth({
    permission: "budget.write",
    userId,
    orgId,
    projectId,
    supabase,
  })

  const { error } = await supabase
    .from("project_cost_code_progress")
    .upsert({
      org_id: orgId,
      project_id: projectId,
      cost_code_id: costCodeId,
      percent_complete: percentComplete,
      estimate_remaining_cents: estimateRemainingCents,
      notes: notes,
      recorded_by_user_id: userId,
    }, {
      onConflict: "org_id, project_id, cost_code_id"
    })

  if (error) {
    throw new Error(`Failed to update cost code progress: ${error.message}`)
  }
}
