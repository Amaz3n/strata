import { createHash } from "crypto"
import { extractIntuitEntityEvents } from "@/lib/integrations/accounting/qbo/webhook"

/** Provider response validation errors may rotate recovery; transport/auth errors may not. */
export class CdcResponseError extends Error {
  readonly code = "QBO_CDC_RESPONSE_INVALID"
}
export function isCdcResponseError(error: unknown): error is CdcResponseError {
  return error instanceof Error && (error as CdcResponseError).code === "QBO_CDC_RESPONSE_INVALID"
}

export const CDC_ENTITIES = ["Invoice", "Payment", "Purchase", "Bill", "BillPayment", "VendorCredit", "JournalEntry"] as const
export type CdcEntity = (typeof CDC_ENTITIES)[number]
export const CDC_CAP = 1000
export type CdcRow = {
  entity: CdcEntity
  id: string
  operation: "Update" | "Delete"
  timestamp: string | null
  revision: string
  eventId: string
  record: Record<string, unknown>
}
export type CdcResult = {
  rows: CdcRow[]
  rawCount: number
  complete: boolean
  reasons: string[]
}

export function cdcRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CdcResponseError(`Invalid QBO ${label}`)
  return value as Record<string, unknown>
}
export function cdcIdentity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 255 || /[:\s\x00-\x1f\x7f]/.test(value))
    throw new CdcResponseError("Invalid QBO CDC identity")
  return value
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    )
  return value
}
export function cdcTimestamp(value: unknown): string | null {
  try {
    return extractIntuitEntityEvents({
      eventNotifications: [
        {
          realmId: "validation",
          dataChangeEvent: {
            entities: [
              {
                name: "Invoice",
                id: "validation",
                operation: "Update",
                lastUpdated: value,
              },
            ],
          },
        },
      ],
    })[0].lastUpdated
  } catch {
    return null
  }
}
export function cdcRow(entity: CdcEntity, value: unknown, realm: string): CdcRow {
  const record = cdcRecord(value, "entity")
  const id = cdcIdentity(record.Id)
  const operation = record.status === "Deleted" ? "Delete" : "Update"
  if (record.status !== undefined && record.status !== "Deleted" && record.status !== "Active")
    throw new CdcResponseError("Invalid QBO CDC status")
  const metadata = record.MetaData === undefined ? {} : cdcRecord(record.MetaData, "metadata")
  // Unusable time remains investigation evidence, never a current-time substitute.
  const timestamp = cdcTimestamp(metadata.LastUpdatedTime)
  const revision = createHash("sha256")
    .update(
      typeof record.SyncToken === "string" && record.SyncToken.trim()
        ? `version:${record.SyncToken}`
        : timestamp
          ? `time:${timestamp}`
          : JSON.stringify(stable(record)),
    )
    .digest("hex")
  return {
    entity,
    id,
    operation,
    timestamp,
    revision,
    eventId: `${realm}:${entity}:${id}:${operation}:${timestamp ?? `unknown-time:${revision}`}`,
    record,
  }
}
function hint(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new CdcResponseError(`Invalid QBO ${label}`)
  return value
}

