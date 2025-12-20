"use server"

import { validatePortalToken } from "@/lib/services/portal-access"
import { listProjectSelections, listSelectionCategories, listSelectionOptions, selectProjectOption } from "@/lib/services/selections"

export async function loadSelectionsAction(token: string) {
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_submit_selections) {
    throw new Error("Access denied")
  }

  const [selections, categories] = await Promise.all([
    listProjectSelections(access.org_id, access.project_id),
    listSelectionCategories(access.org_id),
  ])

  const optionsByCategory = Object.fromEntries(
    await Promise.all(
      categories.map(async (cat) => {
        const options = await listSelectionOptions(access.org_id, cat.id)
        return [cat.id, options] as const
      }),
    ),
  )

  return { selections, categories, optionsByCategory }
}

export async function selectOptionAction(input: { token: string; selectionId: string; optionId: string }) {
  const access = await validatePortalToken(input.token)
  if (!access || !access.permissions.can_submit_selections) {
    throw new Error("Access denied")
  }

  await selectProjectOption({
    orgId: access.org_id,
    projectId: access.project_id,
    selectionId: input.selectionId,
    optionId: input.optionId,
    selectedByContactId: access.contact_id ?? null,
  })

  return { success: true }
}





