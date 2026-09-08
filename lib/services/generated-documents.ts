import type { SupabaseClient } from "@supabase/supabase-js"

import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { uploadFilesObject } from "@/lib/storage/files-storage"

/**
 * Store a PDF Arc generated as a project file, without a signed-in user.
 *
 * Generated documents are produced from three places that have no session: a
 * sub signing a waiver in the portal, an owner certifying a pay application in
 * theirs, and outbox jobs. `createFileRecord` needs a member context, so every
 * one of those paths used to either skip the file (waivers had no PDF at all)
 * or fake a context. This is the one session-less path, and it writes exactly
 * what the session path writes: the object, the `files` row, and the link to
 * the record the document belongs to.
 */
export async function storeGeneratedPdf(input: {
  orgId: string
  projectId: string | null
  fileName: string
  pdf: Buffer
  /** Storage folder under the project, e.g. "lien-waivers". */
  storageFolder: string
  folderPath: string
  description: string
  shareWithClients?: boolean
  shareWithSubs?: boolean
  createdBy?: string | null
  metadata?: Record<string, unknown>
  attachTo?: { entityType: string; entityId: string; linkRole: string } | null
  supabase?: SupabaseClient
}): Promise<{ fileId: string; storagePath: string }> {
  const supabase = input.supabase ?? createServiceSupabaseClient()
  const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
  const scope = input.projectId ?? "general"
  const storagePath = `${input.orgId}/${scope}/${input.storageFolder}/${Date.now()}_${safeName}`

  await uploadFilesObject({
    supabase,
    orgId: input.orgId,
    path: storagePath,
    bytes: input.pdf,
    contentType: "application/pdf",
    upsert: false,
  })

  const { data, error } = await supabase
    .from("files")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      file_name: safeName,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: input.pdf.length,
      visibility: "private",
      category: "financials",
      folder_path: input.folderPath,
      description: input.description,
      source: "generated",
      share_with_clients: input.shareWithClients ?? false,
      share_with_subs: input.shareWithSubs ?? false,
      uploaded_by: input.createdBy ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`Failed to save generated document: ${error?.message}`)

  const { data: version, error: versionError } = await supabase
    .from("doc_versions")
    .insert({
      org_id: input.orgId,
      file_id: data.id,
      version_number: 1,
      storage_path: storagePath,
      file_name: safeName,
      mime_type: "application/pdf",
      size_bytes: input.pdf.length,
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single()
  if (versionError || !version) throw new Error(`Failed to record document version: ${versionError?.message}`)
  await supabase.from("files").update({ current_version_id: version.id }).eq("org_id", input.orgId).eq("id", data.id)

  if (input.attachTo) {
    await attachFileWithServiceRole({
      orgId: input.orgId,
      fileId: data.id as string,
      projectId: input.projectId,
      entityType: input.attachTo.entityType,
      entityId: input.attachTo.entityId,
      linkRole: input.attachTo.linkRole,
      createdBy: input.createdBy ?? null,
    })
  }

  return { fileId: data.id as string, storagePath }
}
