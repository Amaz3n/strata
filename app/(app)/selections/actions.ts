"use server"

import { revalidatePath } from "next/cache"

import { z } from "zod"

import {
  chooseSelectionAlternate,
  createProjectSelection,
  listHomeSelectionExceptions,
  listProjectSelections,
  listSelectionCategories,
  listSelectionOptions,
} from "@/lib/services/selections"
import { AuthorizationError } from "@/lib/services/authorization"
import { closeSelectionException } from "@/lib/services/selection-exceptions"
import { requireOrgContext } from "@/lib/services/context"
import { selectionExceptionAlternateSchema, selectionExceptionCloseSchema, selectionInputSchema } from "@/lib/validation/selections"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

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
  return run(async () => {
      const parsed = selectionInputSchema.parse(input)
      const selection = await createProjectSelection({ input: parsed })
      revalidatePath(`/projects/${parsed.project_id}/selections`)
      return selection
  })
}

/**
 * The home's selection exceptions with the alternates each can still take.
 * Read-only. A viewer without selections.read on the home (a superintendent on
 * the workbench) has no band rather than an error.
 */
export async function loadHomeSelectionExceptionsAction(projectId: unknown) {
  return run(async () => {
    try {
      return await listHomeSelectionExceptions(z.string().uuid().parse(projectId))
    } catch (error) {
      if (error instanceof AuthorizationError) return { exceptions: [], truncated: false }
      throw error
    }
  })
}

export async function chooseSelectionAlternateAction(input: unknown) {
  return run(async () => {
    const result = await chooseSelectionAlternate(selectionExceptionAlternateSchema.parse(input))
    revalidatePath(`/projects/${result.projectId}/selections`)
    return result
  })
}

export async function closeSelectionExceptionAction(input: unknown) {
  return run(async () => {
    const result = await closeSelectionException(selectionExceptionCloseSchema.parse(input))
    revalidatePath(`/projects/${result.projectId}/selections`)
    return result
  })
}
