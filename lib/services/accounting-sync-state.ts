import type { SupabaseClient } from "@supabase/supabase-js"

import { ACCOUNTING_PROVIDER_KEYS } from "@/lib/integrations/accounting/catalog"

export type AccountingSyncStatus =
  | "synced"
  | "pending"
  | "processing"
  | "error"
  | "conflict"
  | "needs_review"
  | "skipped"
  | "accrued"
  | "exported"

export type AccountingSyncState = {
  connectionId: string | null
  provider: string | null
  externalId: string | null
  externalVersion: string | null
  syncedAt: string | null
  status: AccountingSyncStatus
  error: string | null
  statusReason: string | null
  lastAttemptId: string | null
  updatedAt: string
  pushable: boolean
  metadata: Record<string, unknown>
}

type AccountingSyncRecordRow = {
  entity_id: string
  connection_id: string | null
  provider: string | null
  external_id: string | null
  external_version: string | null
  last_synced_at: string | null
  status: AccountingSyncStatus
  error_message: string | null
  status_reason: string | null
  last_attempt_id: string | null
  updated_at: string
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
    statusReason: row.status_reason,
    lastAttemptId: row.last_attempt_id,
    updatedAt: row.updated_at,
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
    .select("entity_id,connection_id,provider,external_id,external_version,last_synced_at,status,error_message,status_reason,last_attempt_id,updated_at,pushable,metadata")
    .eq("org_id", input.orgId)
    .eq("entity_type", input.entityType)
    .in("entity_id", entityIds)
    .order("updated_at", { ascending: false })

  if (error) throw new Error(`Unable to load accounting sync state: ${error.message}`)
  const states = new Map<string, AccountingSyncState>()
  for (const row of (data ?? []) as AccountingSyncRecordRow[]) {
    if (!states.has(row.entity_id)) states.set(row.entity_id, mapState(row))
  }
  return states
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

export function indexLatestBillPaymentSyncByBillId(
  latestPaymentIdByBillId: Record<string, string>,
  billPayments: Record<string, AccountingSyncState>,
): Record<string, AccountingSyncState> {
  const byBillId: Record<string, AccountingSyncState> = {}
  for (const [billId, paymentId] of Object.entries(latestPaymentIdByBillId)) {
    const state = billPayments[paymentId]
    if (state) byBillId[billId] = state
  }
  return byBillId
}

/**
 * The external id for one Arc entity: the sync-record layer first, the legacy
 * `qbo_*` column only as a fallback.
 *
 * This is the read half of the C3.4 dual-read. The push side already resolves
 * this way; read paths still reached straight for the column, which meant a
 * money-moving create could depend on a value the gated drop migration is going
 * to remove. The fallback stays until that migration lands — the point of a
 * dual-read is that neither source is required, not that the new one is.
 */
export async function resolveAccountingExternalId(
  supabase: SupabaseClient,
  input: {
    orgId: string
    connectionId: string
    entityType: string
    entityId: string
  },
): Promise<string | null> {
  let query = supabase
    .from("accounting_sync_records")
    .select("external_id, last_synced_at")
    .eq("org_id", input.orgId)
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
    .neq("external_id", "")
    .order("last_synced_at", { ascending: false })
    .limit(1)
  if (!input.connectionId) throw new Error("Accounting external identity requires a connection")
  query = query.eq("connection_id", input.connectionId)

  const { data, error } = await query
  if (error) throw new Error(`Unable to resolve accounting external identity: ${error.message}`)
  const recorded = data?.[0]?.external_id
  if (typeof recorded === "string" && recorded.length > 0) return recorded
  return null
}

/**
 * True when an invoice originated from — or is linked into — the org's
 * accounting system, whichever one that is.
 *
 * Nothing here may name a provider. The authority is the sync-record layer, so
 * pass `state` whenever the caller already loaded it; `qbo_id` is only the
 * pre-abstraction fallback for entities the C3.4 backfill has not reached, and
 * it disappears with the column. The `source_type` check accepts any registered
 * provider key rather than the literal `"qbo"`, so an org importing from the
 * next adapter is not silently treated as having no external system.
 */
export function invoiceIsFromAccountingProvider(
  invoice: {
    qbo_id?: string | null
    metadata?: Record<string, unknown> | null
  },
  state?: AccountingSyncState | null,
): boolean {
  if (hasAccountingExternalId(state)) return true
  const sourceType = (invoice.metadata as { source_type?: string } | null)?.source_type
  return typeof sourceType === "string" && (ACCOUNTING_PROVIDER_KEYS as string[]).includes(sourceType)
}
