import { randomUUID } from "crypto"
import { z } from "zod"
import type { QBOClient } from "@/lib/integrations/accounting/qbo/client"
import {
  CDC_ENTITIES,
  isCdcResponseError,
  cdcRow,
  cdcTimestamp,
  parseCdcResponse,
  type CdcEntity,
  type CdcRow,
} from "@/lib/integrations/accounting/qbo/cdc"
import { accountingDeliveryDeadline } from "@/lib/services/accounting-delivery"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { workerPersistenceDeadline, withWorkerDatabasePersistence } from "@/lib/supabase/worker-request-context"

const DAY = 86_400_000
const OVERLAP = 5 * 60_000
const PAGE_SIZE = 200
const MAX_REQUESTS = 8
const progressSchema = z.object({
  cdc_attempted: z.boolean().optional(),
  cdc_complete: z.boolean().optional(),
  enumeration_position: z.number().int().positive().optional(),
  enumeration_done: z.boolean().optional(),
})
const runSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string(),
  connection_id: z.string(),
  realm_id: z.string(),
  original_boundary: z.string().nullable(),
  changed_since: z.string(),
  checkpoint: z.string(),
  reasons: z.array(z.string()),
  status: z.enum(["open", "complete"]),
  progress: z.record(z.string(), progressSchema),
  combined_attempted: z.boolean(),
  next_entity: z.number().int().min(0).max(6),
  recovery_phase: z.enum(["enumeration", "mapped"]).default("enumeration"),
  mapped_after: z.string().uuid().nullable(),
  mapped_done: z.boolean(),
  mapped_failure_count: z.number().int().nonnegative().default(0),
  version: z.number().int().nonnegative(),
  lease_token: z.string().uuid().nullable(),
})
type Run = z.infer<typeof runSchema>
export type QboCdcOutcome = {
  scanned: number
  inserted: number
  recoveryRequired: boolean
  deferred: boolean
  runId: string | null
  recoveryReasons: string[]
  currentScanComplete: boolean
}
type Connection = {
  id: string
  org_id: string
  external_account_id: string
  settings: unknown
}
type Service = ReturnType<typeof createServiceSupabaseClient>

function boundary(settings: Record<string, unknown>, start: number, lookback?: number | null) {
  const original = settings.qbo_cdc_last_synced_at
  const text = typeof original === "string" ? original : original === undefined ? null : JSON.stringify(original)
  const canonical = cdcTimestamp(text)
  const parsed = text === null ? start - DAY : canonical ? Date.parse(canonical) : NaN
  const reasons = !Number.isFinite(parsed)
    ? ["invalid_cursor"]
    : parsed > start
      ? ["future_cursor"]
      : parsed < start - 29 * DAY
        ? ["lost_window"]
        : []
  const observation = settings.qbo_cdc_observation_start ?? settings.qbo_cdc_observed_until
  const canonicalObservation = cdcTimestamp(observation)
  const observed = canonicalObservation ? Date.parse(canonicalObservation) : NaN
  const recovering =
    settings.qbo_cdc_recovery &&
    typeof settings.qbo_cdc_recovery === "object" &&
    (settings.qbo_cdc_recovery as Record<string, unknown>).status === "required"
  // Current observation is separate from the historic cursor, and must itself
  // be usable. It never erases the original missing interval.
  const eligible =
    (reasons.length || recovering) && Number.isFinite(observed) && observed <= start
      ? observed
      : Number.isFinite(parsed) && parsed <= start
        ? parsed
        : start - DAY
  const requested = lookback == null ? eligible : Math.min(eligible, start - Math.max(1, lookback) * 60_000)
  return {
    original: text,
    reasons,
    since: new Date(Math.max(requested - OVERLAP, start - 29 * DAY)).toISOString(),
  }
}
function projection(row: CdcRow) {
  return {
    entity_name: row.entity,
    external_id: row.id,
    revision: row.revision,
    document_number: typeof row.record.DocNumber === "string" ? row.record.DocNumber.slice(0, 255) : null,
    transaction_date: typeof row.record.TxnDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.record.TxnDate) ? row.record.TxnDate : null,
    last_updated: row.timestamp,
  }
}
function queue(row: CdcRow, realm: string) {
  return {
    event_id: row.eventId,
    realm_id: realm,
    entity_name: row.entity,
    entity_qbo_id: row.id,
    operation: row.operation,
    last_updated: row.timestamp,
  }
}
function mappedEntity(row: { entity_type: string; metadata?: unknown }): CdcEntity | null {
  const metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {}
  const defaults: Record<string, CdcEntity> = {
    invoice: "Invoice",
    payment: "Payment",
    bill: "Bill",
    bill_payment: "BillPayment",
    vendor_credit: "VendorCredit",
    project_expense: "Purchase",
    purchase: "Purchase",
    journal_entry: "JournalEntry",
  }
  const entity =
    metadata.external_entity_type ??
    (["journal_entry", "client_deposit"].includes(String(metadata.source)) ? "JournalEntry" : defaults[row.entity_type])
  return CDC_ENTITIES.includes(entity as CdcEntity) ? (entity as CdcEntity) : null
}

