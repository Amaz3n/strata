"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createBudget, duplicateBudgetVersion, replaceBudgetLines, updateBudgetStatus, acknowledgeVarianceAlert, checkVarianceAlerts } from "@/lib/services/budgets"
import { requireOrgContext } from "@/lib/services/context"

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
      lines: parsed.lines,
    },
    undefined,
  )
  revalidatePath(`/projects/${parsed.project_id}/budget`)
  revalidatePath(`/projects/${parsed.project_id}`)
  return result
}

export async function replaceProjectBudgetLinesAction(projectId: string, budgetId: string, linesInput: unknown) {
  const lines = z.array(budgetLineInputSchema).parse(linesInput)
  const updated = await replaceBudgetLines({ budgetId, lines })
  revalidatePath(`/projects/${projectId}/budget`)
  revalidatePath(`/projects/${projectId}`)
  return updated
}

export async function updateProjectBudgetStatusAction(projectId: string, budgetId: string, statusInput: unknown) {
  const status = z.enum(["draft", "approved", "locked"]).parse(statusInput)
  const updated = await updateBudgetStatus({ budgetId, status })
  revalidatePath(`/projects/${projectId}/budget`)
  revalidatePath(`/projects/${projectId}`)
  return updated
}

export async function duplicateProjectBudgetVersionAction(projectId: string, fromBudgetId: string) {
  const created = await duplicateBudgetVersion({ projectId, fromBudgetId })
  revalidatePath(`/projects/${projectId}/budget`)
  revalidatePath(`/projects/${projectId}`)
  return created
}

export async function acknowledgeVarianceAlertAction(projectId: string, alertId: string, statusInput?: unknown) {
  const status = statusInput ? z.enum(["acknowledged", "resolved"]).parse(statusInput) : "acknowledged"
  const updated = await acknowledgeVarianceAlert(alertId, status)
  revalidatePath(`/projects/${projectId}/budget`)
  revalidatePath(`/projects/${projectId}`)
  return updated
}

export async function runVarianceScanAction(projectId: string) {
  const { orgId } = await requireOrgContext()
  await checkVarianceAlerts(projectId, orgId)
  revalidatePath(`/projects/${projectId}/budget`)
  revalidatePath(`/projects/${projectId}`)
}
