"use server"

import { getPortalView, sendPortalMessage } from "@/lib/services/portal"
import { portalChannelSchema, portalMessageInputSchema } from "@/lib/validation/conversations"

export async function loadPortalViewAction(projectId: string, channel: string) {
  const parsedChannel = portalChannelSchema.parse(channel)
  return getPortalView({ projectId, channel: parsedChannel })
}

export async function sendPortalMessageAction(input: unknown) {
  const parsed = portalMessageInputSchema.parse(input)
  const { message } = await sendPortalMessage({
    ...parsed,
    projectId: parsed.project_id,
  })
  return message
}
