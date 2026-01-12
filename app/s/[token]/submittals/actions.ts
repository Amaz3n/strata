"use server"

import { validatePortalToken } from "@/lib/services/portal-access"
import { listSubmittals } from "@/lib/services/submittals"

export async function loadSubmittalsAction(token: string) {
  const access = await validatePortalToken(token)
  if (!access) throw new Error("Access denied")
  return listSubmittals(access.org_id, access.project_id)
}









