import { createClient } from "@/lib/supabase/client"

type UploadUrlResponse = {
  storagePath: string
  uploadUrl: string
  provider: "supabase" | "r2"
}

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

  const response = await fetch("/api/drawings/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      fileName: file.name,
      contentType: file.type,
    }),
  })

  if (!response.ok) {
    throw new Error("Failed to prepare upload.")
  }

  const payload = (await response.json()) as UploadUrlResponse
  const storagePath = payload?.storagePath

  if (!storagePath || !payload?.provider) {
    throw new Error("Invalid upload response.")
  }

  if (payload.provider === "r2") {
    const uploadResponse = await fetch(payload.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type,
      },
      body: file,
    })

    if (!uploadResponse.ok) {
      throw new Error("Failed to upload file to storage.")
    }

    return { storagePath }
  }

  const { error: uploadError } = await supabase.storage
    .from("project-files")
    .upload(storagePath, file, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload file: ${uploadError.message}`)
  }

  const { data: { publicUrl } } = supabase.storage
    .from("project-files")
    .getPublicUrl(storagePath)

  return { storagePath, publicUrl }
}
