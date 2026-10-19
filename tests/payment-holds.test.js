const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

/** Reminder delivery has its own suite; here it either reaches the signer or not. */
const delivery = { fails: false, sent: [] }
stubModule("@/lib/services/signature-delivery", {
  deliverAutomaticSigningReminder: async (input) => {
    delivery.sent.push(input)
    if (delivery.fails) throw new Error("provider unavailable")
  },
})

const { sendVendorBillWaiverChase } = freshRequire("lib/services/payment-holds.ts")

const BILL = id(1)
const PROJECT = id(2)
const VENDOR = id(3)
const WAIVER = id(4)
const DOCUMENT = id(5)
const REQUEST = id(6)

describe("chasing a vendor for a bill's waiver", () => {
  function harness({ waivers, company = { name: "Trade", email: "ap@trade-co.us" } } = {}) {
    delivery.fails = false
    delivery.sent = []
    return createServiceHarness({
      tables: {
        vendor_bills: [{ id: BILL, org_id: ORG, project_id: PROJECT, company_id: VENDOR, metadata: {}, company }],
        lien_waivers: waivers ?? [
          {
            id: WAIVER,
            org_id: ORG,
            bill_id: BILL,
            status: "sent",
            waiver_type: "conditional_progress",
            metadata: { document_id: DOCUMENT },
            created_at: "2026-09-01T00:00:00Z",
          },
        ],
        document_signing_requests: [
          {
            id: REQUEST,
            org_id: ORG,
            document_id: DOCUMENT,
            envelope_id: id(7),
            status: "sent",
            sequence: 1,
            required: true,
            sent_to_email: "signer@trade-co.us",
          },
        ],
        outbox: [],
      },
    })
  }

  test("the reminder is queued before it is sent, so a failed send is retried under the same key", async () => {
    const service = harness()
    delivery.fails = true

    await assert.rejects(service.run(() => sendVendorBillWaiverChase(ORG, BILL, { attempt: 2 })), /provider unavailable/)
    assert.equal(service.db.outbox.length, 1)
    assert.equal(service.db.outbox[0].job_type, "send_esign_reminder")
    assert.equal(service.db.vendor_bills[0].metadata.waiver_chase, undefined)

    delivery.fails = false
    await service.run(() => sendVendorBillWaiverChase(ORG, BILL, { attempt: 2 }))

    assert.equal(delivery.sent[0].deliveryKey, delivery.sent[1].deliveryKey)
    assert.equal(service.db.outbox[0].payload.delivery_key, delivery.sent[0].deliveryKey)
    assert.equal(service.db.vendor_bills[0].metadata.waiver_chase.delivery, "sent")
    assert.equal(service.db.vendor_bills[0].metadata.waiver_chase.attempt, 2)
  })

  test("a signed waiver is not chased", async () => {
    const service = harness()
    service.db.lien_waivers[0].status = "signed"

    await service.run(() => sendVendorBillWaiverChase(ORG, BILL))

    assert.deepEqual(delivery.sent, [])
    assert.deepEqual(service.writes(), [])
  })

  test("with no prepared document, staff get a follow-up instead of a generic signing link", async () => {
    const service = harness({ waivers: [] })

    await service.run(() => sendVendorBillWaiverChase(ORG, BILL))

    assert.deepEqual(delivery.sent, [])
    assert.deepEqual(service.db.outbox, [])
    assert.equal(service.db.vendor_bills[0].metadata.waiver_chase.delivery, "needs_preparation")
    assert.deepEqual(
      service.events.map((event) => event.eventType),
      ["waiver_preparation_required"],
    )
  })

  test("a vendor with no email cannot be chased", async () => {
    const service = harness({ company: { name: "Trade", email: null } })
    service.db.companies = [{ id: VENDOR, org_id: ORG, name: "Trade", email: null }]

    await assert.rejects(service.run(() => sendVendorBillWaiverChase(ORG, BILL)), /no email/)
    assert.deepEqual(service.writes(), [])
  })
})
