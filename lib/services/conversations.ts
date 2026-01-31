import type { SupabaseClient } from "@supabase/supabase-js"

import type { Conversation, ConversationChannel, PortalMessage } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"
import { buildFilesPublicUrl, ensureOrgScopedPath } from "@/lib/storage/files-storage"

export interface ConversationWithCompany extends Conversation {
  audience_company_id?: string | null
  audience_company_name?: string | null
  last_message_at?: string | null
  unread_count?: number
}

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

function mapConversationWithCompany(row: any): ConversationWithCompany {
  return {
    ...mapConversation(row),
    audience_company_id: row.audience_company_id ?? null,
    audience_company_name: row.audience_company?.name ?? row.companies?.name ?? null,
    last_message_at: row.last_message_at ?? null,
    unread_count: row.unread_count ?? 0,
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

/**
 * List all subcontractor conversations for a project, grouped by company
 */
export async function listProjectSubConversations(params: {
  projectId: string
  orgId?: string
}): Promise<ConversationWithCompany[]> {
  const { supabase, orgId } = await requireOrgContext(params.orgId)

  const { data, error } = await supabase
    .from("conversations")
    .select(`
      id, org_id, project_id, subject, channel, created_by, created_at,
      audience_company_id, last_message_at,
      companies:audience_company_id(id, name)
    `)
    .eq("org_id", orgId)
    .eq("project_id", params.projectId)
    .eq("channel", "sub")
    .not("audience_company_id", "is", null)
    .order("last_message_at", { ascending: false, nullsFirst: false })

  if (error) {
    throw new Error(`Failed to load subcontractor conversations: ${error.message}`)
  }

  return (data ?? []).map(mapConversationWithCompany)
}

/**
 * Get or create a conversation for a specific subcontractor company
 */
export async function getOrCreateCompanyConversation(params: {
  projectId: string
  companyId: string
  orgId?: string
}): Promise<ConversationWithCompany> {
  const { supabase, orgId, userId } = await requireOrgContext(params.orgId)

  // Try to find existing conversation
  const { data: existing, error: findError } = await supabase
    .from("conversations")
    .select(`
      id, org_id, project_id, subject, channel, created_by, created_at,
      audience_company_id, last_message_at,
      companies:audience_company_id(id, name)
    `)
    .eq("org_id", orgId)
    .eq("project_id", params.projectId)
    .eq("channel", "sub")
    .eq("audience_company_id", params.companyId)
    .maybeSingle()

  if (findError) {
    throw new Error(`Failed to find conversation: ${findError.message}`)
  }

  if (existing) {
    return mapConversationWithCompany(existing)
  }

  // Get company name for subject
  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", params.companyId)
    .single()

  // Create new conversation
  const { data: created, error: createError } = await supabase
    .from("conversations")
    .insert({
      org_id: orgId,
      project_id: params.projectId,
      channel: "sub",
      audience_company_id: params.companyId,
      subject: company?.name ?? "Subcontractor",
      created_by: userId,
    })
    .select(`
      id, org_id, project_id, subject, channel, created_by, created_at,
      audience_company_id, last_message_at,
      companies:audience_company_id(id, name)
    `)
    .single()

  if (createError || !created) {
    throw new Error(`Failed to create conversation: ${createError?.message}`)
  }

  return mapConversationWithCompany(created)
}

/**
 * List companies assigned to a project (from project_vendors table)
 */
export async function listProjectSubcontractorCompanies(params: {
  projectId: string
  orgId?: string
}): Promise<{ id: string; name: string; trade?: string }[]> {
  const { supabase, orgId } = await requireOrgContext(params.orgId)

  const { data, error } = await supabase
    .from("project_vendors")
    .select(`
      company_id,
      companies:company_id(id, name, metadata)
    `)
    .eq("org_id", orgId)
    .eq("project_id", params.projectId)

  if (error) {
    throw new Error(`Failed to load project vendors: ${error.message}`)
  }

  return (data ?? [])
    .filter((row: any) => row.companies)
    .map((row: any) => ({
      id: row.companies.id,
      name: row.companies.name,
      trade: row.companies.metadata?.trade ?? undefined,
    }))
}

/**
 * Get or create a client conversation for a project (optionally company-scoped)
 */
export async function getOrCreateClientConversation(params: {
  projectId: string
  companyId?: string | null
  orgId?: string
}): Promise<ConversationWithCompany> {
  const { supabase, orgId, userId } = await requireOrgContext(params.orgId)

  // Build query
  let query = supabase
    .from("conversations")
    .select(`
      id, org_id, project_id, subject, channel, created_by, created_at,
      audience_company_id, last_message_at,
      companies:audience_company_id(id, name)
    `)
    .eq("org_id", orgId)
    .eq("project_id", params.projectId)
    .eq("channel", "client")

  if (params.companyId) {
    query = query.eq("audience_company_id", params.companyId)
  } else {
    query = query.is("audience_company_id", null)
  }

  const { data: existing, error: findError } = await query.maybeSingle()

  if (findError) {
    throw new Error(`Failed to find client conversation: ${findError.message}`)
  }

  if (existing) {
    return mapConversationWithCompany(existing)
  }

  // Create new conversation
  const { data: created, error: createError } = await supabase
    .from("conversations")
    .insert({
      org_id: orgId,
      project_id: params.projectId,
      channel: "client",
      audience_company_id: params.companyId ?? null,
      subject: "Client Updates",
      created_by: userId,
    })
    .select(`
      id, org_id, project_id, subject, channel, created_by, created_at,
      audience_company_id, last_message_at,
      companies:audience_company_id(id, name)
    `)
    .single()

  if (createError || !created) {
    throw new Error(`Failed to create client conversation: ${createError?.message}`)
  }

  return mapConversationWithCompany(created)
}

// ============================================
// Message Attachments
// ============================================

export interface MessageAttachment {
  id: string
  file_id: string
  file_name: string
  mime_type?: string
  size_bytes?: number
  storage_path?: string
  download_url?: string
  thumbnail_url?: string
}

/**
 * Get attachments for a message
 */
export async function getMessageAttachments(params: {
  messageId: string
  orgId?: string
}): Promise<MessageAttachment[]> {
  const { supabase, orgId } = await requireOrgContext(params.orgId)

  const { data, error } = await supabase
    .from("file_links")
    .select(`
      id, file_id,
      files:file_id(id, file_name, mime_type, size_bytes, storage_path)
    `)
    .eq("org_id", orgId)
    .eq("entity_type", "message")
    .eq("entity_id", params.messageId)

  if (error) {
    throw new Error(`Failed to get message attachments: ${error.message}`)
  }

  return (data ?? []).map((row: any) => {
    const storagePath = row.files?.storage_path ?? undefined
    let publicUrl: string | undefined
    if (storagePath) {
      try {
        publicUrl = buildFilesPublicUrl(ensureOrgScopedPath(orgId, storagePath)) ?? undefined
      } catch (error) {
        console.error("Failed to generate attachment URL")
      }
    }
    const isImage = row.files?.mime_type?.startsWith("image/")

    return {
      id: row.id,
      file_id: row.file_id,
      file_name: row.files?.file_name ?? "Unknown",
      mime_type: row.files?.mime_type ?? undefined,
      size_bytes: row.files?.size_bytes ?? undefined,
      storage_path: storagePath,
      download_url: publicUrl,
      thumbnail_url: isImage ? publicUrl : undefined,
    }
  })
}

/**
 * Attach a file to a message
 */
export async function attachFileToMessage(params: {
  messageId: string
  fileId: string
  projectId?: string
  orgId?: string
}): Promise<void> {
  const { supabase, orgId } = await requireOrgContext(params.orgId)

  const { error } = await supabase.from("file_links").insert({
    org_id: orgId,
    project_id: params.projectId ?? null,
    file_id: params.fileId,
    entity_type: "message",
    entity_id: params.messageId,
    link_role: "attachment",
  })

  if (error) {
    throw new Error(`Failed to attach file to message: ${error.message}`)
  }
}

/**
 * Post a message with attachments
 */
export async function postMessageWithAttachments(params: {
  conversationId: string
  body: string
  fileIds?: string[]
  projectId?: string
  orgId?: string
}): Promise<PortalMessage> {
  const { supabase, orgId, userId } = await requireOrgContext(params.orgId)

  // Insert message
  const { data: message, error: messageError } = await supabase
    .from("messages")
    .insert({
      org_id: orgId,
      conversation_id: params.conversationId,
      sender_id: userId,
      message_type: "text",
      body: params.body,
      payload: params.fileIds?.length ? { has_attachments: true } : {},
    })
    .select(
      "id, org_id, conversation_id, sender_id, message_type, body, payload, sent_at, app_users:sender_id(full_name, avatar_url)"
    )
    .single()

  if (messageError || !message) {
    throw new Error(`Failed to send message: ${messageError?.message}`)
  }

  // Attach files if any
  if (params.fileIds?.length) {
    const fileLinks = params.fileIds.map((fileId) => ({
      org_id: orgId,
      project_id: params.projectId ?? null,
      file_id: fileId,
      entity_type: "message",
      entity_id: message.id,
      link_role: "attachment",
    }))

    const { error: linkError } = await supabase.from("file_links").insert(fileLinks)

    if (linkError) {
      console.error("Failed to attach files to message:", linkError)
    }
  }

  return mapMessage(message)
}

// ============================================
// Read State Functions
// ============================================

export interface ConversationReadState {
  id: string
  org_id: string
  conversation_id: string
  user_id?: string | null
  contact_id?: string | null
  last_read_at: string
  last_read_message_id?: string | null
}

/**
 * Mark a conversation as read for the current user
 */
export async function markConversationRead(params: {
  conversationId: string
  lastReadMessageId?: string
  orgId?: string
}): Promise<void> {
  const { supabase, orgId, userId } = await requireOrgContext(params.orgId)

  const { error } = await supabase
    .from("conversation_read_states")
    .upsert(
      {
        org_id: orgId,
        conversation_id: params.conversationId,
        user_id: userId,
        last_read_at: new Date().toISOString(),
        last_read_message_id: params.lastReadMessageId ?? null,
      },
      {
        onConflict: "conversation_id,user_id",
        ignoreDuplicates: false,
      }
    )

  if (error) {
    throw new Error(`Failed to mark conversation as read: ${error.message}`)
  }
}

/**
 * Get read state for a conversation for the current user
 */
export async function getConversationReadState(params: {
  conversationId: string
  orgId?: string
}): Promise<ConversationReadState | null> {
  const { supabase, orgId, userId } = await requireOrgContext(params.orgId)

  const { data, error } = await supabase
    .from("conversation_read_states")
    .select("*")
    .eq("org_id", orgId)
    .eq("conversation_id", params.conversationId)
    .eq("user_id", userId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to get read state: ${error.message}`)
  }

  return data
}

/**
 * Get unread message count for a conversation for the current user
 */
export async function getUnreadMessageCount(params: {
  conversationId: string
  orgId?: string
}): Promise<number> {
  const { supabase, orgId, userId } = await requireOrgContext(params.orgId)

  // First get the read state
  const { data: readState } = await supabase
    .from("conversation_read_states")
    .select("last_read_at")
    .eq("org_id", orgId)
    .eq("conversation_id", params.conversationId)
    .eq("user_id", userId)
    .maybeSingle()

  // Count messages after last_read_at (or all if no read state)
  let query = supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("conversation_id", params.conversationId)
    .neq("sender_id", userId) // Don't count own messages as unread

  if (readState?.last_read_at) {
    query = query.gt("sent_at", readState.last_read_at)
  }

  const { count, error } = await query

  if (error) {
    throw new Error(`Failed to get unread count: ${error.message}`)
  }

  return count ?? 0
}

/**
 * List all conversations for a project (both client and sub) for unified inbox
 */
export async function listProjectConversations(params: {
  projectId: string
  orgId?: string
}): Promise<(ConversationWithCompany & { last_message_body?: string | null; last_message_sender_name?: string | null })[]> {
  const { supabase, orgId } = await requireOrgContext(params.orgId)

  const { data, error } = await supabase
    .from("conversations")
    .select(`
      id, org_id, project_id, subject, channel, created_by, created_at,
      audience_company_id, last_message_at,
      companies:audience_company_id(id, name)
    `)
    .eq("org_id", orgId)
    .eq("project_id", params.projectId)
    .in("channel", ["client", "sub"])
    .order("last_message_at", { ascending: false, nullsFirst: false })

  if (error) {
    throw new Error(`Failed to load conversations: ${error.message}`)
  }

  // Get last message for each conversation for preview
  const conversationIds = (data ?? []).map((c) => c.id)

  if (conversationIds.length === 0) {
    return []
  }

  // Get the latest message for each conversation
  const { data: lastMessages } = await supabase
    .from("messages")
    .select(`
      conversation_id, body, sender_id,
      app_users:sender_id(full_name),
      payload
    `)
    .eq("org_id", orgId)
    .in("conversation_id", conversationIds)
    .order("sent_at", { ascending: false })

  // Group messages by conversation and get the first (latest) one
  const lastMessageMap = new Map<string, { body?: string; sender_name?: string }>()
  for (const msg of lastMessages ?? []) {
    if (!lastMessageMap.has(msg.conversation_id)) {
      const senderName = (msg.app_users as any)?.full_name ?? msg.payload?.sender_name ?? null
      lastMessageMap.set(msg.conversation_id, {
        body: msg.body ?? undefined,
        sender_name: senderName,
      })
    }
  }

  return (data ?? []).map((row) => ({
    ...mapConversationWithCompany(row),
    last_message_body: lastMessageMap.get(row.id)?.body ?? null,
    last_message_sender_name: lastMessageMap.get(row.id)?.sender_name ?? null,
  }))
}

/**
 * Get unread counts for multiple conversations at once
 */
export async function getUnreadCountsForProject(params: {
  projectId: string
  orgId?: string
}): Promise<Map<string, number>> {
  const { supabase, orgId, userId } = await requireOrgContext(params.orgId)

  // Get all conversations for this project
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", params.projectId)

  if (!conversations?.length) {
    return new Map()
  }

  const conversationIds = conversations.map((c) => c.id)

  // Get read states for all conversations
  const { data: readStates } = await supabase
    .from("conversation_read_states")
    .select("conversation_id, last_read_at")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .in("conversation_id", conversationIds)

  const readStateMap = new Map(
    (readStates ?? []).map((rs) => [rs.conversation_id, rs.last_read_at])
  )

  // Get message counts per conversation
  const unreadCounts = new Map<string, number>()

  // For efficiency, we'll do this with a single query that groups by conversation
  const { data: messageCounts } = await supabase
    .from("messages")
    .select("conversation_id, sent_at")
    .eq("org_id", orgId)
    .in("conversation_id", conversationIds)
    .neq("sender_id", userId)

  // Count messages after read state for each conversation
  for (const conversationId of conversationIds) {
    const lastReadAt = readStateMap.get(conversationId)
    const messages = (messageCounts ?? []).filter((m) => {
      if (m.conversation_id !== conversationId) return false
      if (!lastReadAt) return true
      return new Date(m.sent_at) > new Date(lastReadAt)
    })
    unreadCounts.set(conversationId, messages.length)
  }

  return unreadCounts
}
