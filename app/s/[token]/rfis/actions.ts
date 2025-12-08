"use server"

import { validatePortalToken } from "@/lib/services/portal-access"
import { listRfis } from "@/lib/services/rfis"

export async function loadRfisAction(token: string) {
  const access = await validatePortalToken(token)
  if (!access) throw new Error("Access denied")
  return listRfis(access.org_id, access.project_id)
}



