import type { SupabaseClient } from "@supabase/supabase-js"

import type { Conversation, ConversationChannel, PortalMessage } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"

function mapConversation(row: any): Conversation {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    subject: row.subject ?? null,
    channel: row.channel,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
  }
}

function mapMessage(row: any): PortalMessage {
  const sender = (row as { app_users?: { full_name?: string; avatar_url?: string } }).app_users ?? {}

  return {
    id: row.id,
    org_id: row.org_id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id ?? undefined,
    message_type: row.message_type ?? "text",
    body: row.body ?? null,
    payload: row.payload ?? undefined,
    sent_at: row.sent_at,
    sender_name: sender.full_name ?? undefined,
    sender_avatar_url: sender.avatar_url ?? undefined,
  }
}

export async function getOrCreateProjectConversation(params: {
  projectId: string
  channel: ConversationChannel
  orgId?: string
}) {
  const { supabase, orgId, userId } = await requireOrgContext(params.orgId)
  return getOrCreateProjectConversationWithClient({
    supabase,
    orgId,
    projectId: params.projectId,
    channel: params.channel,
    createdBy: userId,
  })
}

export async function getOrCreateProjectConversationWithClient(params: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  channel: ConversationChannel
  createdBy?: string
}) {
  const { data, error } = await params.supabase
    .from("conversations")
    .select("id, org_id, project_id, subject, channel, created_by, created_at")
    .eq("org_id", params.orgId)
    .eq("project_id", params.projectId)
    .eq("channel", params.channel)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load conversation: ${error.message}`)
  }

  if (data) return mapConversation(data)

  const { data: inserted, error: insertError } = await params.supabase
    .from("conversations")
    .insert({
      org_id: params.orgId,
      project_id: params.projectId,
      channel: params.channel,
      subject: params.channel === "client" ? "Client Updates" : "Subcontractor Updates",
      created_by: params.createdBy,
    })
    .select("id, org_id, project_id, subject, channel, created_by, created_at")
    .single()

  if (insertError || !inserted) {
    throw new Error(`Failed to create conversation: ${insertError?.message}`)
  }

  return mapConversation(inserted)
}

export async function listConversationMessagesWithClient(
  supabase: SupabaseClient,
  orgId: string,
  conversationId: string,
): Promise<PortalMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select(
      "id, org_id, conversation_id, sender_id, message_type, body, payload, sent_at, app_users:sender_id(full_name, avatar_url)",
    )
    .eq("org_id", orgId)
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: true })

  if (error) {
    throw new Error(`Failed to load messages: ${error.message}`)
  }

  return (data ?? []).map(mapMessage)
}

export async function listConversationMessages(conversationId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  return listConversationMessagesWithClient(supabase, resolvedOrgId, conversationId)
}

export async function postConversationMessage(params: { conversationId: string; body: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  return postConversationMessageWithClient({
    supabase,
    orgId: resolvedOrgId,
    conversationId: params.conversationId,
    body: params.body,
    senderId: userId,
  })
}

export async function postConversationMessageWithClient(params: {
  supabase: SupabaseClient
  orgId: string
  conversationId: string
  body: string
  senderId: string
}) {
  const { data, error } = await params.supabase
    .from("messages")
    .insert({
      org_id: params.orgId,
      conversation_id: params.conversationId,
      sender_id: params.senderId,
      message_type: "text",
      body: params.body,
    })
    .select(
      "id, org_id, conversation_id, sender_id, message_type, body, payload, sent_at, app_users:sender_id(full_name, avatar_url)",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to send message: ${error?.message}`)
  }

  return mapMessage(data)
}
