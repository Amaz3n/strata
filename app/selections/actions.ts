"use server"

import { revalidatePath } from "next/cache"

import {
  createProjectSelection,
  listProjectSelections,
  listSelectionCategories,
  listSelectionOptions,
} from "@/lib/services/selections"
import { requireOrgContext } from "@/lib/services/context"
import { selectionInputSchema } from "@/lib/validation/selections"

export async function loadSelectionsBuilderAction(projectId?: string) {
  const { orgId } = await requireOrgContext()
  const selections = await listProjectSelections(orgId, projectId)
  const categories = await listSelectionCategories(orgId)
  const optionsByCategory = Object.fromEntries(
    await Promise.all(
      categories.map(async (cat) => {
        const options = await listSelectionOptions(orgId, cat.id)
        return [cat.id, options] as const
      }),
    ),
  )

  return { selections, categories, optionsByCategory }
}

export async function createSelectionAction(input: unknown) {
  const parsed = selectionInputSchema.parse(input)
  const selection = await createProjectSelection({ input: parsed })
  revalidatePath("/selections")
  return selection
}




