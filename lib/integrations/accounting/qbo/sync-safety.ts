import { logQBO } from "@/lib/services/accounting-logger"

export const QBO_DELETED_REVIEW_MESSAGE = "Deleted in QuickBooks — resync manually to recreate."

type QBOUpdatableEntityType = "purchase" | "bill" | "invoice" | "vendor_credit"
type QBOEntityReader = {
  getPurchaseById(id: string): Promise<{ Id?: string; SyncToken?: string } | null>
  getBillById(id: string): Promise<{ Id?: string; SyncToken?: string } | null>
  getInvoiceById(id: string): Promise<{ Id?: string; SyncToken?: string } | null>
  getVendorCreditById(id: string): Promise<{ Id?: string; SyncToken?: string } | null>
}

/**
 * The token Arc stamps into a created transaction's PrivateNote so it can
 * recognise its own work later.
 *
 * QuickBooks accepts no idempotency key, so "did my create actually land?" can
 * only be answered by looking. A lost response near the function timeout used to
 * mean the +15m retry created a SECOND payment in the customer's books, with
 * nothing in Arc able to detect it: duplicate suppression was the sync record's
 * external id, and the sync record is exactly what a lost response fails to
 * write. Anything money-moving that Arc creates carries this marker.
 */
export function arcTransactionMarker(entityType: string, entityId: string) {
  return `[arc:${entityType}:${entityId}]`
}

/** PrivateNote text carrying the marker without discarding a user's own note. */
export function withArcTransactionMarker(note: string | null | undefined, entityType: string, entityId: string) {
  const marker = arcTransactionMarker(entityType, entityId)
  const existing = String(note ?? "").trim()
  return existing.length > 0 ? `${existing} ${marker}` : marker
}

type QBOTransactionFinder = {
  findTransactionByPrivateNote(
    entity: "Payment" | "BillPayment",
    marker: string,
    opts?: { sinceDate?: string | null },
  ): Promise<{ Id?: string } | null>
}

/**
 * The object a previous attempt may already have created, or null.
 *
 * Called only when Arc has evidence of a prior attempt (a sync record exists for
 * the entity but carries no external id), so the happy path pays nothing for it.
 * The search window is generous rather than exact — a retry can be minutes or,
 * after a manual resync, weeks later — because the marker is unique and a wider
 * window only costs one query.
 */
export async function findAlreadyCreatedQBOTransaction(params: {
  client: QBOTransactionFinder
  entity: "Payment" | "BillPayment"
  entityType: string
  entityId: string
  windowDays?: number
  logContext?: Record<string, unknown>
}): Promise<string | null> {
  const windowDays = params.windowDays ?? 120
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const marker = arcTransactionMarker(params.entityType, params.entityId)
  try {
    const found = await params.client.findTransactionByPrivateNote(params.entity, marker, { sinceDate: since })
    if (!found?.Id) return null
    logQBO("warn", "qbo_create_adopted_existing", {
      entity: params.entity,
      entityId: params.entityId,
      qboId: String(found.Id),
      ...params.logContext,
    })
    return String(found.Id)
  } catch (error) {
    // A failed lookup must not block the push: it degrades to the old behaviour,
    // it does not invent one. The create below is still guarded by the sync
    // record, and the outbox will retry.
    logQBO("warn", "qbo_create_adoption_lookup_failed", {
      entity: params.entity,
      entityId: params.entityId,
      error: error instanceof Error ? error.message : String(error),
      ...params.logContext,
    })
    return null
  }
}

export function isStaleObjectError(error: unknown) {
  const candidate = error as { faultCode?: string | null; qboError?: unknown }
  const detail = JSON.stringify(candidate?.qboError ?? error ?? {}).toLowerCase()
  return candidate?.faultCode === "5010" || detail.includes("stale object")
}

function fetchQBOEntityById(client: QBOEntityReader, entityType: QBOUpdatableEntityType, externalId: string) {
  if (entityType === "purchase") return client.getPurchaseById(externalId)
  if (entityType === "bill") return client.getBillById(externalId)
  if (entityType === "vendor_credit") return client.getVendorCreditById(externalId)
  return client.getInvoiceById(externalId)
}

export async function resolveQBOSyncTarget(params: {
  client: QBOEntityReader
  entityType: QBOUpdatableEntityType
  qboId?: string | null
  cachedSyncToken?: string | null
  logContext?: Record<string, unknown>
  allowRecreateDeleted?: boolean
}): Promise<{ mode: "create" } | { mode: "update"; id: string; syncToken: string }> {
  const qboId = params.qboId?.toString().trim() || undefined
  if (!qboId) return { mode: "create" }
  const cachedToken = params.cachedSyncToken?.toString().trim() || undefined
  if (cachedToken) return { mode: "update", id: qboId, syncToken: cachedToken }

  const latest = await fetchQBOEntityById(params.client, params.entityType, qboId)
  if (!latest) {
    if (!params.allowRecreateDeleted) {
      logQBO("warn", "qbo_entity_deleted_needs_review", { entityType: params.entityType, qboId, ...params.logContext })
      throw new Error(QBO_DELETED_REVIEW_MESSAGE)
    }
    logQBO("warn", "qbo_entity_recreated_after_delete", { entityType: params.entityType, qboId, ...params.logContext })
    return { mode: "create" }
  }
  if (!latest.SyncToken) throw new Error(`Unable to resolve QuickBooks ${params.entityType} sync token`)
  return { mode: "update", id: qboId, syncToken: latest.SyncToken }
}

export async function createOrUpdateQBOEntity<T extends Record<string, any>>(params: {
  client: QBOEntityReader
  entityType: QBOUpdatableEntityType
  qboId?: string | null
  cachedSyncToken?: string | null
  payload: T
  create: (payload: T) => Promise<any>
  update: (payload: T & { Id: string; SyncToken: string }) => Promise<any>
  logContext?: Record<string, unknown>
}): Promise<any> {
  const target = await resolveQBOSyncTarget(params)
  if (target.mode === "create") return params.create(params.payload)
  try {
    return await params.update({ ...params.payload, Id: target.id, SyncToken: target.syncToken })
  } catch (error) {
    if (!isStaleObjectError(error)) throw error
    const latest = await fetchQBOEntityById(params.client, params.entityType, target.id)
    if (!latest?.SyncToken) throw new Error(`Unable to refresh QuickBooks ${params.entityType} sync token`)
    logQBO("warn", "qbo_entity_stale_token_retried", { entityType: params.entityType, qboId: target.id, ...params.logContext })
    return params.update({ ...params.payload, Id: target.id, SyncToken: latest.SyncToken })
  }
}
