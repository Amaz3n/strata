import { AccountingDeliveryError } from "@/lib/services/accounting-delivery"
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
 * Existing Arc writes do not persist an operation-scoped QuickBooks requestid,
 * so historical unknown create outcomes must be recovered by looking. A lost response near the function timeout used to
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

type QBOAdoptableEntity = "Payment" | "BillPayment" | "Invoice" | "Bill" | "Purchase" | "VendorCredit" | "JournalEntry"

type QBOTransactionFinder = {
  findTransactionByPrivateNote(
    entity: QBOAdoptableEntity,
    marker: string,
  ): Promise<{ Id?: string } | null>
}

/**
 * The object a previous attempt may already have created, or null.
 *
 * Called only when Arc has evidence of a prior attempt (a sync record exists for
 * the entity but carries no external id), so the happy path pays nothing for it.
 * Search the complete company history: a backdated transaction can be much older
 * than the attempt that created it. Failed or incomplete searches block creation.
 */
export async function findAlreadyCreatedQBOTransaction(params: {
  client: QBOTransactionFinder
  entity: QBOAdoptableEntity
  entityType: string
  entityId: string
  logContext?: Record<string, unknown>
}): Promise<string | null> {
  const marker = arcTransactionMarker(params.entityType, params.entityId)
  try {
    const found = await params.client.findTransactionByPrivateNote(params.entity, marker)
    if (found === null) return null
    if (!found?.Id?.toString().trim()) {
      throw new AccountingDeliveryError("QuickBooks recovery match has no transaction identity", true, "invalid_recovery_response")
    }
    logQBO("warn", "qbo_create_adopted_existing", {
      entity: params.entity,
      entityId: params.entityId,
      qboId: String(found.Id),
      ...params.logContext,
    })
    return String(found.Id)
  } catch (error) {
    // Preserve the provider error classification; an uncertain lookup is never
    // evidence that the previous create failed.
    logQBO("warn", "qbo_create_adoption_lookup_failed", {
      entity: params.entity,
      entityId: params.entityId,
      error: error instanceof Error ? error.message : String(error),
      ...params.logContext,
    })
    throw error
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
