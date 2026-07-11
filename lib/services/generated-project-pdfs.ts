import { createFileRecord } from "@/lib/services/files"
import { createInitialVersion } from "@/lib/services/file-versions"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import type { SupabaseClient } from "@supabase/supabase-js"

export async function persistGeneratedProjectPdf({
  supabase,
  orgId,
  projectId,
  fileName,
  pdf,
  category,
  folderPath,
  description,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  fileName: string
  pdf: Buffer
  category: "rfis" | "submittals" | "other"
  folderPath: string
  description: string
}) {
  const storagePath = `${orgId}/${projectId}/generated-documents/${Date.now()}_${fileName}`
  await uploadFilesObject({ supabase, orgId, path: storagePath, bytes: pdf, contentType: "application/pdf", upsert: false })
  const file = await createFileRecord({
    project_id: projectId,
    file_name: fileName,
    storage_path: storagePath,
    mime_type: "application/pdf",
    size_bytes: pdf.length,
    visibility: "private",
    category,
    folder_path: folderPath,
    description,
    source: "generated",
  }, orgId)
  await createInitialVersion({
    fileId: file.id,
    storagePath,
    fileName,
    mimeType: "application/pdf",
    sizeBytes: pdf.length,
  }, orgId)
  return file
}

