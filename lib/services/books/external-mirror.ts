import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getProvider, isAccountingProviderKey } from "@/lib/integrations/accounting/registry"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"

async function requireMirrorContext(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "external_mirror", resourceId: context.orgId, logDecision: true })
  return context
}

export async function saveExternalAccountMappings(input: {
  connectionId: string
  mappings: Array<{ glAccountId: string; externalAccountId: string; externalAccountName?: string | null }>
  orgId?: string
}) {
  const context = await requireMirrorContext(input.orgId)
  const service = createServiceSupabaseClient()
  if (input.mappings.length === 0) return { saved: 0 }
  const { data: connection, error: connectionError } = await service.from("accounting_connections").select("id").eq("org_id", context.orgId).eq("id", input.connectionId).single()
  if (connectionError || !connection) throw new Error("Accounting connection not found")
  const { data: accounts, error: accountError } = await service.from("gl_accounts").select("id").eq("org_id", context.orgId).in("id", input.mappings.map((mapping) => mapping.glAccountId))
  if (accountError || (accounts?.length ?? 0) !== new Set(input.mappings.map((mapping) => mapping.glAccountId)).size) throw new Error("One or more GL accounts do not belong to this organization")
  const { error } = await service.from("accounting_account_mappings").upsert(input.mappings.map((mapping) => ({ org_id: context.orgId, connection_id: input.connectionId, gl_account_id: mapping.glAccountId, external_account_id: mapping.externalAccountId, external_account_name: mapping.externalAccountName ?? null, mapping_source: "manual", approved_by: context.userId, approved_at: new Date().toISOString() })), { onConflict: "org_id,connection_id,gl_account_id" })
  if (error) throw new Error(`Failed to save external account mappings: ${error.message}`)
  return { saved: input.mappings.length }
}

export async function mirrorJournalEntry(input: { journalEntryId: string; connectionId: string; orgId?: string }) {
  const context = await requireMirrorContext(input.orgId)
  const service = createServiceSupabaseClient()
  const [settingsResult, connectionResult, journalResult] = await Promise.all([
    service.from("books_settings").select("ledger_authority, external_sync_posture").eq("org_id", context.orgId).single(),
    service.from("accounting_connections").select("id, provider, status").eq("org_id", context.orgId).eq("id", input.connectionId).single(),
    service.from("journal_entries").select("id, status").eq("org_id", context.orgId).eq("id", input.journalEntryId).single(),
  ])
  if (settingsResult.error || settingsResult.data.ledger_authority !== "arc" || settingsResult.data.external_sync_posture !== "outbound_mirror") throw new Error("This organization is not in Arc-authoritative external-mirror mode")
  if (connectionResult.error || connectionResult.data.status !== "active" || !isAccountingProviderKey(connectionResult.data.provider)) throw new Error("External accounting connection is unavailable")
  if (journalResult.error || journalResult.data.status !== "posted") throw new Error("Only a posted Arc journal can be mirrored")
  const provider = getProvider(connectionResult.data.provider)
  if (!provider.capabilities.supportsJournalEntryPush || !provider.pushJournalEntry) throw new Error(`${connectionResult.data.provider} does not support journal mirroring`)
  const result = await provider.pushJournalEntry({ orgId: context.orgId, connectionId: input.connectionId, journalId: input.journalEntryId })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.journal_mirrored", entityType: "journal_entry", entityId: input.journalEntryId, payload: { connection_id: input.connectionId, provider: connectionResult.data.provider, external_id: result.externalId } })
  return result
}
