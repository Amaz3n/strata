import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordEvent } from "@/lib/services/events"

const connectionSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  provider: z.string(),
  last_sync_at: z.string().nullable(),
  status: z.string(),
})

type ReconciliationItem = {
  category: string
  entityType?: string
  entityId?: string
  status: "open"
  details: Record<string, unknown>
}

function itemKey(item: Pick<ReconciliationItem, "category" | "entityType" | "entityId">) {
  return `${item.category}:${item.entityType ?? ""}:${item.entityId ?? ""}`
}

export async function runAccountingReconciliation(orgId: string, connectionId: string) {
  const service = createServiceSupabaseClient()
  const runDate = new Date().toISOString().slice(0, 10)
  const { data: runData, error: runError } = await service.from("accounting_reconciliation_runs").insert({
    org_id: orgId,
    connection_id: connectionId,
    run_date: runDate,
    status: "running",
    checked_counts: {},
  }).select("id").single()
  if (runError) throw new Error(`Failed to start accounting reconciliation: ${runError.message}`)
  const runId = z.object({ id: z.string().uuid() }).parse(runData).id

  try {
    const [connectionResult, syncResult, priorRunResult, draftJournalResult] = await Promise.all([
      service
        .from("accounting_connections")
        .select("id, org_id, provider, last_sync_at, status")
        .eq("org_id", orgId)
        .eq("id", connectionId)
        .single(),
      service
        .from("accounting_sync_records")
        .select("entity_type, entity_id, status, error_message, updated_at")
        .eq("org_id", orgId)
        .eq("connection_id", connectionId)
        .neq("status", "synced")
        .limit(200),
      service
        .from("accounting_reconciliation_runs")
        .select("id")
        .eq("org_id", orgId)
        .eq("connection_id", connectionId)
        .neq("id", runId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      service
        .from("journal_entries")
        .select("id, posting_key, entry_date")
        .eq("org_id", orgId)
        .eq("status", "draft")
        .limit(200),
    ])
    if (connectionResult.error) throw new Error(connectionResult.error.message)
    if (syncResult.error) throw new Error(syncResult.error.message)
    if (priorRunResult.error) throw new Error(priorRunResult.error.message)
    if (draftJournalResult.error) throw new Error(draftJournalResult.error.message)

    const connection = connectionSchema.parse(connectionResult.data)
    const items: ReconciliationItem[] = []
    if (connection.status !== "active") {
      items.push({ category: "connection_unhealthy", status: "open", details: { status: connection.status, provider: connection.provider } })
    }
    const lastSyncMs = connection.last_sync_at ? new Date(connection.last_sync_at).getTime() : 0
    if (!lastSyncMs || Date.now() - lastSyncMs > 48 * 60 * 60 * 1000) {
      items.push({ category: "connection_stale", status: "open", details: { last_sync_at: connection.last_sync_at, provider: connection.provider } })
    }
    for (const row of syncResult.data ?? []) {
      items.push({
        category: row.status === "error" ? "sync_error" : "unreconciled_sync_record",
        entityType: row.entity_type ?? undefined,
        entityId: row.entity_id ?? undefined,
        status: "open",
        details: { status: row.status, error: row.error_message, updated_at: row.updated_at },
      })
    }
    for (const row of draftJournalResult.data ?? []) {
      items.push({
        category: "unposted_journal",
        entityType: "journal_entry",
        entityId: row.id,
        status: "open",
        details: { posting_key: row.posting_key, entry_date: row.entry_date },
      })
    }

    if (items.length > 0) {
      const { error: itemError } = await service.from("accounting_reconciliation_items").insert(items.map((item) => ({
        org_id: orgId,
        run_id: runId,
        category: item.category,
        entity_type: item.entityType ?? null,
        entity_id: item.entityId ?? null,
        status: item.status,
        details: item.details,
      })))
      if (itemError) throw new Error(itemError.message)
    }

    const priorKeys = new Set<string>()
    if (priorRunResult.data?.id) {
      const { data: priorItems, error: priorError } = await service
        .from("accounting_reconciliation_items")
        .select("category, entity_type, entity_id")
        .eq("org_id", orgId)
        .eq("run_id", priorRunResult.data.id)
        .eq("status", "open")
        .limit(200)
      if (priorError) throw new Error(priorError.message)
      for (const prior of priorItems ?? []) {
        priorKeys.add(itemKey({
          category: prior.category,
          entityType: prior.entity_type ?? undefined,
          entityId: prior.entity_id ?? undefined,
        }))
      }
    }
    const newItems = items.filter((item) => !priorKeys.has(itemKey(item)))
    const status = items.length === 0 ? "passed" : "warning"
    const { error: completeError } = await service.from("accounting_reconciliation_runs").update({
      status,
      checked_counts: {
        sync_records: syncResult.data?.length ?? 0,
        draft_journals: draftJournalResult.data?.length ?? 0,
      },
      discrepancy_count: items.length,
      completed_at: new Date().toISOString(),
    }).eq("org_id", orgId).eq("id", runId)
    if (completeError) throw new Error(completeError.message)

    if (newItems.length > 0) {
      await recordEvent({
        orgId,
        eventType: "accounting_reconciliation_drift",
        entityType: "accounting_reconciliation_run",
        entityId: runId,
        payload: {
          message: `${newItems.length} new accounting reconciliation issue${newItems.length === 1 ? "" : "s"}`,
          discrepancy_count: items.length,
          new_discrepancy_count: newItems.length,
          connection_id: connectionId,
        },
        channel: "notification",
      })
    }
    return { runId, status, discrepancyCount: items.length, newDiscrepancyCount: newItems.length }
  } catch (error) {
    await service.from("accounting_reconciliation_runs").update({
      status: "failed",
      error_message: error instanceof Error ? error.message : String(error),
      completed_at: new Date().toISOString(),
    }).eq("org_id", orgId).eq("id", runId)
    throw error
  }
}

export async function runNightlyAccountingReconciliation() {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("accounting_connections")
    .select("id, org_id")
    .eq("status", "active")
    .order("org_id")
    .limit(5000)
  if (error) throw new Error(`Failed to load accounting connections: ${error.message}`)
  const connections = z.array(z.object({ id: z.string().uuid(), org_id: z.string().uuid() })).parse(data ?? [])
  const failures: Array<{ connectionId: string; error: string }> = []
  let completed = 0
  for (let offset = 0; offset < connections.length; offset += 10) {
    const batch = connections.slice(offset, offset + 10)
    const results = await Promise.allSettled(batch.map((connection) => runAccountingReconciliation(connection.org_id, connection.id)))
    results.forEach((result, index) => {
      if (result.status === "fulfilled") completed += 1
      else failures.push({
        connectionId: batch[index].id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    })
  }
  return { attempted: connections.length, completed, failures }
}

