import { randomBytes } from "node:crypto"

import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { buildFilesPublicUrl, ensureOrgScopedPath } from "@/lib/storage/files-storage"

export interface FileShareLink {
  id: string
  org_id: string
  project_id?: string
  file_id: string
  token: string
  label?: string
  expires_at?: string
  max_uses?: number
  use_count: number
  allow_download: boolean
  revoked_at?: string
  created_by?: string
  created_at: string
  is_active: boolean
}

export interface FileShareLinkResolved extends FileShareLink {
  file: {
    id: string
    org_id: string
    project_id?: string
    file_name: string
    storage_path: string
    mime_type?: string
    size_bytes?: number
  }
  download_url?: string
}

export interface CreateFileShareLinkInput {
  file_id: string
  label?: string | null
  expires_at?: string | null
  max_uses?: number | null
  allow_download?: boolean
}

function generateToken(): string {
  // 24 bytes → 32 url-safe characters. Unguessable.
  return randomBytes(24).toString("base64url")
}

function mapRow(row: any): FileShareLink {
  const expires = row.expires_at ? new Date(row.expires_at).getTime() : null
  const now = Date.now()
  const revoked = Boolean(row.revoked_at)
  const expired = expires !== null && expires <= now
  const exhausted =
    row.max_uses !== null && row.max_uses !== undefined && row.use_count >= row.max_uses

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    file_id: row.file_id,
    token: row.token,
    label: row.label ?? undefined,
    expires_at: row.expires_at ?? undefined,
    max_uses: row.max_uses ?? undefined,
    use_count: row.use_count ?? 0,
    allow_download: Boolean(row.allow_download),
    revoked_at: row.revoked_at ?? undefined,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
    is_active: !revoked && !expired && !exhausted,
  }
}

export async function createFileShareLink(
  input: CreateFileShareLinkInput,
  orgId?: string,
): Promise<FileShareLink> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: file, error: fileError } = await supabase
    .from("files")
    .select("id, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", input.file_id)
    .single()

  if (fileError || !file) {
    throw new Error("File not found or access denied")
  }

  const token = generateToken()

  const { data, error } = await supabase
    .from("file_share_links")
    .insert({
      org_id: resolvedOrgId,
      project_id: file.project_id,
      file_id: input.file_id,
      token,
      label: input.label?.trim() || null,
      expires_at: input.expires_at ?? null,
      max_uses: input.max_uses ?? null,
      allow_download: input.allow_download ?? true,
      created_by: userId,
    })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create share link: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "file_share_link",
    entityId: data.id,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "file_share_link_created",
    entityType: "file",
    entityId: input.file_id,
    payload: {
      share_link_id: data.id,
      expires_at: data.expires_at,
      allow_download: data.allow_download,
    },
  })

  return mapRow(data)
}

export async function listFileShareLinks(
  fileId: string,
  orgId?: string,
): Promise<FileShareLink[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("file_share_links")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list share links: ${error.message}`)
  }

  return (data ?? []).map(mapRow)
}

export async function revokeFileShareLink(
  linkId: string,
  orgId?: string,
): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("file_share_links")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", linkId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Share link not found")
  }

  if (existing.revoked_at) return

  const { error } = await supabase
    .from("file_share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", linkId)

  if (error) {
    throw new Error(`Failed to revoke share link: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "file_share_link",
    entityId: linkId,
    before: existing,
    after: { ...existing, revoked_at: new Date().toISOString() },
  })
}

/**
 * Resolve a share link by its public token using the service role.
 * Validates expiry, revocation, and max-uses. Returns null if not usable.
 *
 * Intended to be called from the public /f/[token] route.
 */
export async function getFileShareLinkByToken(
  token: string,
): Promise<FileShareLinkResolved | null> {
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("file_share_links")
    .select(
      `*,
      files:file_id (
        id, org_id, project_id, file_name, storage_path, mime_type, size_bytes
      )`,
    )
    .eq("token", token)
    .maybeSingle()

  if (error || !data) return null

  const mapped = mapRow(data)
  if (!mapped.is_active) return null

  const fileRow = (data as any).files
  if (!fileRow) return null

  let downloadUrl: string | undefined
  try {
    downloadUrl =
      buildFilesPublicUrl(ensureOrgScopedPath(fileRow.org_id, fileRow.storage_path)) ??
      undefined
  } catch (err) {
    console.error("Failed to build download URL for share link", err)
  }

  return {
    ...mapped,
    file: {
      id: fileRow.id,
      org_id: fileRow.org_id,
      project_id: fileRow.project_id ?? undefined,
      file_name: fileRow.file_name,
      storage_path: fileRow.storage_path,
      mime_type: fileRow.mime_type ?? undefined,
      size_bytes: fileRow.size_bytes ?? undefined,
    },
    download_url: downloadUrl,
  }
}

/**
 * Increment the use count and write a file_access_events entry.
 * Best-effort — failures are logged, not thrown.
 */
export async function recordShareLinkView(params: {
  linkId: string
  fileId: string
  orgId: string
  ipAddress?: string | null
  userAgent?: string | null
}): Promise<void> {
  const supabase = createServiceSupabaseClient()

  try {
    const { data } = await supabase
      .from("file_share_links")
      .select("use_count")
      .eq("id", params.linkId)
      .maybeSingle()
    if (data) {
      await supabase
        .from("file_share_links")
        .update({ use_count: (data.use_count ?? 0) + 1 })
        .eq("id", params.linkId)
    }
  } catch (err) {
    console.error("Failed to increment share link use count", err)
  }

  try {
    await supabase.from("file_access_events").insert({
      org_id: params.orgId,
      file_id: params.fileId,
      action: "view",
      ip_address: params.ipAddress ?? null,
      user_agent: params.userAgent ?? null,
      metadata: { source: "share_link", share_link_id: params.linkId },
    })
  } catch (err) {
    console.error("Failed to record share link view", err)
  }
}
