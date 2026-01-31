"use server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { validatePortalToken } from "@/lib/services/portal-access"
import { createPunchItemFromPortal, listPunchItems } from "@/lib/services/punch-lists"
import { buildFilesPublicUrl, deleteFilesObjects, uploadFilesObject } from "@/lib/storage/files-storage"

export async function loadPunchItemsAction(token: string) {
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_create_punch_items) {
    throw new Error("Access denied")
  }
  return listPunchItems(access.org_id, access.project_id)
}

export async function createPunchItemAction(input: {
  token: string
  title: string
  description?: string
  location?: string
  severity?: string
}) {
  const access = await validatePortalToken(input.token)
  if (!access || !access.permissions.can_create_punch_items) {
    throw new Error("Access denied")
  }

  const item = await createPunchItemFromPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    title: input.title,
    description: input.description,
    location: input.location,
    severity: input.severity,
    portalTokenId: access.id,
  })

  return item
}

export interface PunchItemAttachment {
  id: string
  linkId: string
  file_name: string
  mime_type?: string
  size_bytes?: number
  download_url?: string
  thumbnail_url?: string
  created_at: string
  link_role?: string
}

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB
const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/heic",
]

export async function uploadPunchItemAttachmentAction({
  token,
  punchItemId,
  formData,
}: {
  token: string
  punchItemId: string
  formData: FormData
}) {
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_create_punch_items) {
    throw new Error("Access denied")
  }

  const file = formData.get("file") as File
  if (!file) {
    throw new Error("No file provided")
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("File size exceeds 25MB limit")
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error("Invalid file type. Please upload a PDF or image.")
  }

  const supabase = createServiceSupabaseClient()

  // Verify punch item belongs to this portal project
  const { data: item, error: itemError } = await supabase
    .from("punch_items")
    .select("id, org_id, project_id")
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .eq("id", punchItemId)
    .maybeSingle()

  if (itemError || !item) {
    throw new Error("Punch item not found")
  }

  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = `${access.org_id}/${access.project_id}/punch/${timestamp}_${safeName}`

  const bytes = Buffer.from(await file.arrayBuffer())
  await uploadFilesObject({
    supabase,
    orgId: access.org_id,
    path: storagePath,
    bytes,
    contentType: file.type,
    upsert: false,
  })

  const { data: fileRecord, error: dbError } = await supabase
    .from("files")
    .insert({
      org_id: access.org_id,
      project_id: access.project_id,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: file.type,
      size_bytes: file.size,
      visibility: "private",
      category: "photos",
      share_with_clients: true,
      metadata: {
        uploaded_via_portal: true,
        portal_token_id: access.id,
        file_type: "punch_photo",
        punch_item_id: punchItemId,
      },
    })
    .select("id, file_name, storage_path, mime_type, size_bytes, created_at")
    .single()

  if (dbError || !fileRecord) {
    await deleteFilesObjects({
      supabase,
      orgId: access.org_id,
      paths: [storagePath],
    })
    throw new Error("Failed to save file record")
  }

  const { data: existing } = await supabase
    .from("file_links")
    .select("id")
    .eq("org_id", access.org_id)
    .eq("file_id", fileRecord.id)
    .eq("entity_type", "punch_item")
    .eq("entity_id", punchItemId)
    .maybeSingle()

  let linkId = existing?.id as string | undefined
  if (!linkId) {
    const { data: link, error: linkError } = await supabase
      .from("file_links")
      .insert({
        org_id: access.org_id,
        project_id: access.project_id,
        file_id: fileRecord.id,
        entity_type: "punch_item",
        entity_id: punchItemId,
        link_role: "photo",
      })
      .select("id, created_at, link_role")
      .single()

    if (linkError || !link) {
      throw new Error("Failed to link attachment")
    }
    linkId = link.id as string
  }

  const downloadUrl = buildFilesPublicUrl(storagePath) ?? undefined

  return {
    id: fileRecord.id as string,
    linkId,
    file_name: fileRecord.file_name as string,
    mime_type: (fileRecord.mime_type as string) ?? undefined,
    size_bytes: (fileRecord.size_bytes as number) ?? undefined,
    download_url: downloadUrl,
    thumbnail_url: file.type.startsWith("image/") ? downloadUrl : undefined,
    created_at: (fileRecord.created_at as string) ?? new Date().toISOString(),
    link_role: "photo",
  } satisfies PunchItemAttachment
}

export async function listPunchItemAttachmentsAction({
  token,
  punchItemId,
}: {
  token: string
  punchItemId: string
}): Promise<PunchItemAttachment[]> {
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_create_punch_items) {
    throw new Error("Access denied")
  }

  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("file_links")
    .select(
      `
      id, created_at, link_role,
      files!inner(id, file_name, storage_path, mime_type, size_bytes)
    `,
    )
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .eq("entity_type", "punch_item")
    .eq("entity_id", punchItemId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load attachments: ${error.message}`)

  const results: PunchItemAttachment[] = []
  for (const row of data ?? []) {
    const file = (row as any).files
    const storagePath = file?.storage_path as string | undefined
    let signedUrl: string | undefined
    if (storagePath) {
      signedUrl = buildFilesPublicUrl(storagePath) ?? undefined
    }

    results.push({
      id: file.id,
      linkId: (row as any).id,
      file_name: file.file_name,
      mime_type: file.mime_type ?? undefined,
      size_bytes: file.size_bytes ?? undefined,
      download_url: signedUrl,
      thumbnail_url: file.mime_type?.startsWith("image/") ? signedUrl : undefined,
      created_at: (row as any).created_at,
      link_role: (row as any).link_role ?? undefined,
    })
  }

  return results
}

export async function detachPunchItemAttachmentAction({
  token,
  linkId,
}: {
  token: string
  linkId: string
}): Promise<void> {
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_create_punch_items) {
    throw new Error("Access denied")
  }

  const supabase = createServiceSupabaseClient()
  const { error } = await supabase
    .from("file_links")
    .delete()
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .eq("id", linkId)

  if (error) {
    throw new Error(`Failed to remove attachment: ${error.message}`)
  }
}







