import { validateBudgetTransfer } from "@/lib/financials/budget-transfer-math"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { budgetTransferInputSchema, type BudgetTransferInput } from "@/lib/validation/budget-transfers"

const TRANSFER_SELECT = `
  id, org_id, project_id, transfer_number, reason, status, requested_by,
  approved_by, approved_at, budget_revision_id, metadata, created_at, updated_at,
  lines:budget_transfer_lines(id, budget_line_id, amount_cents,
    budget_line:budget_lines(id, description, cost_code_id, amount_cents, metadata,
      cost_code:cost_codes(id, code, name)))
`

export type BudgetTransfer = {
  id: string
  org_id: string
  project_id: string
  transfer_number: number
  reason: string
  status: "draft" | "pending_approval" | "approved" | "rejected" | "void"
  requested_by: string | null
  approved_by: string | null
  approved_at: string | null
  budget_revision_id: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  lines: Array<{
    id: string
    budget_line_id: string
    amount_cents: number
    budget_line: {
      id: string
      description: string
      cost_code_id: string | null
      amount_cents: number | null
      metadata: Record<string, unknown>
      cost_code: { id: string; code: string; name: string } | null
    } | null
  }>
}

async function requireProjectPermission(
  permission: "budget.read" | "budget.write" | "budget.approve",
  args: { supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]; orgId: string; userId: string; projectId: string },
) {
  await requireAuthorization({
    permission,
    userId: args.userId,
    orgId: args.orgId,
    projectId: args.projectId,
    supabase: args.supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: args.projectId,
  })
}

export async function listBudgetTransfers(projectId: string, orgId?: string): Promise<BudgetTransfer[]> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission("budget.read", { ...context, projectId })
  const { data, error } = await context.supabase
    .from("budget_transfers")
    .select(TRANSFER_SELECT)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("transfer_number", { ascending: false })
    .limit(100)
  if (error) throw new Error(`Failed to list budget transfers: ${error.message}`)
  return (data ?? []) as unknown as BudgetTransfer[]
}

async function buildValidatedLines(input: BudgetTransferInput, orgId: string) {
  const context = await requireOrgContext(orgId)
  const ids = input.lines.map((line) => line.budget_line_id)
  const [{ data: budgetLines, error }, budgetData] = await Promise.all([
    context.supabase
      .from("budget_lines")
      .select("id, budget_id, cost_code_id, description, amount_cents, metadata, budget:budgets!inner(project_id)")
      .eq("org_id", orgId)
      .in("id", ids)
      .eq("budget.project_id", input.project_id),
    getBudgetWithActuals(input.project_id, orgId),
  ])
  if (error) throw new Error(`Failed to load budget lines: ${error.message}`)
  if ((budgetLines ?? []).length !== ids.length || !budgetData) throw new Error("One or more budget lines were not found")

  const breakdown = budgetData.breakdown as Array<{
    budget_line_id: string | null
    cost_code_id: string | null
    actual_cents: number
    committed_cents: number
  }>
  const validatedLines = input.lines.map((line) => {
    const budgetLine = budgetLines?.find((candidate) => candidate.id === line.budget_line_id)
    if (!budgetLine) throw new Error("Budget line not found")
    const bucket = breakdown.find((row) =>
      row.budget_line_id === budgetLine.id ||
      (budgetLine.cost_code_id != null && row.cost_code_id === budgetLine.cost_code_id),
    )
    return {
      budgetLineId: line.budget_line_id,
      amountCents: line.amount_cents,
      currentBudgetCents: Number(budgetLine.amount_cents ?? 0) +
        Number((bucket && "co_adjustment_cents" in bucket ? bucket.co_adjustment_cents : 0) ?? 0),
      actualCents: bucket?.actual_cents ?? 0,
      committedCents: bucket?.committed_cents ?? 0,
      budgetLine,
    }
  })
  const validation = validateBudgetTransfer(validatedLines, {
    allowOverride: input.allow_override,
    overrideReason: input.override_reason,
  })
  if (!validation.valid) throw new Error(validation.errors.join(". "))
  return { validatedLines, validation }
}

export async function createBudgetTransfer(input: unknown, orgId?: string): Promise<BudgetTransfer> {
  const parsed = budgetTransferInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission("budget.write", { ...context, projectId: parsed.project_id })
  if (parsed.allow_override) {
    await requireProjectPermission("budget.approve", { ...context, projectId: parsed.project_id })
  }
  const { validation } = await buildValidatedLines(parsed, context.orgId)

  const { data: transfer } = await insertWithProjectNumberRetry<BudgetTransfer>({
    supabase: context.supabase,
    table: "budget_transfers",
    numberColumn: "transfer_number",
    rpcName: "next_budget_transfer_number",
    conflictConstraint: "budget_transfers_project_id_transfer_number_key",
    projectId: parsed.project_id,
    payload: {
      org_id: context.orgId,
      project_id: parsed.project_id,
      reason: parsed.reason,
      status: "pending_approval",
      requested_by: context.userId,
      metadata: {
        allow_override: parsed.allow_override,
        override_reason: parsed.override_reason ?? null,
        floor_violations: validation.floorViolations,
      },
    },
    select: "id, org_id, project_id, transfer_number, reason, status, requested_by, approved_by, approved_at, budget_revision_id, metadata, created_at, updated_at",
    entityLabel: "budget transfer",
  })

  const { error: lineError } = await context.supabase.from("budget_transfer_lines").insert(
    parsed.lines.map((line) => ({
      org_id: context.orgId,
      transfer_id: transfer.id,
      budget_line_id: line.budget_line_id,
      amount_cents: line.amount_cents,
    })),
  )
  if (lineError) throw new Error(`Failed to create budget transfer lines: ${lineError.message}`)

  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "budget_transfer", entityId: transfer.id, after: { ...transfer, lines: parsed.lines } })
  return (await listBudgetTransfers(parsed.project_id, context.orgId)).find((item) => item.id === transfer.id) ?? transfer
}

