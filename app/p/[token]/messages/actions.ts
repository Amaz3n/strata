"use server"

import {
  validatePortalToken,
  listPortalMessages,
  postPortalMessage,
  listPortalEntityMessages,
  postPortalEntityMessage,
} from "@/lib/services/portal-access"

export async function loadPortalMessagesAction(token: string) {
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_message) throw new Error("Access denied")
  return listPortalMessages({
    orgId: access.org_id,
    projectId: access.project_id,
    channel: access.portal_type,
    audienceCompanyId: access.company_id,
  })
}

export async function sendPortalMessageAction(input: { token: string; body: string; senderName?: string }) {
  const access = await validatePortalToken(input.token)
  if (!access || !access.permissions.can_message) throw new Error("Access denied")
  const message = await postPortalMessage({
    orgId: access.org_id,
    projectId: access.project_id,
    channel: access.portal_type,
    body: input.body,
    senderName: input.senderName,
    portalTokenId: access.id,
    audienceCompanyId: access.company_id,
  })
  return message
}

export async function loadPortalEntityMessagesAction(input: { token: string; entityType: "rfi" | "submittal"; entityId: string }) {
  const access = await validatePortalToken(input.token)
  if (!access || !access.permissions.can_message) throw new Error("Access denied")
  if (input.entityType === "rfi" && !access.permissions.can_view_rfis) throw new Error("Access denied")
  if (input.entityType === "submittal" && !access.permissions.can_view_submittals) throw new Error("Access denied")
  return listPortalEntityMessages({
    orgId: access.org_id,
    projectId: access.project_id,
    channel: access.portal_type,
    entityType: input.entityType,
    entityId: input.entityId,
    audienceCompanyId: access.company_id,
  })
}

export async function sendPortalEntityMessageAction(input: {
  token: string
  entityType: "rfi" | "submittal"
  entityId: string
  body: string
  senderName?: string
}) {
  const access = await validatePortalToken(input.token)
  if (!access || !access.permissions.can_message) throw new Error("Access denied")

  // Basic permission gate by entity type
  if (input.entityType === "rfi" && !access.permissions.can_view_rfis) throw new Error("Access denied")
  if (input.entityType === "rfi" && !access.permissions.can_respond_rfis) throw new Error("Access denied")
  if (input.entityType === "submittal" && !access.permissions.can_view_submittals) throw new Error("Access denied")

  return postPortalEntityMessage({
    orgId: access.org_id,
    projectId: access.project_id,
    channel: access.portal_type,
    body: input.body,
    senderName: input.senderName,
    portalTokenId: access.id,
    entityType: input.entityType,
    entityId: input.entityId,
    audienceCompanyId: access.company_id,
  })
}
