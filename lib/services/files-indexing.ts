import { requireOrgContext } from "@/lib/services/context"
import { enqueueOutboxJob } from "@/lib/services/outbox"

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
    .select("file_name, mime_type, storage_path")
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
    "image/heic",
    "image/heif",
    "image/tiff",
    "text/plain",
    "text/csv",
  ]
  const previewableMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/tiff",
  ]

  const mimeType = file.mime_type ?? "application/octet-stream"
  const lowerFileName = file.file_name?.toLowerCase() ?? ""
  const lowerStoragePath = file.storage_path?.toLowerCase() ?? ""
  const hasHeicExtension =
    lowerFileName.endsWith(".heic") ||
    lowerFileName.endsWith(".heif") ||
    lowerStoragePath.endsWith(".heic") ||
    lowerStoragePath.endsWith(".heif")
  const isIndexable = indexableMimeTypes.some(mime => mimeType.startsWith(mime))
  const isPreviewable = hasHeicExtension || previewableMimeTypes.some(mime => mimeType.startsWith(mime))

  if (!isIndexable) {
    console.log(`[indexing] Skipping non-indexable file type: ${mimeType}`)
  } else {
    await enqueueOutboxJob({
      orgId: resolvedOrgId,
      jobType: "index_file",
      payload: { fileId },
      runAt: new Date().toISOString(),
      dedupeByPayloadKeys: ["fileId"],
    })
  }

  if (!isPreviewable) {
    console.log(`[preview] Skipping non-previewable file type: ${mimeType}`)
    return
  }

  await enqueueOutboxJob({
    orgId: resolvedOrgId,
    jobType: "generate_file_preview",
    payload: { fileId },
    runAt: new Date().toISOString(),
    dedupeByPayloadKeys: ["fileId"],
  })
}