/** CDC has no supported offset pagination. Count raw objects before deduplication. */
export function parseCdcResponse(payload: unknown, entities: readonly CdcEntity[], realm: string, checkpoint: string): CdcResult {
  const envelope = cdcRecord(payload, "CDC envelope")
  if (
    envelope.Fault !== undefined ||
    Object.keys(envelope).some((key) => !["CDCResponse", "time"].includes(key)) ||
    !Array.isArray(envelope.CDCResponse) ||
    !envelope.CDCResponse.length
  )
    throw new CdcResponseError("Invalid QBO CDC envelope or fault")
  const rows: CdcRow[] = []
  const reasons = new Set<string>()
  let rawCount = 0
  for (const value of envelope.CDCResponse) {
    const group = cdcRecord(value, "CDC response group")
    if (group.Fault !== undefined || Object.keys(group).some((key) => !["Fault", "QueryResponse", "size"].includes(key)))
      throw new CdcResponseError("QBO CDC response fault or unsupported member")
    hint(group.size, "CDC size")
    // The SDK schema permits a response group with no QueryResponse members.
    if (group.QueryResponse === undefined) {
      if (Object.keys(group).some((key) => key !== "size") || (group.size !== undefined && group.size !== 0))
        throw new CdcResponseError("Invalid empty QBO CDC response")
      continue
    }
    if (!Array.isArray(group.QueryResponse)) throw new CdcResponseError("Invalid QBO CDC query responses")
    const before = rawCount
    for (const value of group.QueryResponse) {
      const query = cdcRecord(value, "CDC query response")
      if (query.Fault !== undefined) throw new CdcResponseError("QBO CDC query fault")
      if (Object.keys(query).some((key) => ![...entities, "startPosition", "maxResults", "totalCount"].includes(key)))
        throw new CdcResponseError("Unsupported QBO CDC response member")
      let count = 0
      for (const entity of entities) {
        if (query[entity] === undefined) continue
        if (!Array.isArray(query[entity])) throw new CdcResponseError("Invalid QBO CDC entity array")
        for (const item of query[entity]) {
          rows.push(cdcRow(entity, item, realm))
          count += 1
        }
      }
      rawCount += count
      const start = hint(query.startPosition, "CDC start position")
      const maximum = hint(query.maxResults, "CDC maximum")
      const total = hint(query.totalCount, "CDC count")
      if ((start !== undefined && start !== 1) || (maximum !== undefined && maximum !== count) || (total !== undefined && total !== count))
        reasons.add("contradictory_count")
    }
    // Size has no documented cardinality formula; positive/empty is ambiguous.
    if (group.size !== undefined && group.size !== 0 && rawCount === before) reasons.add("contradictory_count")
  }
  if (rawCount >= CDC_CAP) reasons.add("saturated")
  for (const row of rows) {
    if (!row.timestamp) reasons.add("ambiguous_timestamp")
    else if (Date.parse(row.timestamp) > Math.max(Date.parse(checkpoint), Date.now()) + 5 * 60_000) reasons.add("future_entity_timestamp")
  }
  return {
    rows,
    rawCount,
    complete: reasons.size === 0,
    reasons: [...reasons],
  }
}

export type RecoveryPage = {
  rows: Record<string, unknown>[]
  done: boolean
  total: number | null
}
/** Validates a query page, but deliberately makes no snapshot guarantee. */
export function parseRecoveryPage(payload: unknown, entity: CdcEntity, start: number, limit: number): RecoveryPage {
  const envelope = cdcRecord(payload, "recovery query envelope")
  if (envelope.Fault !== undefined || Object.keys(envelope).some((key) => !["QueryResponse", "time"].includes(key)))
    throw new CdcResponseError("QBO recovery query fault or unsupported envelope member")
  const query = cdcRecord(envelope.QueryResponse, "recovery query response")
  if (query.Fault !== undefined || Object.keys(query).some((key) => ![entity, "startPosition", "maxResults", "totalCount"].includes(key)))
    throw new CdcResponseError("Invalid QBO recovery query response")
  const value = query[entity] ?? []
  if (!Array.isArray(value) || value.length > limit) throw new CdcResponseError("Invalid QBO recovery page")
  const rows = value.map((item) => cdcRecord(item, "recovery entity"))
  const ids = rows.map((row) => cdcIdentity(row.Id))
  if (new Set(ids).size !== ids.length) throw new CdcResponseError("Duplicate QBO recovery page identity")
  const position = hint(query.startPosition, "recovery start position")
  const maximum = hint(query.maxResults, "recovery maximum")
  const total = hint(query.totalCount, "recovery total")
  if (
    (position !== undefined && position !== start) ||
    (maximum !== undefined && maximum !== rows.length) ||
    (total !== undefined && total < start - 1 + rows.length) ||
    (rows.length < limit && total !== undefined && total > start - 1 + rows.length)
  )
    throw new CdcResponseError("Contradictory QBO recovery page count")
  return { rows, done: rows.length < limit, total: total ?? null }
}
