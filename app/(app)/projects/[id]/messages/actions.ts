"use server"

import { revalidatePath } from "next/cache"
import {
  postConversationMessage,
  postMessageWithAttachments,
  getOrCreateCompanyConversation,
  listConversationMessagesWithClient,
  getMessageAttachments,
  markConversationRead,
} from "@/lib/services/conversations"
import { requireOrgContext } from "@/lib/services/context"
import { createFileRecord } from "@/lib/services/files"
import { attachFile } from "@/lib/services/file-links"
import type { MessageAttachment } from "@/lib/services/conversations"

export async function sendProjectMessageAction(
  projectId: string,
  conversationId: string,
  body: string,
  fileIds?: string[]
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

  if (fileIds?.length) {
    return postMessageWithAttachments({
      conversationId,
      body,
      fileIds,
      projectId,
    })
  }

  return postConversationMessage({
    conversationId,
    body,
  })
}

export async function createSubConversationAction(projectId: string, companyId: string) {
  const { orgId } = await requireOrgContext()

  return getOrCreateCompanyConversation({
    projectId,
    companyId,
    orgId,
  })
}

export async function loadSubConversationMessagesAction(projectId: string, conversationId: string) {
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

  // Mark the conversation as read
  await markConversationRead({ conversationId, orgId })

  return listConversationMessagesWithClient(supabase, orgId, conversationId)
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

/**
 * Upload a file for attachment to a message
 */
export async function uploadMessageFileAction(formData: FormData): Promise<{ id: string; fileName: string; mimeType: string; sizeBytes: number; url?: string }> {
  const { supabase, orgId } = await requireOrgContext()

  const file = formData.get("file") as File
  const projectId = formData.get("projectId") as string

  if (!file) {
    throw new Error("No file provided")
  }

  // Generate unique storage path
  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = `${orgId}/${projectId}/messages/${timestamp}_${safeName}`

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from("project-files")
    .upload(storagePath, file, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload file: ${uploadError.message}`)
  }

  // Infer category from mime type
  let category = "other"
  if (file.type.startsWith("image/")) category = "photos"
  else if (file.type === "application/pdf") category = "other"

  // Create file record
  const record = await createFileRecord({
    project_id: projectId,
    file_name: file.name,
    storage_path: storagePath,
    mime_type: file.type,
    size_bytes: file.size,
    visibility: "private",
    category: category as any,
    source: "message",
  })

  // Generate signed URL
  let downloadUrl: string | undefined
  try {
    const { data: urlData } = await supabase.storage
      .from("project-files")
      .createSignedUrl(storagePath, 3600)
    downloadUrl = urlData?.signedUrl
  } catch (e) {
    console.error("Failed to generate URL")
  }

  return {
    id: record.id,
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    url: downloadUrl,
  }
}

/**
 * Get attachments for a message
 */
export async function getMessageAttachmentsAction(
  projectId: string,
  messageId: string
): Promise<MessageAttachment[]> {
  const { supabase, orgId } = await requireOrgContext()

  // Verify the message belongs to a conversation in this project
  const { data: message } = await supabase
    .from("messages")
    .select("conversation_id, conversations!inner(project_id)")
    .eq("id", messageId)
    .eq("org_id", orgId)
    .single()

  if (!message || (message.conversations as any)?.project_id !== projectId) {
    throw new Error("Message not found or access denied")
  }

  return getMessageAttachments({ messageId, orgId })
}

/**
 * Save a message attachment to project files
 */
export async function saveAttachmentToProjectFilesAction(
  projectId: string,
  fileId: string
): Promise<void> {
  const { supabase, orgId } = await requireOrgContext()

  // Verify the file exists and is accessible
  const { data: file } = await supabase
    .from("files")
    .select("id, project_id")
    .eq("id", fileId)
    .eq("org_id", orgId)
    .single()

  if (!file) {
    throw new Error("File not found or access denied")
  }

  // If the file is already linked to the project, just update share settings
  if (file.project_id === projectId) {
    await supabase
      .from("files")
      .update({ share_with_clients: false, share_with_subs: false })
      .eq("id", fileId)
  } else {
    // Link file to this project by creating a file_link
    await attachFile({
      file_id: fileId,
      entity_type: "project",
      entity_id: projectId,
      project_id: projectId,
      link_role: "saved_from_message",
    })
  }

  revalidatePath(`/projects/${projectId}/files`)
}

/**
 * Get a signed URL for a file
 */
export async function getFileSignedUrlAction(fileId: string): Promise<string> {
  const { supabase, orgId } = await requireOrgContext()

  const { data: file } = await supabase
    .from("files")
    .select("storage_path")
    .eq("id", fileId)
    .eq("org_id", orgId)
    .single()

  if (!file) {
    throw new Error("File not found")
  }

  const { data: urlData, error } = await supabase.storage
    .from("project-files")
    .createSignedUrl(file.storage_path, 3600)

  if (error || !urlData) {
    throw new Error("Failed to generate URL")
  }

  return urlData.signedUrl
}
