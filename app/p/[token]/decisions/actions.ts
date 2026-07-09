"use server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { decideDecisionFromPortal, listDecisionsForPortal } from "@/lib/services/decisions"
import { portalDecisionSchema } from "@/lib/validation/decisions"

export async function loadPortalDecisionsAction(token: string) {
  const access = await assertPortalActionAccess(token, {
    portalType: "client",
    permission: "can_submit_selections",
  })
  return listDecisionsForPortal(access.org_id, access.project_id, access.contact_id ?? null)
}

export async function decidePortalDecisionAction(token: string, input: unknown) {
  const access = await assertPortalActionAccess(token, {
    portalType: "client",
    permission: "can_submit_selections",
  })
  const parsed = portalDecisionSchema.parse(input)
  return decideDecisionFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    contactId: access.contact_id ?? null,
    portalTokenId: access.id,
    input: parsed,
  })
}
