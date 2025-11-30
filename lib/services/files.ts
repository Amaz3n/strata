import type { FileMetadata } from "@/lib/types"
import type { FileInput } from "@/lib/validation/files"
import { fileInputSchema } from "@/lib/validation/files"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"

function mapFile(row: any): FileMetadata {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    file_name: row.file_name,
    storage_path: row.storage_path,
    mime_type: row.mime_type ?? undefined,
    size_bytes: row.size_bytes ?? undefined,
    visibility: row.visibility,
    created_at: row.created_at,
  }
}

export async function listFiles(orgId?: string): Promise<FileMetadata[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("files")
    .select("id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at")
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })
    .limit(50)

  if (error) {
    throw new Error(`Failed to list files: ${error.message}`)
  }

  return (data ?? []).map(mapFile)
}

export async function createFileRecord(input: FileInput, orgId?: string) {
  const parsed = fileInputSchema.parse(input)

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("files")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      file_name: parsed.file_name,
      storage_path: parsed.storage_path,
      mime_type: parsed.mime_type,
      size_bytes: parsed.size_bytes,
      visibility: parsed.visibility ?? "private",
      uploaded_by: userId,
    })
    .select("id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create file record: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "file",
    entityId: data.id as string,
    after: data,
  })

  return mapFile(data)
}
