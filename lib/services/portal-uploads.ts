import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { uploadFilesObject } from "@/lib/storage/files-storage"

const MAX_PORTAL_FILE_SIZE = 25 * 1024 * 1024

/**
 * Stores a file uploaded through a token-authenticated portal and registers it
 * in `files`. Caller is responsible for having validated portal access first.
 */
export async function uploadPortalFile({
  file,
  orgId,
  projectId,
  category,
  folderPath,
  metadata,
}: {
  file: File | null
  orgId: string
  projectId: string
  category: string
  folderPath: string
  metadata?: Record<string, unknown>
}): Promise<string | null> {
  if (!file || file.size === 0) return null
  if (file.size > MAX_PORTAL_FILE_SIZE) {
    throw new Error("Attachment must be 25MB or smaller")
  }

  const supabase = createServiceSupabaseClient()
  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = `${orgId}/${projectId}/${category}/${timestamp}_${safeName}`
  const bytes = Buffer.from(await file.arrayBuffer())

  await uploadFilesObject({
    supabase,
    orgId,
    path: storagePath,
    bytes,
    contentType: file.type || "application/octet-stream",
    upsert: false,
  })

  const { data, error } = await supabase
    .from("files")
    .insert({
      org_id: orgId,
      project_id: projectId,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      visibility: "private",
      category,
      folder_path: folderPath,
      metadata: { uploaded_via_portal: true, ...(metadata ?? {}) },
    })
    .select("id")
    .single()

  if (error || !data) {
    throw new Error(`Failed to save attachment: ${error?.message}`)
  }

  return data.id as string
}
