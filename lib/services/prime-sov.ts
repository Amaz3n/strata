import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { buildBudgetDraftFromEstimate, listBudgetEstimateSources } from "@/lib/services/budget-from-estimate"
import { primeSovLinesUpsertSchema, type PrimeSovLineInput } from "@/lib/validation/pay-applications"

export interface PrimeSovLine {
  id: string
  contract_id: string
  line_number: number
  description: string
  cost_code_id: string | null
  cost_code_label: string | null
  budget_line_id: string | null
  scheduled_value_cents: number
  previous_billed_cents: number
  stored_materials_cents: number
  retainage_held_cents: number
  retainage_released_cents: number
  retainage_percent_override: number | null
  sort_order: number
}

export interface PrimeSovSummary {
  contract_id: string
  /** Revised contract sum (snapshot.revised_total_cents falls back to total_cents). */
  contract_sum_cents: number
  scheduled_total_cents: number
  /** scheduled_total − contract_sum; non-zero means the SOV needs reconciling. */
  variance_cents: number
  billed_total_cents: number
  stored_total_cents: number
  retainage_held_cents: number
  retainage_released_cents: number
  has_billing: boolean
}

export interface PrimeSovState {
  lines: PrimeSovLine[]
  summary: PrimeSovSummary | null
}

const SOV_LINE_SELECT =
  "id, contract_id, line_number, description, cost_code_id, budget_line_id, scheduled_value_cents, previous_billed_cents, stored_materials_cents, retainage_held_cents, retainage_released_cents, retainage_percent_override, sort_order"

type SovLineRow = {
  id: string
  contract_id: string
  line_number: number
  description: string
  cost_code_id: string | null
  budget_line_id: string | null
  scheduled_value_cents: number
  previous_billed_cents: number
  stored_materials_cents: number
  retainage_held_cents: number
  retainage_released_cents: number
  retainage_percent_override: number | null
  sort_order: number
}

function lineHasBilling(row: Pick<SovLineRow, "previous_billed_cents" | "stored_materials_cents" | "retainage_held_cents">) {
  return row.previous_billed_cents !== 0 || row.stored_materials_cents !== 0 || row.retainage_held_cents !== 0
}

export async function getProgressBillingContract(supabase: SupabaseClient, orgId: string, projectId: string) {
  const { data, error } = await supabase
    .from("contracts")
    .select("id, project_id, status, total_cents, retainage_percent, retainage_schedule, stored_materials_retainage_percent, snapshot")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["active", "amended", "completed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load billing contract: ${error.message}`)
  }
  return data
}

function resolveContractSumCents(contract: { total_cents?: number | null; snapshot?: Record<string, any> | null }): number {
  const revised = Number(contract.snapshot?.revised_total_cents ?? NaN)
  if (Number.isFinite(revised) && revised > 0) return Math.round(revised)
  return Number(contract.total_cents ?? 0)
}

async function attachCostCodeLabels(
  supabase: SupabaseClient,
  orgId: string,
  rows: SovLineRow[],
): Promise<PrimeSovLine[]> {
  const codeIds = Array.from(new Set(rows.map((row) => row.cost_code_id).filter((id): id is string => Boolean(id))))
  const labels = new Map<string, string>()
  if (codeIds.length > 0) {
    const { data: codes, error } = await supabase
      .from("cost_codes")
      .select("id, code, name")
      .eq("org_id", orgId)
      .in("id", codeIds)
    if (error) {
      throw new Error(`Failed to load cost codes: ${error.message}`)
    }
    for (const code of codes ?? []) {
      labels.set(code.id as string, [code.code, code.name].filter(Boolean).join(" "))
    }
  }

  return rows.map((row) => ({
    ...row,
    cost_code_label: row.cost_code_id ? labels.get(row.cost_code_id) ?? null : null,
  }))
}

export async function listPrimeSovLines(projectId: string, orgId?: string): Promise<PrimeSovState> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    resourceType: "project",
    resourceId: projectId,
  })

  return loadPrimeSovState(supabase, resolvedOrgId, projectId)
}

