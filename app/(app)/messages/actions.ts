"use server"

import {
  getOrCreateClientConversation,
  getOrCreateCompanyConversation,
  listProjectSubcontractorCompanies,
  markConversationRead,
  listConversationMessages,
  postConversationMessage,
} from "@/lib/services/conversations"

export async function loadConversationMessagesAction(conversationId: string) {
  await markConversationRead({ conversationId })
  return listConversationMessages(conversationId)
}

export async function sendConversationMessageAction(conversationId: string, body: string) {
  const trimmed = body.trim()
  if (!trimmed) {
    throw new Error("Message body is required")
  }

  const message = await postConversationMessage({
    conversationId,
    body: trimmed,
  })

  await markConversationRead({
    conversationId,
    lastReadMessageId: message.id,
  })

  return message
}

export async function listProjectSubRecipientsAction(projectId: string) {
  return listProjectSubcontractorCompanies({ projectId })
}

export async function startConversationAction(input: {
  projectId: string
  channel: "client" | "sub"
  companyId?: string
}) {
  const projectId = input.projectId.trim()
  if (!projectId) {
    throw new Error("Project is required")
  }

  if (input.channel === "client") {
    return getOrCreateClientConversation({ projectId })
  }

  const companyId = input.companyId?.trim()
  if (!companyId) {
    throw new Error("Subcontractor company is required")
  }

  return getOrCreateCompanyConversation({
    projectId,
    companyId,
  })
}
