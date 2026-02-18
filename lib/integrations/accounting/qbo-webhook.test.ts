// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { computeIntuitWebhookSignature, extractIntuitEventIds, verifyIntuitWebhookSignature } from "@/lib/integrations/accounting/qbo-webhook"

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

    expect(ids).toEqual(["12345:Payment:99:Update:2026-02-12T00:00:00Z"])
  })
})