async function loadPrimeSovState(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
): Promise<PrimeSovState> {
  const contract = await getProgressBillingContract(supabase, orgId, projectId)
  if (!contract) {
    return { lines: [], summary: null }
  }

  const { data: rows, error } = await supabase
    .from("prime_sov_lines")
    .select(SOV_LINE_SELECT)
    .eq("org_id", orgId)
    .eq("contract_id", contract.id)
    .order("line_number", { ascending: true })

  if (error) {
    throw new Error(`Failed to load schedule of values: ${error.message}`)
  }

  const lines = await attachCostCodeLabels(supabase, orgId, (rows ?? []) as SovLineRow[])
  const scheduledTotal = lines.reduce((sum, line) => sum + line.scheduled_value_cents, 0)
  const contractSum = resolveContractSumCents(contract)

  return {
    lines,
    summary: {
      contract_id: contract.id as string,
      contract_sum_cents: contractSum,
      scheduled_total_cents: scheduledTotal,
      variance_cents: scheduledTotal - contractSum,
      billed_total_cents: lines.reduce((sum, line) => sum + line.previous_billed_cents, 0),
      stored_total_cents: lines.reduce((sum, line) => sum + line.stored_materials_cents, 0),
      retainage_held_cents: lines.reduce((sum, line) => sum + line.retainage_held_cents, 0),
      retainage_released_cents: lines.reduce((sum, line) => sum + line.retainage_released_cents, 0),
      has_billing: lines.some(lineHasBilling),
    },
  }
}

/**
 * Bulk grid save: the SOV is edited as a whole. Lines are renumbered
 * sequentially in array order. Removing or repricing a line that already has
 * billing is blocked unless the change comes from a CO posting
 * (`fromChangeOrder`, used by `applyChangeOrderToSov` / workstream 03).
 */
