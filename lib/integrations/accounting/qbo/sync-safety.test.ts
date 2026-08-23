// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import {
  QBO_DELETED_REVIEW_MESSAGE,
  arcTransactionMarker,
  findAlreadyCreatedQBOTransaction,
  isStaleObjectError,
  resolveQBOSyncTarget,
  withArcTransactionMarker,
} from "@/lib/integrations/accounting/qbo/sync-safety"

describe("arcTransactionMarker", () => {
  it("is deterministic and unique per entity", () => {
    expect(arcTransactionMarker("invoice", "abc-123")).toBe("[arc:invoice:abc-123]")
    expect(arcTransactionMarker("invoice", "abc-123")).toBe(arcTransactionMarker("invoice", "abc-123"))
    expect(arcTransactionMarker("payment", "abc-123")).not.toBe(arcTransactionMarker("invoice", "abc-123"))
  })
})

describe("withArcTransactionMarker", () => {
  it("preserves a user's own note and appends the marker", () => {
    expect(withArcTransactionMarker("Retainage release", "payment", "p1")).toBe("Retainage release [arc:payment:p1]")
  })

  it("uses the marker alone when there is no note", () => {
    expect(withArcTransactionMarker(null, "payment", "p1")).toBe("[arc:payment:p1]")
    expect(withArcTransactionMarker(undefined, "payment", "p1")).toBe("[arc:payment:p1]")
    expect(withArcTransactionMarker("   ", "payment", "p1")).toBe("[arc:payment:p1]")
  })

  it("trims the surrounding whitespace of an existing note", () => {
    expect(withArcTransactionMarker("  Draw 4  ", "bill", "b9")).toBe("Draw 4 [arc:bill:b9]")
  })

  it("always contains the marker the finder searches for", () => {
    const note = withArcTransactionMarker("Draw 4", "bill", "b9")
    expect(note).toContain(arcTransactionMarker("bill", "b9"))
  })
})

describe("isStaleObjectError", () => {
  it("matches fault code 5010", () => {
    expect(isStaleObjectError({ faultCode: "5010" })).toBe(true)
  })

  it("matches a stale object detail regardless of casing or nesting", () => {
    expect(isStaleObjectError({ qboError: { Fault: { Error: [{ Message: "Stale Object Error" }] } } })).toBe(true)
    expect(isStaleObjectError({ message: "Stale Object Error - object version does not match" })).toBe(true)
  })

  it("does not match unrelated errors", () => {
    expect(isStaleObjectError({ faultCode: "610", qboError: { Fault: { Error: [{ Message: "Object Not Found" }] } } })).toBe(false)
    expect(isStaleObjectError(null)).toBe(false)
    expect(isStaleObjectError(undefined)).toBe(false)
    expect(isStaleObjectError({})).toBe(false)
    // A bare Error serializes to `{}` — the detection depends on the QBO fault
    // shape (faultCode / qboError), which is what the client actually throws.
    expect(isStaleObjectError(new Error("stale object"))).toBe(false)
  })
})

type Fetched = { Id?: string; SyncToken?: string } | null

function fakeReader(byId: Record<string, Fetched>) {
  const calls: string[] = []
  const get = async (id: string) => {
    calls.push(id)
    return byId[id] ?? null
  }
  return {
    calls,
    client: {
      getPurchaseById: get,
      getBillById: get,
      getInvoiceById: get,
      getVendorCreditById: get,
    },
  }
}

