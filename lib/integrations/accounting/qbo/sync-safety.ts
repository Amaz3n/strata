import { logQBO } from "@/lib/services/accounting-logger"

export const QBO_DELETED_REVIEW_MESSAGE = "Deleted in QuickBooks — resync manually to recreate."

type QBOUpdatableEntityType = "purchase" | "bill" | "invoice"
type QBOEntityReader = {
  getPurchaseById(id: string): Promise<{ Id?: string; SyncToken?: string } | null>
  getBillById(id: string): Promise<{ Id?: string; SyncToken?: string } | null>
  getInvoiceById(id: string): Promise<{ Id?: string; SyncToken?: string } | null>
}

export function isStaleObjectError(error: unknown) {
  const candidate = error as { faultCode?: string | null; qboError?: unknown }
  const detail = JSON.stringify(candidate?.qboError ?? error ?? {}).toLowerCase()
  return candidate?.faultCode === "5010" || detail.includes("stale object")
}

function fetchQBOEntityById(client: QBOEntityReader, entityType: QBOUpdatableEntityType, externalId: string) {
  if (entityType === "purchase") return client.getPurchaseById(externalId)
  if (entityType === "bill") return client.getBillById(externalId)
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