export async function upsertPrimeSovLines(
  projectId: string,
  input: { lines: PrimeSovLineInput[] },
  options?: { orgId?: string; fromChangeOrder?: boolean },
): Promise<PrimeSovState> {
  const parsed = primeSovLinesUpsertSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(options?.orgId)
  await requireAuthorization({
    permission: "sov.write",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  const contract = await getProgressBillingContract(supabase, resolvedOrgId, projectId)
  if (!contract) {
    throw new Error("Set up the billing contract before building a schedule of values")
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("prime_sov_lines")
    .select(SOV_LINE_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", contract.id)

  if (existingError) {
    throw new Error(`Failed to load schedule of values: ${existingError.message}`)
  }

  const existingById = new Map(((existingRows ?? []) as SovLineRow[]).map((row) => [row.id, row]))
  const incomingIds = new Set(parsed.lines.map((line) => line.id).filter((id): id is string => Boolean(id)))

  for (const id of incomingIds) {
    if (!existingById.has(id)) {
      throw new Error("SOV line does not belong to this contract")
    }
  }

  const removed = Array.from(existingById.values()).filter((row) => !incomingIds.has(row.id))
  const blockedRemoval = removed.find(lineHasBilling)
  if (blockedRemoval) {
    throw new Error(
      `Line ${blockedRemoval.line_number} has been billed against and cannot be removed. Adjust it with a change order instead.`,
    )
  }

  if (!options?.fromChangeOrder) {
    for (const line of parsed.lines) {
      if (!line.id) continue
      const existing = existingById.get(line.id)
      if (existing && lineHasBilling(existing) && existing.scheduled_value_cents !== line.scheduled_value_cents) {
        throw new Error(
          `Line ${existing.line_number} has been billed against; its scheduled value can only change through a change order.`,
        )
      }
    }
  }

  if (removed.length > 0) {
    const { error: deleteError } = await supabase
      .from("prime_sov_lines")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq("contract_id", contract.id)
      .in(
        "id",
        removed.map((row) => row.id),
      )
    if (deleteError) {
      throw new Error(`Failed to remove SOV lines: ${deleteError.message}`)
    }
  }

  // Renumber in two passes so the (contract_id, line_number) unique constraint
  // never collides mid-save: park kept lines on negative numbers first.
  const keptIds = parsed.lines.map((line) => line.id).filter((id): id is string => Boolean(id))
  for (let index = 0; index < keptIds.length; index += 1) {
    const { error: parkError } = await supabase
      .from("prime_sov_lines")
      .update({ line_number: -(index + 1) })
      .eq("org_id", resolvedOrgId)
      .eq("id", keptIds[index])
    if (parkError) {
      throw new Error(`Failed to renumber SOV lines: ${parkError.message}`)
    }
  }

  for (let index = 0; index < parsed.lines.length; index += 1) {
    const line = parsed.lines[index]
    const payload = {
      description: line.description,
      cost_code_id: line.cost_code_id ?? null,
      budget_line_id: line.budget_line_id ?? null,
      scheduled_value_cents: line.scheduled_value_cents,
      retainage_percent_override: line.retainage_percent_override ?? null,
      line_number: index + 1,
      sort_order: index,
    }

    if (line.id) {
      const { error: updateError } = await supabase
        .from("prime_sov_lines")
        .update(payload)
        .eq("org_id", resolvedOrgId)
        .eq("id", line.id)
      if (updateError) {
        throw new Error(`Failed to update SOV line: ${updateError.message}`)
      }
    } else {
      const { error: insertError } = await supabase.from("prime_sov_lines").insert({
        ...payload,
        org_id: resolvedOrgId,
        project_id: projectId,
        contract_id: contract.id,
      })
      if (insertError) {
        throw new Error(`Failed to add SOV line: ${insertError.message}`)
      }
    }
  }

  const state = await listPrimeSovLines(projectId, resolvedOrgId)

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "prime_sov_updated",
    entityType: "contract",
    entityId: contract.id as string,
    payload: {
      project_id: projectId,
      line_count: state.lines.length,
      scheduled_total_cents: state.summary?.scheduled_total_cents ?? 0,
      from_change_order: options?.fromChangeOrder ?? false,
    },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "prime_sov",
    entityId: contract.id as string,
    after: {
      project_id: projectId,
      line_count: state.lines.length,
      scheduled_total_cents: state.summary?.scheduled_total_cents ?? 0,
    },
  })

  return state
}

async function assertSovReplaceable(projectId: string, orgId: string, supabase: SupabaseClient, contractId: string) {
  const { data: billed, error } = await supabase
    .from("prime_sov_lines")
    .select("id")
    .eq("org_id", orgId)
    .eq("contract_id", contractId)
    .or("previous_billed_cents.neq.0,stored_materials_cents.neq.0,retainage_held_cents.neq.0")
    .limit(1)
  if (error) {
    throw new Error(`Failed to check SOV billing state: ${error.message}`)
  }
  if ((billed ?? []).length > 0) {
    throw new Error("This SOV has pay applications billed against it and cannot be regenerated.")
  }
}

/**
 * Generate SOV lines from the latest budget. Budget lines with cost codes
 * group into one SOV line per code; uncoded lines (cost-codes-off buckets)
 * carry over one-to-one. Replaces the current, unbilled SOV.
 */
export async function importSovFromBudget(projectId: string, orgId?: string): Promise<PrimeSovState> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "sov.write",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  const contract = await getProgressBillingContract(supabase, resolvedOrgId, projectId)
  if (!contract) {
    throw new Error("Set up the billing contract before building a schedule of values")
  }
  await assertSovReplaceable(projectId, resolvedOrgId, supabase, contract.id as string)

  const { data: budget, error: budgetError } = await supabase
    .from("budgets")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (budgetError) {
    throw new Error(`Failed to load budget: ${budgetError.message}`)
  }
  if (!budget) {
    throw new Error("This project has no budget to import from")
  }

  const { data: budgetLines, error: linesError } = await supabase
    .from("budget_lines")
    .select("id, cost_code_id, description, amount_cents, sort_order")
    .eq("org_id", resolvedOrgId)
    .eq("budget_id", budget.id)
    .order("sort_order", { ascending: true })
  if (linesError) {
    throw new Error(`Failed to load budget lines: ${linesError.message}`)
  }
  if (!budgetLines || budgetLines.length === 0) {
    throw new Error("The budget has no lines to import")
  }

  const codeIds = Array.from(
    new Set(budgetLines.map((line) => line.cost_code_id).filter((id): id is string => Boolean(id))),
  )
  const codeLabels = new Map<string, string>()
  if (codeIds.length > 0) {
    const { data: codes } = await supabase.from("cost_codes").select("id, code, name").eq("org_id", resolvedOrgId).in("id", codeIds)
    for (const code of codes ?? []) {
      codeLabels.set(code.id as string, [code.code, code.name].filter(Boolean).join(" "))
    }
  }

  // Group coded lines per cost code; uncoded budget lines become one SOV line
  // each (cost-codes-off budgets run in lines-as-buckets mode).
  const grouped = new Map<string, PrimeSovLineInput>()
  const proposed: PrimeSovLineInput[] = []
  for (const line of budgetLines) {
    const amount = Number(line.amount_cents ?? 0)
    if (amount === 0) continue
    if (line.cost_code_id) {
      const existing = grouped.get(line.cost_code_id)
      if (existing) {
        existing.scheduled_value_cents += amount
        continue
      }
      const entry: PrimeSovLineInput = {
        description: codeLabels.get(line.cost_code_id) ?? line.description ?? "Budget line",
        cost_code_id: line.cost_code_id,
        budget_line_id: line.id as string,
        scheduled_value_cents: amount,
      }
      grouped.set(line.cost_code_id, entry)
      proposed.push(entry)
    } else {
      proposed.push({
        description: line.description ?? "Budget line",
        cost_code_id: null,
        budget_line_id: line.id as string,
        scheduled_value_cents: amount,
      })
    }
  }

  if (proposed.length === 0) {
    throw new Error("The budget has no non-zero lines to import")
  }

  return upsertPrimeSovLines(projectId, { lines: proposed }, { orgId: resolvedOrgId })
}

/**
 * Generate SOV lines from the newest estimate with cost lines (or an explicit
 * one), reusing the budget-from-estimate draft mechanics. Replaces the
 * current, unbilled SOV.
 */
export async function importSovFromEstimate(
  projectId: string,
  options?: { estimateId?: string; orgId?: string },
): Promise<PrimeSovState> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(options?.orgId)
  await requireAuthorization({
    permission: "sov.write",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  const contract = await getProgressBillingContract(supabase, resolvedOrgId, projectId)
  if (!contract) {
    throw new Error("Set up the billing contract before building a schedule of values")
  }
  await assertSovReplaceable(projectId, resolvedOrgId, supabase, contract.id as string)

  let estimateId = options?.estimateId
  if (!estimateId) {
    const sources = await listBudgetEstimateSources(projectId, resolvedOrgId)
    estimateId = sources[0]?.id
  }
  if (!estimateId) {
    throw new Error("This project has no estimate to import from")
  }

  const { data: settings } = await supabase
    .from("project_financial_settings")
    .select("cost_codes_enabled")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .maybeSingle()

  const draft = await buildBudgetDraftFromEstimate({
    projectId,
    estimateId,
    costCodesEnabled: settings?.cost_codes_enabled !== false,
    orgId: resolvedOrgId,
  })

  const proposed: PrimeSovLineInput[] = draft.lines
    .filter((line) => line.amount_cents !== 0)
    .map((line) => ({
      description: line.cost_code_label ?? line.description ?? "Estimate line",
      cost_code_id: line.cost_code_id ?? null,
      budget_line_id: null,
      scheduled_value_cents: line.amount_cents,
    }))

  if (proposed.length === 0) {
    throw new Error("The estimate has no cost lines to import")
  }

  return upsertPrimeSovLines(projectId, { lines: proposed }, { orgId: resolvedOrgId })
}

/**
 * Append SOV line(s) for an approved prime change order (workstream 03 calls
 * this on OCO approval). One line per CO line when the lines carry distinct
 * cost codes; otherwise a single line for the whole CO.
 */
export async function applyChangeOrderToSov(changeOrderId: string, orgId?: string): Promise<PrimeSovState> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: changeOrder, error: coError } = await supabase
    .from("change_orders")
    .select("id, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)
    .maybeSingle()
  if (coError || !changeOrder) {
    throw new Error("Change order not found")
  }

  await requireAuthorization({
    permission: "sov.write",
    userId,
    orgId: resolvedOrgId,
    projectId: changeOrder.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  return applyApprovedChangeOrderToSov({
    supabase,
    orgId: resolvedOrgId,
    changeOrderId,
    actorId: userId,
  })
}

export async function applyApprovedChangeOrderToSov({
  supabase,
  orgId: resolvedOrgId,
  changeOrderId,
  actorId,
}: {
  supabase: SupabaseClient
  orgId: string
  changeOrderId: string
  actorId?: string | null
}): Promise<PrimeSovState> {

  const { data: changeOrder, error: coError } = await supabase
    .from("change_orders")
    .select("id, project_id, title, total_cents, status, lifecycle, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)
    .maybeSingle()
  if (coError || !changeOrder) {
    throw new Error("Change order not found")
  }

  if (changeOrder.lifecycle !== "approved") {
    throw new Error("Only approved change orders post to the schedule of values")
  }

  const current = await loadPrimeSovState(supabase, resolvedOrgId, changeOrder.project_id as string)
  if (!current.summary) {
    throw new Error("Set up the billing contract before posting change orders to the SOV")
  }

  const { data: existingCoLines, error: existingCoError } = await supabase
    .from("prime_sov_lines")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", current.summary.contract_id)
    .eq("metadata->>source_change_order_id", changeOrderId)
    .limit(1)
  if (existingCoError) {
    throw new Error(`Failed to check change-order SOV state: ${existingCoError.message}`)
  }
  if ((existingCoLines ?? []).length > 0) {
    return current
  }

  const { data: coLines, error: coLinesError } = await supabase
    .from("change_order_lines")
    .select("id, cost_code_id, description, quantity, unit_cost_cents, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("change_order_id", changeOrderId)
  if (coLinesError) {
    throw new Error(`Failed to load change order lines: ${coLinesError.message}`)
  }

  const distinctCodes = new Set((coLines ?? []).map((line) => line.cost_code_id).filter(Boolean))
  const nextNumber = current.lines.reduce((max, line) => Math.max(max, line.line_number), 0) + 1
  const coLabel = `CO — ${changeOrder.title ?? "Change order"}`

  const inserts =
    (coLines ?? []).length > 1 && distinctCodes.size > 1
      ? (coLines ?? []).map((line, index) => ({
          org_id: resolvedOrgId,
          project_id: changeOrder.project_id,
          contract_id: current.summary!.contract_id,
          line_number: nextNumber + index,
          sort_order: nextNumber + index - 1,
          description: `${coLabel}: ${line.description ?? "Line"}`,
          cost_code_id: line.cost_code_id ?? null,
          scheduled_value_cents:
            Math.round(Number(line.quantity ?? 1) * Number(line.unit_cost_cents ?? 0)) +
            Number((line.metadata as Record<string, unknown> | null)?.allowance_cents ?? 0),
          metadata: { source_change_order_id: changeOrderId, source_change_order_line_id: line.id },
        }))
      : [
          {
            org_id: resolvedOrgId,
            project_id: changeOrder.project_id,
            contract_id: current.summary.contract_id,
            line_number: nextNumber,
            sort_order: nextNumber - 1,
            description: coLabel,
            cost_code_id: null,
            scheduled_value_cents: Number(changeOrder.total_cents ?? 0),
            metadata: { source_change_order_id: changeOrderId },
          },
        ]

  const { error: insertError } = await supabase.from("prime_sov_lines").insert(inserts)
  if (insertError) {
    throw new Error(`Failed to post change order to the SOV: ${insertError.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: actorId ?? undefined,
    eventType: "prime_sov_updated",
    entityType: "contract",
    entityId: current.summary.contract_id,
    payload: {
      project_id: changeOrder.project_id,
      source_change_order_id: changeOrderId,
      appended_lines: inserts.length,
    },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: actorId ?? undefined,
    action: "update",
    entityType: "prime_sov",
    entityId: current.summary.contract_id,
    after: { source_change_order_id: changeOrderId, appended_lines: inserts.length },
  })

  return loadPrimeSovState(supabase, resolvedOrgId, changeOrder.project_id as string)
}
