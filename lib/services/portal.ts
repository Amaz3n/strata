import type { ConversationChannel, PortalView } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"
import { listProjectsWithClient } from "@/lib/services/projects"
import { listScheduleItemsWithClient } from "@/lib/services/schedule"
import { listDailyLogs } from "@/lib/services/daily-logs"
import { listFiles } from "@/lib/services/files"
import {
  getOrCreateProjectConversationWithClient,
  listConversationMessagesWithClient,
  postConversationMessageWithClient,
} from "@/lib/services/conversations"
import { recordEvent } from "@/lib/services/events"

export async function getPortalView({
  projectId,
  channel,
  orgId,
}: {
  projectId: string
  channel: ConversationChannel
  orgId?: string
}): Promise<PortalView> {
  const context = await requireOrgContext(orgId)

  const projects = await listProjectsWithClient(context.supabase, context.orgId)
  const project = projects.find((p) => p.id === projectId)

  if (!project) {
    throw new Error("Project not found")
  }

  const conversation = await getOrCreateProjectConversationWithClient({
    supabase: context.supabase,
    orgId: context.orgId,
    projectId,
    channel,
    createdBy: context.userId,
  })

  const [messages, scheduleItems, dailyLogs, files] = await Promise.all([
    listConversationMessagesWithClient(context.supabase, context.orgId, conversation.id),
    listScheduleItemsWithClient(context.supabase, context.orgId),
    listDailyLogs(context.orgId),
    listFiles({ project_id: projectId }, context.orgId),
  ])

  return {
    project,
    channel,
    conversation,
    messages,
    schedule: scheduleItems.filter((item) => item.project_id === projectId).slice(0, 5),
    recentLogs: dailyLogs.filter((log) => log.project_id === projectId).slice(0, 3),
    sharedFiles: files.filter((file) => file.project_id === projectId).slice(0, 5),
  }
}

export async function sendPortalMessage({
  projectId,
  channel,
  body,
  orgId,
}: {
  projectId: string
  channel: ConversationChannel
  body: string
  orgId?: string
}) {
  const context = await requireOrgContext(orgId)

  const conversation = await getOrCreateProjectConversationWithClient({
    supabase: context.supabase,
    orgId: context.orgId,
    projectId,
    channel,
    createdBy: context.userId,
  })

  const message = await postConversationMessageWithClient({
    supabase: context.supabase,
    orgId: context.orgId,
    conversationId: conversation.id,
    body,
    senderId: context.userId,
  })

  await recordEvent({
    orgId: context.orgId,
    eventType: "portal_message",
    entityType: "conversation",
    entityId: conversation.id,
    payload: { project_id: projectId, channel, preview: body.slice(0, 120) },
    channel: "notification",
  })

  return { conversation, message }
}
