"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import { requirePermissionGuard } from "@/lib/auth/guards"
import {
  createChecklistTemplate,
  listChecklistTemplateItems,
  seedChecklistTemplates,
  setChecklistTemplateActive,
  updateChecklistTemplate,
} from "@/lib/services/inspections"
import { checklistTemplateInputSchema } from "@/lib/validation/inspections"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try { return { success: true, data: await fn() } } catch (error) { return actionError(error) }
}

export async function createChecklistTemplateAction(input: unknown) {
  return run(async () => {
    const template = await createChecklistTemplate(checklistTemplateInputSchema.parse(input))
    revalidatePath("/settings/checklists")
    return template
  })
}

export async function updateChecklistTemplateAction(templateId: string, input: unknown) {
  return run(async () => {
    const template = await updateChecklistTemplate(templateId, checklistTemplateInputSchema.parse(input))
    revalidatePath("/settings/checklists")
    return template
  })
}

export async function setChecklistTemplateActiveAction(templateId: string, isActive: boolean) {
  return run(async () => {
    await setChecklistTemplateActive(templateId, isActive)
    revalidatePath("/settings/checklists")
  })
}

export async function seedChecklistTemplatesAction() {
  return run(async () => {
    await requirePermissionGuard("org.admin")
    const seeded = await seedChecklistTemplates()
    revalidatePath("/settings/checklists")
    return seeded
  })
}

export async function listChecklistTemplateItemsAction(templateId: string) {
  return run(async () => listChecklistTemplateItems(templateId))
}
