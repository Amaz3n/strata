"use server"

import { revalidatePath } from "next/cache"

import {
  createEstimateTemplate,
  deleteEstimateTemplate,
  listEstimateTemplates,
  updateEstimateTemplate,
  type EstimateTemplateInput,
} from "@/lib/services/estimate-templates"

export async function listEstimateTemplatesAction() {
  return listEstimateTemplates()
}

export async function createEstimateTemplateAction(input: EstimateTemplateInput) {
  const template = await createEstimateTemplate(input)
  revalidatePath("/settings/templates")
  return template
}

export async function updateEstimateTemplateAction(id: string, input: EstimateTemplateInput) {
  const template = await updateEstimateTemplate(id, input)
  revalidatePath("/settings/templates")
  return template
}

export async function deleteEstimateTemplateAction(id: string) {
  await deleteEstimateTemplate(id)
  revalidatePath("/settings/templates")
  return { success: true }
}