describe("resolveQBOSyncTarget", () => {
  it("creates when there is no QBO id", async () => {
    const { client, calls } = fakeReader({})
    expect(await resolveQBOSyncTarget({ client, entityType: "bill" })).toEqual({ mode: "create" })
    expect(await resolveQBOSyncTarget({ client, entityType: "bill", qboId: "   " })).toEqual({ mode: "create" })
    expect(await resolveQBOSyncTarget({ client, entityType: "bill", qboId: null })).toEqual({ mode: "create" })
    // No id means nothing to look up: the happy create path pays no round trip.
    expect(calls).toEqual([])
  })

  it("updates from a cached sync token without calling QuickBooks", async () => {
    const { client, calls } = fakeReader({ "77": { Id: "77", SyncToken: "9" } })
    const target = await resolveQBOSyncTarget({ client, entityType: "invoice", qboId: "77", cachedSyncToken: "3" })

    expect(target).toEqual({ mode: "update", id: "77", syncToken: "3" })
    expect(calls).toEqual([])
  })

  it("fetches the sync token when the cached one is missing or blank", async () => {
    const { client, calls } = fakeReader({ "77": { Id: "77", SyncToken: "9" } })

    expect(await resolveQBOSyncTarget({ client, entityType: "invoice", qboId: "77" })).toEqual({
      mode: "update",
      id: "77",
      syncToken: "9",
    })
    expect(await resolveQBOSyncTarget({ client, entityType: "invoice", qboId: "77", cachedSyncToken: "  " })).toEqual({
      mode: "update",
      id: "77",
      syncToken: "9",
    })
    expect(calls).toEqual(["77", "77"])
  })

  it("accepts sync token '0', which is falsy as a number but real as a token", async () => {
    const { client } = fakeReader({ "77": { Id: "77", SyncToken: "0" } })
    expect(await resolveQBOSyncTarget({ client, entityType: "bill", qboId: "77" })).toEqual({
      mode: "update",
      id: "77",
      syncToken: "0",
    })
  })

  it("recreates a deleted entity only when the caller allows it", async () => {
    const { client } = fakeReader({})
    expect(
      await resolveQBOSyncTarget({ client, entityType: "purchase", qboId: "gone", allowRecreateDeleted: true }),
    ).toEqual({ mode: "create" })
  })

  it("routes a deleted entity to human review when recreation is not allowed", async () => {
    const { client } = fakeReader({})
    await expect(resolveQBOSyncTarget({ client, entityType: "purchase", qboId: "gone" })).rejects.toThrow(
      QBO_DELETED_REVIEW_MESSAGE,
    )
    await expect(
      resolveQBOSyncTarget({ client, entityType: "purchase", qboId: "gone", allowRecreateDeleted: false }),
    ).rejects.toThrow(QBO_DELETED_REVIEW_MESSAGE)
  })

  it("refuses to update an entity QuickBooks returned without a sync token", async () => {
    const { client } = fakeReader({ "77": { Id: "77" } })
    await expect(resolveQBOSyncTarget({ client, entityType: "vendor_credit", qboId: "77" })).rejects.toThrow(
      "Unable to resolve QuickBooks vendor_credit sync token",
    )
  })
})

describe("findAlreadyCreatedQBOTransaction", () => {
  it("adopts the id a previous attempt already created", async () => {
    const seen: Array<{ entity: string; marker: string; since?: string | null }> = []
    const found = await findAlreadyCreatedQBOTransaction({
      client: {
        findTransactionByPrivateNote: async (entity, marker, opts) => {
          seen.push({ entity, marker, since: opts?.sinceDate })
          return { Id: "4242" }
        },
      },
      entity: "Payment",
      entityType: "payment",
      entityId: "pay-1",
    })

    expect(found).toBe("4242")
    expect(seen[0].entity).toBe("Payment")
    expect(seen[0].marker).toBe("[arc:payment:pay-1]")
    expect(seen[0].since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("returns null when nothing matches the marker", async () => {
    const found = await findAlreadyCreatedQBOTransaction({
      client: { findTransactionByPrivateNote: async () => null },
      entity: "Bill",
      entityType: "vendor_bill",
      entityId: "b-1",
    })
    expect(found).toBeNull()
  })

  it("returns null when the match carries no Id", async () => {
    const found = await findAlreadyCreatedQBOTransaction({
      client: { findTransactionByPrivateNote: async () => ({}) },
      entity: "Bill",
      entityType: "vendor_bill",
      entityId: "b-1",
    })
    expect(found).toBeNull()
  })

  it("degrades to null instead of throwing when the lookup itself fails", async () => {
    // A failed lookup must not block the push — the create below is still
    // guarded by the sync record, and the outbox will retry.
    const found = await findAlreadyCreatedQBOTransaction({
      client: {
        findTransactionByPrivateNote: async () => {
          throw new Error("QBO query failed")
        },
      },
      entity: "Invoice",
      entityType: "invoice",
      entityId: "i-1",
    })
    expect(found).toBeNull()
  })
})
