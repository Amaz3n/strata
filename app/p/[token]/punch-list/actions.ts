"use server"

import { validatePortalToken } from "@/lib/services/portal-access"
import { createPunchItemFromPortal, listPunchItems } from "@/lib/services/punch-lists"

export async function loadPunchItemsAction(token: string) {
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_create_punch_items) {
    throw new Error("Access denied")
  }
  return listPunchItems(access.org_id, access.project_id)
}

export async function createPunchItemAction(input: {
  token: string
  title: string
  description?: string
  location?: string
  severity?: string
}) {
  const access = await validatePortalToken(input.token)
  if (!access || !access.permissions.can_create_punch_items) {
    throw new Error("Access denied")
  }

  const item = await createPunchItemFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    title: input.title,
    description: input.description,
    location: input.location,
    severity: input.severity,
    portalTokenId: access.id,
  })

  return item
}



