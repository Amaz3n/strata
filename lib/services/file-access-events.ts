import { requireOrgContext } from "@/lib/services/context"

export type FileAccessAction = "view" | "download" | "share" | "unshare" | "print"

export interface FileAccessEvent {
  id: string
  file_id: string
  action: FileAccessAction
  actor_user_id?: string
  actor_name?: string
  actor_email?: string
  ip_address?: string
  user_agent?: string
  metadata: Record<string, any>
  created_at: string
}

function mapAccessEvent(row: any): FileAccessEvent {
  return {
    id: row.id,
    file_id: row.file_id,
    action: row.action,
    actor_user_id: row.actor_user_id ?? undefined,
    actor_name: (row.app_users as any)?.full_name ?? undefined,
    actor_email: (row.app_users as any)?.email ?? undefined,
    ip_address: row.ip_address ?? undefined,
    user_agent: row.user_agent ?? undefined,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
  }
}

export async function listFileAccessEvents(
  fileId: string,
  limit: number = 50,
  orgId?: string
): Promise<FileAccessEvent[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("file_access_events")
    .select(`
      id, file_id, action, actor_user_id, ip_address, user_agent, metadata, created_at,
      app_users:actor_user_id(full_name, email)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to list file access events: ${error.message}`)
  }

  return (data ?? []).map(mapAccessEvent)
}
