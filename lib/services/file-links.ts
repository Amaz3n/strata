import type { FileLinkInput } from "@/lib/validation/files"
import { fileLinkInputSchema } from "@/lib/validation/files"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import type { FileRecord, FileWithUrls } from "@/lib/services/files"

export interface FileLink {
  id: string
  org_id: string
  file_id: string
  project_id?: string
  entity_type: string
  entity_id: string
  link_role?: string
  created_by?: string
  created_at: string
}

export interface FileLinkWithFile extends FileLink {
  file: FileWithUrls
}

function mapFileLink(row: any): FileLink {
  return {
    id: row.id,
    org_id: row.org_id,
    file_id: row.file_id,
    project_id: row.project_id ?? undefined,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    link_role: row.link_role ?? undefined,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
  }
}

function mapFile(row: any): FileWithUrls {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    file_name: row.file_name,
    storage_path: row.storage_path,
    mime_type: row.mime_type ?? undefined,
    size_bytes: row.size_bytes ?? undefined,
    checksum: row.checksum ?? undefined,
    visibility: row.visibility,
    category: row.category ?? undefined,
    folder_path: row.folder_path ?? undefined,
    description: row.description ?? undefined,
    tags: row.tags ?? [],
    source: row.source ?? undefined,
    uploaded_by: row.uploaded_by ?? undefined,
    uploader_name: (row.app_users as any)?.full_name ?? undefined,
    uploader_avatar: (row.app_users as any)?.avatar_url ?? undefined,
    archived_at: row.archived_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    download_url: undefined, // Will be populated by caller if needed
    thumbnail_url: undefined,
  }
}

/**
 * Attach a file to an entity
 */
export async function attachFile(
  input: FileLinkInput,
  orgId?: string
): Promise<FileLink> {
  const parsed = fileLinkInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // Verify file exists and belongs to org
  const { data: file, error: fileError } = await supabase
    .from("files")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.file_id)
    .single()

  if (fileError || !file) {
    throw new Error("File not found or access denied")
  }

  // Check if link already exists
  const { data: existing } = await supabase
    .from("file_links")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("file_id", parsed.file_id)
    .eq("entity_type", parsed.entity_type)
    .eq("entity_id", parsed.entity_id)
    .maybeSingle()

  if (existing) {
    // Link already exists, update role if provided
    if (parsed.link_role) {
      const { data, error } = await supabase
        .from("file_links")
        .update({ link_role: parsed.link_role })
        .eq("id", existing.id)
        .select("*")
        .single()

      if (error || !data) {
        throw new Error(`Failed to update file link: ${error?.message}`)
      }

      return mapFileLink(data)
    }

    // Return existing link
    const { data, error } = await supabase
      .from("file_links")
      .select("*")
      .eq("id", existing.id)
      .single()

    if (error || !data) {
      throw new Error(`Failed to get file link: ${error?.message}`)
    }

    return mapFileLink(data)
  }

  // Create new link
  const { data, error } = await supabase
    .from("file_links")
    .insert({
      org_id: resolvedOrgId,
      file_id: parsed.file_id,
      project_id: parsed.project_id,
      entity_type: parsed.entity_type,
      entity_id: parsed.entity_id,
      link_role: parsed.link_role,
      created_by: userId,
    })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to attach file: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "file_link",
    entityId: data.id as string,
    after: data,
  })

  return mapFileLink(data)
}

/**
 * Detach a file from an entity
 */
export async function detachFile(
  fileId: string,
  entityType: string,
  entityId: string,
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("file_links")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .single()

  if (fetchError) {
    if (fetchError.code === "PGRST116") return // Link doesn't exist, nothing to do
    throw new Error(`Failed to find file link: ${fetchError.message}`)
  }

  const { error } = await supabase
    .from("file_links")
    .delete()
    .eq("id", existing.id)

  if (error) {
    throw new Error(`Failed to detach file: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "file_link",
    entityId: existing.id,
    before: existing,
  })
}

/**
 * Detach a file link by ID
 */
export async function detachFileById(linkId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("file_links")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", linkId)
    .single()

  if (fetchError || !existing) {
    throw new Error("File link not found")
  }

  const { error } = await supabase
    .from("file_links")
    .delete()
    .eq("id", linkId)

  if (error) {
    throw new Error(`Failed to detach file: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "file_link",
    entityId: linkId,
    before: existing,
  })
}

/**
 * List attachments for an entity
 */
export async function listAttachments(
  entityType: string,
  entityId: string,
  orgId?: string
): Promise<FileLinkWithFile[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("file_links")
    .select(`
      id, org_id, file_id, project_id, entity_type, entity_id, link_role, created_by, created_at,
      files!inner(
        id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
        checksum, visibility, category, folder_path, description, tags, source,
        uploaded_by, archived_at, created_at, updated_at,
        app_users!files_uploaded_by_fkey(full_name, avatar_url)
      )
    `)
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list attachments: ${error.message}`)
  }

  // Generate signed URLs for each file
  const results: FileLinkWithFile[] = []

  for (const row of data ?? []) {
    const fileData = row.files as any
    const file = mapFile(fileData)

    // Generate signed URL
    try {
      const { data: urlData } = await supabase.storage
        .from("project-files")
        .createSignedUrl(file.storage_path, 3600)

      file.download_url = urlData?.signedUrl

      if (file.mime_type?.startsWith("image/")) {
        file.thumbnail_url = file.download_url
      }
    } catch (e) {
      console.error("Failed to generate URL for", file.file_name)
    }

    results.push({
      ...mapFileLink(row),
      file,
    })
  }

  return results
}

/**
 * List all links for a file
 */
export async function listFileLinks(fileId: string, orgId?: string): Promise<FileLink[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("file_links")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list file links: ${error.message}`)
  }

  return (data ?? []).map(mapFileLink)
}

/**
 * Check if a file is attached to any entities
 */
export async function hasAttachments(fileId: string, orgId?: string): Promise<boolean> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { count, error } = await supabase
    .from("file_links")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)

  if (error) {
    throw new Error(`Failed to check attachments: ${error.message}`)
  }

  return (count ?? 0) > 0
}

/**
 * Get count of attachments for an entity
 */
export async function getAttachmentCount(
  entityType: string,
  entityId: string,
  orgId?: string
): Promise<number> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { count, error } = await supabase
    .from("file_links")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)

  if (error) {
    throw new Error(`Failed to get attachment count: ${error.message}`)
  }

  return count ?? 0
}

/**
 * Bulk attach files to an entity
 */
export async function bulkAttachFiles(
  fileIds: string[],
  entityType: string,
  entityId: string,
  projectId?: string,
  linkRole?: string,
  orgId?: string
): Promise<FileLink[]> {
  const results: FileLink[] = []

  for (const fileId of fileIds) {
    const link = await attachFile(
      {
        file_id: fileId,
        entity_type: entityType,
        entity_id: entityId,
        project_id: projectId,
        link_role: linkRole,
      },
      orgId
    )
    results.push(link)
  }

  return results
}

/**
 * Get entities that a file is attached to
 */
export async function getLinkedEntities(
  fileId: string,
  orgId?: string
): Promise<Array<{ type: string; id: string; role?: string }>> {
  const links = await listFileLinks(fileId, orgId)

  return links.map((link) => ({
    type: link.entity_type,
    id: link.entity_id,
    role: link.link_role,
  }))
}
