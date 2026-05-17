"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createBudget, duplicateBudgetVersion, replaceBudgetLines, updateBudgetStatus, acknowledgeVarianceAlert, checkVarianceAlerts, updateCostCodeProgress } from "@/lib/services/budgets"
import { requireOrgContext } from "@/lib/services/context"

function revalidateBudgetPages(projectId: string) {
  revalidatePath(`/projects/${projectId}/budget`)
  revalidatePath(`/projects/${projectId}/financials`)
  revalidatePath(`/projects/${projectId}/financials/budget`)
  revalidatePath(`/projects/${projectId}`)
}

const budgetLineInputSchema = z.object({
  cost_code_id: z.string().uuid().nullable().optional(),
  description: z.string().min(1),
  amount_cents: z.number().int().min(0),
  metadata: z.record(z.any()).optional(),
})

const upsertBudgetSchema = z.object({
  project_id: z.string().uuid(),
  lines: z.array(budgetLineInputSchema),
  status: z.enum(["draft", "approved", "locked"]).optional(),
})

export async function createProjectBudgetAction(input: unknown) {
  const parsed = upsertBudgetSchema.parse(input)
  const result = await createBudget(
    {
      project_id: parsed.project_id,
      status: parsed.status ?? "draft",
      lines: parsed.lines.map((l) => ({ ...l, cost_code_id: l.cost_code_id ?? undefined })),
    },
    undefined,
  )
  revalidateBudgetPages(parsed.project_id)
  return result
}

export async function replaceProjectBudgetLinesAction(projectId: string, budgetId: string, linesInput: unknown) {
  const lines = z.array(budgetLineInputSchema).parse(linesInput)
  const updated = await replaceBudgetLines({ budgetId, lines })
  revalidateBudgetPages(projectId)
  return updated
}

export async function updateProjectBudgetStatusAction(projectId: string, budgetId: string, statusInput: unknown) {
  const status = z.enum(["draft", "approved", "locked"]).parse(statusInput)
  const updated = await updateBudgetStatus({ budgetId, status })
  revalidateBudgetPages(projectId)
  return updated
}

export async function duplicateProjectBudgetVersionAction(projectId: string, fromBudgetId: string) {
  const created = await duplicateBudgetVersion({ projectId, fromBudgetId })
  revalidateBudgetPages(projectId)
  return created
}

export async function acknowledgeVarianceAlertAction(projectId: string, alertId: string, statusInput?: unknown) {
  const status = statusInput ? z.enum(["acknowledged", "resolved"]).parse(statusInput) : "acknowledged"
  const updated = await acknowledgeVarianceAlert(alertId, status)
  revalidateBudgetPages(projectId)
  return updated
}

export async function runVarianceScanAction(projectId: string) {
  const { orgId } = await requireOrgContext()
  await checkVarianceAlerts(projectId, orgId)
  revalidateBudgetPages(projectId)
}

const progressInputSchema = z.object({
  percent_complete: z.number().min(0).max(100).nullable().optional(),
  estimate_remaining_cents: z.number().min(0).nullable().optional(),
  notes: z.string().nullable().optional(),
})

export async function updateCostCodeProgressAction(projectId: string, costCodeId: string, input: unknown) {
  const { orgId } = await requireOrgContext()
  const parsed = progressInputSchema.parse(input)
  
  await updateCostCodeProgress({
    orgId,
    projectId,
    costCodeId,
    percentComplete: parsed.percent_complete ?? null,
    estimateRemainingCents: parsed.estimate_remaining_cents ?? null,
    notes: parsed.notes ?? null,
  })
  
  revalidateBudgetPages(projectId)
}
