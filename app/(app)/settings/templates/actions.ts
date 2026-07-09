"use server"

import { revalidatePath } from "next/cache"

import {
  createEstimateTemplate,
  deleteEstimateTemplate,
  listEstimateTemplates,
  updateEstimateTemplate,
  type EstimateTemplateInput,
} from "@/lib/services/estimate-templates"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function listEstimateTemplatesAction() {
      return listEstimateTemplates()
}

export async function createEstimateTemplateAction(input: EstimateTemplateInput) {
  return run(async () => {
      const template = await createEstimateTemplate(input)
      revalidatePath("/settings/templates")
      return template
  })
}

export async function updateEstimateTemplateAction(id: string, input: EstimateTemplateInput) {
  return run(async () => {
      const template = await updateEstimateTemplate(id, input)
      revalidatePath("/settings/templates")
      return template
  })
}

export async function deleteEstimateTemplateAction(id: string) {
  return run(async () => {
      await deleteEstimateTemplate(id)
      revalidatePath("/settings/templates")
      return { success: true }
  })
}
