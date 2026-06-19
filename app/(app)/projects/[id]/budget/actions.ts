"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createBudget, duplicateBudgetVersion, lockBudgetBaseline, replaceBudgetLines, updateBudgetStatus, acknowledgeVarianceAlert, checkVarianceAlerts, updateCostCodeProgress } from "@/lib/services/budgets"
import {
  buildBudgetDraftFromEstimate,
  listBudgetEstimateSources,
} from "@/lib/services/budget-from-estimate"
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

export async function lockBudgetBaselineAction(projectId: string) {
  const result = await lockBudgetBaseline(projectId)
  revalidateBudgetPages(projectId)
  return result
}

export async function listBudgetEstimateSourcesAction(projectId: string) {
  return listBudgetEstimateSources(projectId)
}

export async function proposeBudgetFromEstimateAction(
  projectId: string,
  estimateId: string,
  costCodesEnabled: boolean,
) {
  return buildBudgetDraftFromEstimate({ projectId, estimateId, costCodesEnabled })
}

const applyBudgetSchema = z.object({
  project_id: z.string().uuid(),
  lines: z.array(budgetLineInputSchema).min(1),
})

/**
 * Creates a project budget from reviewed lines, or replaces the latest budget's
 * lines if one already exists. Used by "Start from estimate".
 */
export async function applyBudgetFromEstimateAction(input: unknown) {
  const parsed = applyBudgetSchema.parse(input)
  const { supabase, orgId } = await requireOrgContext()

  const lines = parsed.lines.map((line) => ({
    ...line,
    cost_code_id: line.cost_code_id ?? undefined,
  }))

  const { data: latest } = await supabase
    .from("budgets")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", parsed.project_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latest?.id) {
    await replaceBudgetLines({ budgetId: latest.id as string, lines })
  } else {
    await createBudget({ project_id: parsed.project_id, status: "draft", lines }, orgId)
  }

  revalidateBudgetPages(parsed.project_id)
  return { success: true }
}

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
