import type { SupabaseClient } from "@supabase/supabase-js"

export type AccountingSyncStatus =
  | "synced"
  | "pending"
  | "processing"
  | "error"
  | "conflict"
  | "needs_review"

export type AccountingSyncState = {
  connectionId: string
  provider: string
  externalId: string | null
  externalVersion: string | null
  syncedAt: string | null
  status: AccountingSyncStatus
  error: string | null
  pushable: boolean
  metadata: Record<string, unknown>
}

type AccountingSyncRecordRow = {
  entity_id: string
  connection_id: string
  provider: string
  external_id: string | null
  external_version: string | null
  last_synced_at: string | null
  status: AccountingSyncStatus
  error_message: string | null
  pushable: boolean | null
  metadata: Record<string, unknown> | null
}

function mapState(row: AccountingSyncRecordRow): AccountingSyncState {
  return {
    connectionId: row.connection_id,
    provider: row.provider,
    externalId: row.external_id || null,
    externalVersion: row.external_version,
    syncedAt: row.last_synced_at,
    status: row.status,
    error: row.error_message,
    pushable: row.pushable !== false,
    metadata: row.metadata ?? {},
  }
}

export async function getAccountingSyncStates(
  supabase: SupabaseClient,
  input: { orgId: string; entityType: string; entityIds: string[] },
): Promise<Map<string, AccountingSyncState>> {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)))
  if (entityIds.length === 0) return new Map()

  const { data, error } = await supabase
    .from("accounting_sync_records")
    .select("entity_id,connection_id,provider,external_id,external_version,last_synced_at,status,error_message,pushable,metadata")
    .eq("org_id", input.orgId)
    .eq("entity_type", input.entityType)
    .in("entity_id", entityIds)

  if (error) throw new Error(`Unable to load accounting sync state: ${error.message}`)
  return new Map(((data ?? []) as AccountingSyncRecordRow[]).map((row) => [row.entity_id, mapState(row)]))
}

export async function getAccountingSyncState(
  supabase: SupabaseClient,
  input: { orgId: string; entityType: string; entityId: string },
): Promise<AccountingSyncState | null> {
  const states = await getAccountingSyncStates(supabase, {
    orgId: input.orgId,
    entityType: input.entityType,
    entityIds: [input.entityId],
  })
  return states.get(input.entityId) ?? null
}

export function hasAccountingExternalId(state: AccountingSyncState | null | undefined) {
  return Boolean(state?.externalId)
}
