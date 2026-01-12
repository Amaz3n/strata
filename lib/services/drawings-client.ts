import { createClient } from "@/lib/supabase/client"

/**
 * Client-side upload utilities for drawings
 * These functions are safe to import in client components
 */

/**
 * Upload a drawing file directly to Supabase Storage from the client
 * This bypasses Next.js Server Actions body size limits
 */
export async function uploadDrawingFileToStorage(
  file: File,
  projectId: string,
  orgId: string
): Promise<{ storagePath: string; publicUrl?: string }> {
  const supabase = createClient()

  // Generate unique storage path
  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = `${orgId}/${projectId}/drawings/sets/${timestamp}_${safeName}`

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

  // Get public URL if needed
  const { data: { publicUrl } } = supabase.storage
    .from("project-files")
    .getPublicUrl(storagePath)

  return { storagePath, publicUrl }
}

