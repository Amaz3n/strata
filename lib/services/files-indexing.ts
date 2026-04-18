import { SupabaseClient } from "@supabase/supabase-js"
import { requireOrgContext } from "@/lib/services/context"

/**
 * Trigger file indexing (OCR and text extraction)
 */
export async function triggerFileIndexing(
  fileId: string,
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // 1. Get file metadata to check if indexable
  const { data: file, error: fetchError } = await supabase
    .from("files")
    .select("mime_type, storage_path")
    .eq("id", fileId)
    .single()

  if (fetchError || !file) {
    console.error(`[indexing] File not found: ${fileId}`)
    return
  }

  const indexableMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "text/plain",
    "text/csv",
  ]

  const isIndexable = indexableMimeTypes.some(mime => file.mime_type.startsWith(mime))

  if (!isIndexable) {
    console.log(`[indexing] Skipping non-indexable file type: ${file.mime_type}`)
    return
  }

  // 2. Queue indexing job in outbox
  const { error: outboxError } = await supabase.from("outbox").insert({
    org_id: resolvedOrgId,
    job_type: "index_file",
    payload: { fileId },
    run_at: new Date().toISOString(),
  })

  if (outboxError) {
    console.error(`[indexing] Failed to queue indexing job for ${fileId}:`, outboxError.message)
  } else {
    console.log(`[indexing] Queued indexing job for ${fileId}`)
  }
}
