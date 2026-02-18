import { createHmac } from "crypto"

export function computeIntuitWebhookSignature(payload: string, verifierToken: string): string {
  return createHmac("sha256", verifierToken).update(payload, "utf8").digest("base64")
}

export function verifyIntuitWebhookSignature(input: {
  payload: string
  signatureHeader: string | null
  verifierToken?: string
}) {
  if (!input.signatureHeader || !input.verifierToken) return false
  const expected = computeIntuitWebhookSignature(input.payload, input.verifierToken)
  return expected === input.signatureHeader.trim()
}

type IntuitEntity = {
  id?: string
  name?: string
  operation?: string
  lastUpdated?: string
}

type IntuitNotification = {
  realmId?: string
  dataChangeEvent?: {
    entities?: IntuitEntity[]
  }
}

export type IntuitWebhookEntityEvent = {
  eventId: string
  realmId: string
  entityName: string
  entityId: string
  operation: string
  lastUpdated: string
}

export function extractIntuitEventIds(payload: unknown): string[] {
  return extractIntuitEntityEvents(payload).map((event) => event.eventId)
}

export function extractIntuitEntityEvents(payload: unknown): IntuitWebhookEntityEvent[] {
  const notifications = ((payload as any)?.eventNotifications ?? []) as IntuitNotification[]
  const events: IntuitWebhookEntityEvent[] = []

  for (const notification of notifications) {
    const realmId = notification.realmId ?? "unknown-realm"
    const entities = notification.dataChangeEvent?.entities ?? []
    for (const entity of entities) {
      const entityId = entity.id ?? "unknown-id"
      const entityName = entity.name ?? "unknown-entity"
      const operation = entity.operation ?? "unknown-op"
      const lastUpdated = entity.lastUpdated ?? "unknown-time"
      events.push({
        eventId: `${realmId}:${entityName}:${entityId}:${operation}:${lastUpdated}`,
        realmId,
        entityName,
        entityId,
        operation,
        lastUpdated,
      })
    }
  }

  return events
}
