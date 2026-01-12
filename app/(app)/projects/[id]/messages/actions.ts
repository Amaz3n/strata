"use server"

import { postConversationMessage } from "@/lib/services/conversations"
import { requireOrgContext } from "@/lib/services/context"

export async function sendProjectMessageAction(
  projectId: string,
  conversationId: string,
  body: string
) {
  const { supabase, orgId, userId } = await requireOrgContext()

  // Verify the conversation belongs to this project and org
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", conversationId)
    .single()

  if (!conversation) {
    throw new Error("Conversation not found or access denied")
  }

  return postConversationMessage({
    conversationId,
    body,
  })
}

export async function loadProjectMessagesAction(projectId: string, channel: "client" | "sub") {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("channel", channel)
    .single()

  if (error || !data) {
    return []
  }

  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select(`
      id,
      conversation_id,
      sender_id,
      message_type,
      body,
      payload,
      sent_at,
      app_users:sender_id(full_name, avatar_url)
    `)
    .eq("org_id", orgId)
    .eq("conversation_id", data.id)
    .order("sent_at", { ascending: true })

  if (messagesError) {
    throw new Error(`Failed to load messages: ${messagesError.message}`)
  }

  return (messages ?? []).map((row: any) => ({
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id ?? undefined,
    message_type: row.message_type,
    body: row.body,
    payload: row.payload ?? {},
    sent_at: row.sent_at,
    sender_name: (row.app_users as any)?.full_name ?? undefined,
    sender_avatar_url: (row.app_users as any)?.avatar_url ?? undefined,
  }))
}

