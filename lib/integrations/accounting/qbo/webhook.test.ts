// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import {
  computeIntuitWebhookSignature,
  extractIntuitEntityEvents,
  extractIntuitEventIds,
  normalizeEventTimestamp,
  verifyIntuitWebhookSignature,
} from "@/lib/integrations/accounting/qbo/webhook"

describe("verifyIntuitWebhookSignature", () => {
  it("accepts valid signatures", () => {
    const payload = JSON.stringify({ test: true })
    const token = "secret-token"
    const signature = computeIntuitWebhookSignature(payload, token)
    expect(verifyIntuitWebhookSignature({ payload, signatureHeader: signature, verifierToken: token })).toBe(true)
  })

  it("rejects invalid signatures", () => {
    const payload = JSON.stringify({ test: true })
    expect(verifyIntuitWebhookSignature({ payload, signatureHeader: "bad", verifierToken: "token" })).toBe(false)
  })
})

describe("extractIntuitEventIds", () => {
  it("extracts deterministic replay ids from Intuit payload", () => {
    const ids = extractIntuitEventIds({
      eventNotifications: [
        {
          realmId: "12345",
          dataChangeEvent: {
            entities: [{ name: "Payment", id: "99", operation: "Update", lastUpdated: "2026-02-12T00:00:00Z" }],
          },
        },
      ],
    })

    expect(ids).toEqual(["12345:Payment:99:Update:2026-02-12T00:00:00.000Z"])
  })
})

describe("normalizeEventTimestamp", () => {
  it("normalizes the offset form and the Z form of one instant identically", () => {
    expect(normalizeEventTimestamp("2026-02-12T09:30:00-05:00")).toBe(normalizeEventTimestamp("2026-02-12T14:30:00Z"))
    expect(normalizeEventTimestamp("2026-02-12T09:30:00-05:00")).toBe("2026-02-12T14:30:00.000Z")
  })

  it("keeps sub-second precision distinct", () => {
    expect(normalizeEventTimestamp("2026-02-12T14:30:00.250Z")).toBe("2026-02-12T14:30:00.250Z")
  })

  it("passes unparseable timestamps through untouched", () => {
    expect(normalizeEventTimestamp("unknown-time")).toBe("unknown-time")
    expect(normalizeEventTimestamp("")).toBe("")
    expect(normalizeEventTimestamp("not a date at all")).toBe("not a date at all")
  })
})

const notification = (lastUpdated: string) => ({
  eventNotifications: [
    {
      realmId: "12345",
      dataChangeEvent: {
        entities: [{ name: "Invoice", id: "77", operation: "Update", lastUpdated }],
      },
    },
  ],
})

describe("extractIntuitEntityEvents", () => {
  it("mints the same eventId whether the instant arrives in offset form or Z form", () => {
    // Webhook payloads carry the offset form, CDC metadata the Z form. Dedupe
    // across the two feeds only works if both mint one id for one change.
    const [offsetEvent] = extractIntuitEntityEvents(notification("2026-02-12T09:30:00-05:00"))
    const [zEvent] = extractIntuitEntityEvents(notification("2026-02-12T14:30:00Z"))

    expect(offsetEvent.eventId).toBe(zEvent.eventId)
    expect(offsetEvent.eventId).toBe("12345:Invoice:77:Update:2026-02-12T14:30:00.000Z")
  })

  it("preserves the raw lastUpdated alongside the normalized id", () => {
    const [event] = extractIntuitEntityEvents(notification("2026-02-12T09:30:00-05:00"))
    expect(event.lastUpdated).toBe("2026-02-12T09:30:00-05:00")
    expect(event).toMatchObject({ realmId: "12345", entityName: "Invoice", entityId: "77", operation: "Update" })
  })

  it("gives different changes to the same entity different ids", () => {
    const [first] = extractIntuitEntityEvents(notification("2026-02-12T14:30:00Z"))
    const [second] = extractIntuitEntityEvents(notification("2026-02-12T14:31:00Z"))
    expect(first.eventId).not.toBe(second.eventId)
  })

  it("substitutes placeholders for a missing realmId and missing entity fields", () => {
    const events = extractIntuitEntityEvents({
      eventNotifications: [{ dataChangeEvent: { entities: [{}] } }],
    })

    expect(events).toEqual([
      {
        eventId: "unknown-realm:unknown-entity:unknown-id:unknown-op:unknown-time",
        realmId: "unknown-realm",
        entityName: "unknown-entity",
        entityId: "unknown-id",
        operation: "unknown-op",
        lastUpdated: "unknown-time",
      },
    ])
  })

  it("leaves the unknown-time placeholder unparsed rather than turning it into a date", () => {
    const [event] = extractIntuitEntityEvents({
      eventNotifications: [{ realmId: "1", dataChangeEvent: { entities: [{ id: "2", name: "Bill", operation: "Delete" }] } }],
    })
    expect(event.eventId).toBe("1:Bill:2:Delete:unknown-time")
  })

  it("returns nothing for payloads with no notifications or no entities", () => {
    expect(extractIntuitEntityEvents({})).toEqual([])
    expect(extractIntuitEntityEvents(null)).toEqual([])
    expect(extractIntuitEntityEvents({ eventNotifications: [{ realmId: "1" }] })).toEqual([])
    expect(extractIntuitEntityEvents({ eventNotifications: [{ realmId: "1", dataChangeEvent: {} }] })).toEqual([])
  })

  it("flattens every entity across every notification", () => {
    const ids = extractIntuitEventIds({
      eventNotifications: [
        { realmId: "a", dataChangeEvent: { entities: [{ name: "Invoice", id: "1", operation: "Create", lastUpdated: "2026-02-12T00:00:00Z" }] } },
        {
          realmId: "b",
          dataChangeEvent: {
            entities: [
              { name: "Bill", id: "2", operation: "Update", lastUpdated: "2026-02-12T00:00:00Z" },
              { name: "Payment", id: "3", operation: "Delete", lastUpdated: "2026-02-12T00:00:00Z" },
            ],
          },
        },
      ],
    })

    expect(ids).toEqual([
      "a:Invoice:1:Create:2026-02-12T00:00:00.000Z",
      "b:Bill:2:Update:2026-02-12T00:00:00.000Z",
      "b:Payment:3:Delete:2026-02-12T00:00:00.000Z",
    ])
  })
})
