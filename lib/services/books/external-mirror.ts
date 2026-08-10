import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getProvider, isAccountingProviderKey } from "@/lib/integrations/accounting/registry"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { buildMirrorSummary, mirrorReference } from "@/lib/services/books/mirror-rules"

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

/**
 * Mirror one CLOSED accounting period into the external system as a single
 * summarized journal.
 *
 * This is the engine `mirrorJournalEntry` never had, at the grain it should
 * have had: per-source-transaction pushes turn the external system into an
 * unreadable replay of Arc's operations, and the whole promise of the
 * Arc-authoritative posture is that the external system becomes something a CPA
 * can file from.
 *
 * Only closed periods are mirrorable — mirroring an open period publishes a
 * number that is still moving, and the external entry is not re-derived once
 * posted.
 */
export async function mirrorPeriodSummary(input: { periodId: string; connectionId: string; orgId?: string }) {
  const context = await requireMirrorContext(input.orgId)
  const service = createServiceSupabaseClient()

  const [settingsResult, connectionResult, periodResult] = await Promise.all([
    service.from("books_settings").select("ledger_authority, external_sync_posture").eq("org_id", context.orgId).single(),
    service.from("accounting_connections").select("id, provider, status, label").eq("org_id", context.orgId).eq("id", input.connectionId).single(),
    service.from("accounting_periods").select("id, period_start, period_end, status, fiscal_year, fiscal_period").eq("org_id", context.orgId).eq("id", input.periodId).single(),
  ])
  if (settingsResult.error || settingsResult.data.ledger_authority !== "arc" || settingsResult.data.external_sync_posture !== "outbound_mirror") {
    throw new Error("This organization is not in Arc-authoritative external-mirror mode")
  }
  if (connectionResult.error || connectionResult.data.status !== "active" || !isAccountingProviderKey(connectionResult.data.provider)) {
    throw new Error("External accounting connection is unavailable")
  }
  if (periodResult.error || periodResult.data.status !== "closed") {
    throw new Error("Only a closed accounting period can be mirrored")
  }
  const period = periodResult.data
  const provider = getProvider(connectionResult.data.provider)
  if (!provider.capabilities.supportsJournalEntryPush || !provider.pushSummaryJournal) {
    throw new Error(`${connectionResult.data.label} cannot accept a summarized journal`)
  }

  const reference = mirrorReference(period.id, input.connectionId)
  const { data: alreadyMirrored } = await service
    .from("accounting_sync_records")
    .select("external_id, status")
    .eq("org_id", context.orgId)
    .eq("connection_id", input.connectionId)
    .eq("entity_type", "period_summary")
    .eq("entity_id", period.id)
    .maybeSingle()
  if (alreadyMirrored?.status === "synced" && alreadyMirrored.external_id) {
    return { externalId: alreadyMirrored.external_id, skipped: true as const }
  }

  // Posted lines only, and dated inside the period. Draft journals cannot be
  // mirrored and the close checklist already blocks a period that has any.
  const { data: entries, error: entriesError } = await service
    .from("journal_entries")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("status", "posted")
    .gte("entry_date", period.period_start)
    .lte("entry_date", period.period_end)
  if (entriesError) throw new Error(`Unable to load period journals: ${entriesError.message}`)
  const entryIds = (entries ?? []).map((entry) => entry.id)
  if (entryIds.length === 0) throw new Error("This period has no posted journals to mirror")

  const [linesResult, accountsResult, mappingsResult] = await Promise.all([
    service.from("journal_lines").select("account_id, debit_cents, credit_cents").eq("org_id", context.orgId).in("entry_id", entryIds),
    service.from("gl_accounts").select("id, code, name").eq("org_id", context.orgId),
    service.from("accounting_account_mappings").select("gl_account_id, external_account_id, external_account_name").eq("org_id", context.orgId).eq("connection_id", input.connectionId),
  ])
  if (linesResult.error) throw new Error(`Unable to load period journal lines: ${linesResult.error.message}`)
  if (accountsResult.error) throw new Error(`Unable to load the chart of accounts: ${accountsResult.error.message}`)
  if (mappingsResult.error) throw new Error(`Unable to load external account mappings: ${mappingsResult.error.message}`)

  const periodLabel = `FY${period.fiscal_year} P${period.fiscal_period}`
  const summary = buildMirrorSummary({
    lines: (linesResult.data ?? []).map((line) => ({
      accountId: line.account_id as string,
      debitCents: Number(line.debit_cents ?? 0),
      creditCents: Number(line.credit_cents ?? 0),
    })),
    accounts: (accountsResult.data ?? []).map((account) => ({
      accountId: account.id as string,
      code: String(account.code),
      name: String(account.name),
    })),
    mappings: (mappingsResult.data ?? []).map((mapping) => ({
      glAccountId: mapping.gl_account_id as string,
      externalAccountId: mapping.external_account_id as string,
      externalAccountName: (mapping.external_account_name as string | null) ?? null,
    })),
    periodLabel,
  })

  if (!summary.ok) {
    // Named accounts, not a count: the cure is mapping those specific accounts,
    // and a summary that silently dropped them would corrupt the CPA's trial
    // balance instead of telling anyone the mapping is incomplete.
    if (summary.unmappedAccounts.length > 0) {
      const names = summary.unmappedAccounts.map((account) => `${account.code} ${account.name}`).join(", ")
      throw new Error(`Map these accounts to ${connectionResult.data.label} before mirroring: ${names}`)
    }
    throw new Error(`The period summary does not balance (off by ${summary.unbalancedBy} cents)`)
  }

  const result = await provider.pushSummaryJournal({
    orgId: context.orgId,
    connectionId: input.connectionId,
    reference,
    date: period.period_end,
    memo: `Arc Books summary · ${periodLabel} (${period.period_start} – ${period.period_end})`,
    lines: summary.lines,
  })

  const { error: recordError } = await service.from("accounting_sync_records").upsert({
    org_id: context.orgId,
    connection_id: input.connectionId,
    provider: connectionResult.data.provider,
    entity_type: "period_summary",
    entity_id: period.id,
    external_id: result.externalId ?? "",
    status: "synced",
    last_synced_at: new Date().toISOString(),
  }, { onConflict: "org_id,connection_id,entity_type,entity_id" })
  if (recordError) throw new Error(`Failed to record the mirrored period: ${recordError.message}`)

  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.period_mirrored",
    entityType: "accounting_period",
    entityId: period.id,
    payload: {
      connection_id: input.connectionId,
      provider: connectionResult.data.provider,
      external_id: result.externalId,
      line_count: summary.lines.length,
      total_debit_cents: summary.totalDebitCents,
    },
  })
  return { externalId: result.externalId, lineCount: summary.lines.length, skipped: false as const }
}
