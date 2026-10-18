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

export class IntuitWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IntuitWebhookPayloadError"
  }
}

export type IntuitWebhookEntityEvent = {
  eventId: string
  realmId: string
  entityName: string
  entityId: string
  operation: string
  lastUpdated: string
  providerEventId?: string
}

// Explicit provider spellings keep multiword names compatible with CDC IDs.
const ENTITY_NAMES: Readonly<Record<string, string>> = {
  account: "Account", bill: "Bill", billpayment: "BillPayment", budget: "Budget",
  class: "Class", creditmemo: "CreditMemo", currency: "Currency", customer: "Customer", department: "Department",
  deposit: "Deposit", employee: "Employee", estimate: "Estimate", invoice: "Invoice",
  item: "Item", journalcode: "JournalCode", journalentry: "JournalEntry", payment: "Payment", paymentmethod: "PaymentMethod",
  preferences: "Preferences", purchase: "Purchase", purchaseorder: "PurchaseOrder", refundreceipt: "RefundReceipt",
  salesreceipt: "SalesReceipt", taxagency: "TaxAgency", term: "Term", timeactivity: "TimeActivity",
  transfer: "Transfer", vendor: "Vendor", vendorcredit: "VendorCredit",
}
const OPERATIONS: Readonly<Record<string, string>> = {
  create: "Create", created: "Create", update: "Update", updated: "Update",
  delete: "Delete", deleted: "Delete", merge: "Merge", merged: "Merge",
  void: "Void", voided: "Void", emailed: "Emailed",
}

/** ISO-normalize provider instants; CDC's missing-time sentinel remains unchanged. */
export function normalizeEventTimestamp(raw: string): string {
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  const iso = parsed.toISOString()
  // Date retains milliseconds only. Preserve finer provider precision in replay
  // IDs so distinct changes do not collapse into one queue entry.
  const fraction = raw.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i)?.[1]
  if (!fraction || fraction.length <= 3) return iso
  const precision = fraction.replace(/0+$/, "").padEnd(3, "0")
  return iso.replace(/\.\d{3}Z$/, `.${precision}Z`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new IntuitWebhookPayloadError(`Invalid ${field}`)
  }
  return value
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || /[:\s\x00-\x1f\x7f]/.test(value)) {
    throw new IntuitWebhookPayloadError(`Invalid ${field}`)
  }
  return value
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") throw new IntuitWebhookPayloadError("Invalid event timestamp")
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  if (!parts) throw new IntuitWebhookPayloadError("Invalid event timestamp")
  const [, year, month, day, hour, minute, second, zone] = parts
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) ||
      !Number.isFinite(Date.parse(value))) {
    throw new IntuitWebhookPayloadError("Invalid event timestamp")
  }
  return normalizeEventTimestamp(value)
}

function entityEvent(input: {
  realmId: unknown; entityId: unknown; entityName: unknown; operation: unknown; time: unknown; providerEventId?: unknown
}): IntuitWebhookEntityEvent {
  const realmId = identity(input.realmId, "realm ID")
  const entityId = identity(input.entityId, "entity ID")
  const name = identity(input.entityName, "entity name")
  const entityName = Object.prototype.hasOwnProperty.call(ENTITY_NAMES, name.toLowerCase()) ? ENTITY_NAMES[name.toLowerCase()] : undefined
  const operationKey = typeof input.operation === "string" ? input.operation.toLowerCase() : ""
  const operation = Object.prototype.hasOwnProperty.call(OPERATIONS, operationKey) ? OPERATIONS[operationKey] : undefined
  if (!entityName || !operation) throw new IntuitWebhookPayloadError("Unsupported entity or operation")
  const lastUpdated = timestamp(input.time)
  return {
    eventId: `${realmId}:${entityName}:${entityId}:${operation}:${lastUpdated}`,
    realmId, entityName, entityId, operation, lastUpdated,
    ...(input.providerEventId === undefined ? {} : { providerEventId: identity(input.providerEventId, "provider event ID") }),
  }
}

export function extractIntuitEventIds(payload: unknown): string[] {
  return extractIntuitEntityEvents(payload).map((event) => event.eventId)
}

export function extractIntuitEntityEvents(payload: unknown): IntuitWebhookEntityEvent[] {
  if (Array.isArray(payload)) {
    return payload.map((value) => {
      const event = record(value, "CloudEvent")
      const type = typeof event.type === "string" ? event.type.match(/^qbo\.([a-z]+)\.(created|updated|deleted|merged|voided|emailed)\.v1$/) : null
      if (!type || event.specversion !== "1.0") {
        throw new IntuitWebhookPayloadError("Unsupported CloudEvent type or version")
      }
      return entityEvent({
        realmId: event.intuitaccountid, entityId: event.intuitentityid,
        entityName: type[1], operation: type[2], time: event.time,
        providerEventId: identity(event.id, "provider event ID"),
      })
    })
  }

  const envelope = record(payload, "webhook envelope")
  if (!Array.isArray(envelope.eventNotifications)) throw new IntuitWebhookPayloadError("Unsupported webhook envelope")
  return envelope.eventNotifications.flatMap((value) => {
    const notification = record(value, "notification")
    const realmId = identity(notification.realmId, "realm ID")
    const change = record(notification.dataChangeEvent, "data change event")
    if (!Array.isArray(change.entities)) throw new IntuitWebhookPayloadError("Invalid notification entities")
    return change.entities.map((value) => {
      const entity = record(value, "entity")
      return entityEvent({ realmId, entityId: entity.id, entityName: entity.name, operation: entity.operation, time: entity.lastUpdated })
    })
  })
}
