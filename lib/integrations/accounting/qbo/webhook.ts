import { createHmac, timingSafeEqual } from "crypto"

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
  const received = input.signatureHeader.trim()
  const expectedBuffer = Buffer.from(expected, "base64")
  const receivedBuffer = Buffer.from(received, "base64")
  if (expectedBuffer.length !== receivedBuffer.length) return false
  return timingSafeEqual(expectedBuffer, receivedBuffer)
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

/** ISO-normalize a provider timestamp, or pass it through when unparseable. */
export function normalizeEventTimestamp(raw: string): string {
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString()
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
      // The timestamp inside the event id is NORMALIZED to ISO. Intuit writes
      // the same instant differently in webhook payloads (offset form) and CDC
      // metadata (Z form); dedupe across the two feeds only works if both mint
      // the same id for the same change.
      const idTimestamp = lastUpdated === "unknown-time" ? lastUpdated : normalizeEventTimestamp(lastUpdated)
      events.push({
        eventId: `${realmId}:${entityName}:${entityId}:${operation}:${idTimestamp}`,
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