/** Durable recovery creates review candidates and inbound corrections, never imports money. */
export async function recoverQboCdc(input: {
  connection: Connection
  client: QBOClient
  supabase: Service
  lookbackMinutes?: number | null
}): Promise<QboCdcOutcome> {
  const { connection, client, supabase } = input
  const started = Date.now()
  const deadline = Math.min(started + 85_000, accountingDeliveryDeadline() ?? Infinity)
  const empty: QboCdcOutcome = {
    scanned: 0,
    inserted: 0,
    recoveryRequired: false,
    deferred: true,
    runId: null,
    recoveryReasons: [],
    currentScanComplete: false,
  }
  if (started >= deadline) return empty
  const settings =
    connection.settings && typeof connection.settings === "object" && !Array.isArray(connection.settings)
      ? (connection.settings as Record<string, unknown>)
      : {}
  const scope = {
    p_org_id: connection.org_id,
    p_connection_id: connection.id,
    p_realm_id: connection.external_account_id,
  }
  const initial = boundary(settings, started, input.lookbackMinutes)
  const claim = await supabase.rpc("claim_qbo_cdc_run", {
    ...scope,
    p_original_boundary: initial.original,
    p_changed_since: initial.since,
    p_checkpoint: new Date(started).toISOString(),
    p_reasons: initial.reasons,
  })
  if (claim.error) throw new Error(`Unable to claim CDC recovery: ${claim.error.message}`)
  if (claim.data === null) return empty
  let run = runSchema.parse(claim.data)
  if (
    run.org_id !== connection.org_id ||
    run.connection_id !== connection.id ||
    run.realm_id !== connection.external_account_id ||
    !run.lease_token ||
    Date.parse(run.checkpoint) > started ||
    !Number.isFinite(Date.parse(run.changed_since))
  )
    throw new Error("Invalid CDC run receipt")
  const lease = run.lease_token
  let scanned = 0,
    inserted = 0,
    requests = 0
  let summary: Record<string, unknown> = {}
  let failed = false
  const allowed = () => Date.now() < deadline && requests < MAX_REQUESTS
  async function persist(change: Record<string, unknown>) {
    const expectedIds = new Set<string>()
    for (const key of ["events", "investigations"] as const)
      for (const event of (change[key] as Array<{ event_id: string }> | undefined) ?? []) expectedIds.add(event.event_id)
    for (const item of (change.confirmed_missing as
      | Array<{
          entity_name: string
          entity_qbo_id: string
          mapping_id: string
        }>
      | undefined) ?? [])
      expectedIds.add(`${run.realm_id}:${item.entity_name}:${item.entity_qbo_id}:Delete:confirmed-missing:${run.id}:${item.mapping_id}`)
    const failure = change.failed_mapping as { entity_name: string; entity_qbo_id: string; mapping_id: string } | undefined
    if (failure)
      expectedIds.add(`${run.realm_id}:${failure.entity_name}:${failure.entity_qbo_id}:Update:invalid-read:${run.id}:${failure.mapping_id}`)
    const response = await supabase.rpc("persist_qbo_cdc_progress", {
      ...scope,
      p_run_id: run.id,
      p_lease_token: lease,
      p_expected_version: run.version,
      p_receipt_id: randomUUID(),
      p_change: change,
    })
    if (response.error) throw new Error(`Unable to persist CDC recovery: ${response.error.message}`)
    const result = z
      .object({
        run: runSchema,
        inserted_ids: z.array(z.string()),
        summary: z.record(z.string(), z.unknown()),
      })
      .parse(response.data)
    if (
      result.run.id !== run.id ||
      result.run.org_id !== run.org_id ||
      result.run.connection_id !== run.connection_id ||
      result.run.realm_id !== run.realm_id ||
      result.run.version !== run.version + 1 ||
      new Set(result.inserted_ids).size !== result.inserted_ids.length ||
      result.inserted_ids.some((id) => !expectedIds.has(id))
    )
      throw new Error("Invalid CDC progress receipt")
    run = result.run
    summary = result.summary
    inserted += result.inserted_ids.length
  }
  async function store(rows: CdcRow[], final: Record<string, unknown> = {}, candidates = false) {
    const batches = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
    for (let index = 0; index < batches; index += 1) {
      const batch = rows.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE)
      await persist({
        events: batch.filter((row) => row.timestamp).map((row) => queue(row, run.realm_id)),
        investigations: batch
          .filter((row) => !row.timestamp)
          .map((row) => ({
            ...queue(row, run.realm_id),
            revision: row.revision,
          })),
        ...(candidates
          ? {
              candidates: batch.filter((row) => row.operation !== "Delete").map(projection),
            }
          : {}),
        ...(index === batches - 1 ? final : {}),
      })
    }
  }
  try {
    if (!run.combined_attempted && allowed()) {
      requests += 1
      const payload = await client.changeDataCapture([...CDC_ENTITIES], run.changed_since)
      let combined
      try {
        combined = parseCdcResponse(payload, CDC_ENTITIES, run.realm_id, run.checkpoint)
      } catch {
        await persist({
          reasons: ["malformed_response"],
          combined_attempted: true,
        })
      }
      if (combined) {
        scanned += combined.rawCount
        await store(combined.rows, {
          combined_attempted: true,
          reasons: combined.reasons.filter((reason) => reason !== "saturated"),
          ...(combined.complete
            ? {
                completed_entities: [...CDC_ENTITIES],
                release: run.reasons.length === 0,
              }
            : {}),
        })
      }
    }
    // Rotate entity starts durably; bounded invocations cannot starve late types.
    for (let offset = 0, start = run.next_entity; offset < CDC_ENTITIES.length && run.status === "open" && allowed(); offset += 1) {
      const index = (start + offset) % CDC_ENTITIES.length
      const entity = CDC_ENTITIES[index]
      if (run.progress[entity]?.cdc_attempted) continue
      requests += 1
      const payload = await client.changeDataCapture([entity], run.changed_since)
      let result
      try {
        result = parseCdcResponse(payload, [entity], run.realm_id, run.checkpoint)
      } catch {
        await persist({
          entity,
          progress: { cdc_complete: false, cdc_attempted: true },
          reasons: ["malformed_response"],
          next_entity: (index + 1) % CDC_ENTITIES.length,
        })
        continue
      }
      scanned += result.rawCount
      await store(result.rows, {
        entity,
        progress: { cdc_complete: result.complete, cdc_attempted: true },
        reasons: result.reasons,
        next_entity: (index + 1) % CDC_ENTITIES.length,
      })
    }
    // Offset enumeration is useful recovery evidence, but cannot establish a
    // snapshot or recover historic unmapped deletions. Those gaps remain open.
    for (
      let offset = 0, start = run.next_entity;
      offset < CDC_ENTITIES.length &&
      run.status === "open" &&
      run.reasons.length &&
      (run.mapped_done || run.recovery_phase === "enumeration") &&
      allowed();
      offset += 1
    ) {
      const index = (start + offset) % CDC_ENTITIES.length
      const entity = CDC_ENTITIES[index]
      const progress = run.progress[entity] ?? {}
      if (progress.enumeration_done) continue
      requests += 1
      const position = progress.enumeration_position ?? 1
      let page, rows
      try {
        page = await client.queryRecoveryPage(entity, position, PAGE_SIZE)
        rows = page.rows.map((row) => cdcRow(entity, row, run.realm_id))
      } catch (error) {
        if (!isCdcResponseError(error)) throw error
        await persist({
          reasons: ["malformed_response"],
          next_entity: (index + 1) % CDC_ENTITIES.length,
          recovery_phase: "mapped",
        })
        continue
      }
      scanned += rows.length
      await store(
        rows,
        {
          entity,
          progress: {
            enumeration_position: position + rows.length,
            enumeration_done: page.done,
          },
          reasons: [
            "offset_scan_not_snapshot",
            "historic_unmapped_deletions",
            ...(rows.some((row) => !row.timestamp) ? ["ambiguous_timestamp"] : []),
          ],
          next_entity: (index + 1) % CDC_ENTITIES.length,
          recovery_phase: "mapped",
        },
        true,
      )
    }
    if (run.status === "open" && run.reasons.length && !run.mapped_done && allowed()) {
      let query = supabase
        .from("accounting_sync_records")
        .select("id, entity_type, external_id, metadata")
        .eq("org_id", connection.org_id)
        .eq("connection_id", connection.id)
        .eq("provider", "qbo")
        .in("entity_type", ["invoice", "payment", "project_expense", "purchase", "bill", "bill_payment", "vendor_credit", "journal_entry"])
        .neq("external_id", "")
        .order("id")
        .limit(10)
      if (run.mapped_after) query = query.gt("id", run.mapped_after)
      const mappings = await query
      if (mappings.error) throw new Error(`Unable to load CDC recovery identities: ${mappings.error.message}`)
      const rows = z
        .array(
          z.object({
            id: z.string().uuid(),
            entity_type: z.string(),
            external_id: z.string(),
            metadata: z.unknown(),
          }),
        )
        .parse(mappings.data ?? [])
      for (const mapping of rows) {
        if (!allowed()) break
        const entity = mappedEntity(mapping)
        if (!entity) {
          await persist({
            recovery_phase: "enumeration",
            mapped_after: mapping.id,
            reasons: ["unclassified_mapping"],
          })
          continue
        }
        requests += 1
        let remote, row
        try {
          remote = await client.readRecoveryEntity(entity, mapping.external_id)
          if (remote) row = cdcRow(entity, remote, run.realm_id)
        } catch (error) {
          if (!isCdcResponseError(error)) throw error
          await persist({
            failed_mapping: {
              mapping_id: mapping.id,
              entity_name: entity,
              entity_qbo_id: mapping.external_id,
              reason: "malformed_read",
            },
            recovery_phase: "enumeration",
            mapped_after: mapping.id,
            reasons: ["malformed_response"],
          })
          continue
        }
        if (row) {
          scanned += 1
          await store([row], {
            recovery_phase: "enumeration",
            mapped_after: mapping.id,
            reasons: row.timestamp ? [] : ["ambiguous_timestamp"],
          })
        } else {
          await persist({
            confirmed_missing: [
              {
                mapping_id: mapping.id,
                entity_name: entity,
                entity_qbo_id: mapping.external_id,
              },
            ],
            recovery_phase: "enumeration",
            mapped_after: mapping.id,
          })
        }
      }
      if (!rows.length) await persist({ mapped_done: true, recovery_phase: "enumeration" })
    }
  } catch (error) {
    failed = true
    // A malformed provider result must remain visible even when there are no
    // usable rows. Storage failures never produce falsely successful progress.
    if (Date.now() < deadline && isCdcResponseError(error)) {
      await persist({ reasons: ["malformed_response"], release: true })
    }
    throw error
  } finally {
    if (!failed && run.status === "open" && run.lease_token) {
      const release = () => persist({ release: true })
      if (Date.now() >= deadline) await withWorkerDatabasePersistence(workerPersistenceDeadline(), release)
      else await release()
    }
  }
  const currentScanComplete =
    run.mapped_failure_count === 0 &&
    !run.reasons.includes("unclassified_mapping") &&
    CDC_ENTITIES.every((entity) => run.progress[entity]?.enumeration_done) &&
    run.mapped_done
  return {
    scanned,
    inserted,
    recoveryRequired: run.reasons.length > 0,
    deferred: run.status === "open" && !currentScanComplete,
    runId: run.id,
    recoveryReasons: run.reasons,
    currentScanComplete: summary.status === "complete" || currentScanComplete,
  }
}
