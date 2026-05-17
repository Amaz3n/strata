import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { uploadFilesObject } from "@/lib/storage/files-storage"

const MAX_COST_PLUS_FILE_SIZE = 25 * 1024 * 1024

export async function uploadCostPlusFile({
  file,
  orgId,
  projectId,
  companyId,
  kind,
}: {
  file: File | null
  orgId: string
  projectId: string
  companyId?: string | null
  kind: "expense_receipt" | "time_attachment"
}) {
  if (!file || file.size === 0) return null
  if (file.size > MAX_COST_PLUS_FILE_SIZE) {
    throw new Error("Attachment must be 25MB or smaller")
  }

  const supabase = createServiceSupabaseClient()
  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = `${orgId}/${projectId}/cost-plus/${kind}/${timestamp}_${safeName}`
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
      category: "financials",
      folder_path: "/financials",
      metadata: {
        cost_plus_attachment: true,
        kind,
        company_id: companyId ?? null,
      },
    })
    .select("id")
    .single()

  if (error || !data) {
    throw new Error(`Failed to save attachment: ${error?.message}`)
  }

  return data.id as string
}