export async function approveBudgetTransfer(transferId: string, orgId?: string): Promise<BudgetTransfer> {
  const context = await requireOrgContext(orgId)
  const { data: existing, error } = await context.supabase
    .from("budget_transfers")
    .select(TRANSFER_SELECT)
    .eq("org_id", context.orgId)
    .eq("id", transferId)
    .maybeSingle()
  if (error || !existing) throw new Error("Budget transfer not found")
  const transfer = existing as unknown as BudgetTransfer
  await requireProjectPermission("budget.approve", { ...context, projectId: transfer.project_id })
  if (transfer.status !== "pending_approval") throw new Error("Only pending transfers can be approved")
  if (transfer.requested_by === context.userId) throw new Error("The requester cannot approve their own budget transfer")

  await buildValidatedLines({
    project_id: transfer.project_id,
    reason: transfer.reason,
    lines: transfer.lines.map((line) => ({ budget_line_id: line.budget_line_id, amount_cents: line.amount_cents })),
    allow_override: transfer.metadata.allow_override === true,
    override_reason: typeof transfer.metadata.override_reason === "string" ? transfer.metadata.override_reason : null,
  }, context.orgId)

  const { error: postError } = await context.supabase.rpc("post_budget_transfer", {
    p_transfer_id: transfer.id,
    p_actor_id: context.userId,
  })
  if (postError) throw new Error(`Failed to post budget transfer: ${postError.message}`)
  const updated = (await listBudgetTransfers(transfer.project_id, context.orgId)).find((item) => item.id === transfer.id)
  if (!updated) throw new Error("Approved budget transfer could not be reloaded")

  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "budget_transfer.approved", entityType: "budget_transfer", entityId: transfer.id, payload: { project_id: transfer.project_id, transfer_number: transfer.transfer_number } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "budget_transfer", entityId: transfer.id, before: transfer, after: updated })
  return updated
}

export async function closeBudgetTransfer(
  transferId: string,
  status: "rejected" | "void",
  reason: string,
  orgId?: string,
): Promise<BudgetTransfer> {
  const context = await requireOrgContext(orgId)
  const { data: existing } = await context.supabase
    .from("budget_transfers")
    .select(TRANSFER_SELECT)
    .eq("org_id", context.orgId)
    .eq("id", transferId)
    .maybeSingle()
  if (!existing) throw new Error("Budget transfer not found")
  const transfer = existing as unknown as BudgetTransfer
  await requireProjectPermission("budget.approve", { ...context, projectId: transfer.project_id })
  if (reason.trim().length < 3) throw new Error("A reason is required")
  if (status === "rejected" && transfer.status !== "pending_approval") throw new Error("Only pending transfers can be rejected")
  if (status === "void" && !["pending_approval", "approved"].includes(transfer.status)) throw new Error("Only pending or approved transfers can be voided")

  const { error } = await context.supabase.rpc("close_budget_transfer", {
    p_transfer_id: transferId,
    p_actor_id: context.userId,
    p_status: status,
    p_reason: reason.trim(),
  })
  if (error) throw new Error(`Failed to ${status} budget transfer: ${error.message}`)
  const updated = (await listBudgetTransfers(transfer.project_id, context.orgId)).find((item) => item.id === transfer.id)
  if (!updated) throw new Error("Budget transfer could not be reloaded")
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "budget_transfer", entityId: transfer.id, before: transfer, after: updated })
  return updated
}

export async function setBudgetLineContingency(budgetLineId: string, isContingency: boolean, orgId?: string) {
  const context = await requireOrgContext(orgId)
  const { data: line } = await context.supabase.from("budget_lines").select("id, metadata, budget:budgets!inner(project_id)").eq("org_id", context.orgId).eq("id", budgetLineId).maybeSingle()
  const relatedBudget = Array.isArray(line?.budget) ? line.budget[0] : line?.budget
  const projectId = relatedBudget?.project_id
  if (!line || !projectId) throw new Error("Budget line not found")
  await requireProjectPermission("budget.write", { ...context, projectId })
  const { error } = await context.supabase.from("budget_lines").update({ metadata: { ...(line.metadata ?? {}), is_contingency: isContingency } }).eq("org_id", context.orgId).eq("id", budgetLineId)
  if (error) throw new Error(`Failed to update contingency line: ${error.message}`)
}
