"use strict"

/**
 * `recordCustomerRefund` decides WHO may record an offline refund and WHICH
 * payments it may be recorded against; the money itself moves inside
 * `record_manual_customer_refund_atomic` (tests/customer-refunds-db.test.js).
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { recordCustomerRefund } = freshRequire("lib/services/customer-refunds.ts")

const PAYMENT = id(1)
const INVOICE = id(2)
const PROJECT = id(3)
const DIVISION = id(4)

function harness({ provider = "manual", projectId = null, permissions = ["payment.release"], divisions, duplicate = false } = {}) {
  return createServiceHarness({
    permissions,
    divisions,
    tables: {
      payments: [{ id: PAYMENT, org_id: ORG, invoice_id: INVOICE, project_id: projectId, provider }],
      projects: [{ id: PROJECT, org_id: ORG, division_id: DIVISION }],
    },
    rpc: { record_manual_customer_refund_atomic: () => ({ data: { id: id(50), duplicate }, error: null }) },
  })
}

const refund = (overrides = {}) => ({
  paymentId: PAYMENT,
  amountCents: 1000,
  reason: "Returned by check",
  idempotencyKey: id(60),
  ...overrides,
})

const refundCalls = (service) => service.queries.filter((query) => query.table === "rpc:record_manual_customer_refund_atomic")

test("a refund is recorded for the actor in their org, and audited once", async () => {
  const service = harness()
  const result = await service.run(() => recordCustomerRefund(refund()))

  assert.deepEqual(result, { invoiceId: INVOICE, projectId: null })
  const [call] = refundCalls(service)
  assert.equal(call.payload.p_org_id, ORG)
  assert.equal(call.payload.p_actor_id, service.userId)
  assert.equal(call.payload.p_amount_cents, 1000)
  assert.equal(service.audits.length, 1)
  assert.deepEqual(service.events.map((event) => event.eventType), ["payment_reversed"])
})

test("a retried refund is not audited or announced a second time", async () => {
  const service = harness({ duplicate: true })
  await service.run(() => recordCustomerRefund(refund()))
  assert.equal(refundCalls(service).length, 1)
  assert.deepEqual(service.audits, [])
  assert.deepEqual(service.events, [])
})

test("a refund is refused before any money moves", async () => {
  const cases = {
    "without payment.release": [harness({ permissions: ["invoice.read"] }), refund(), /permission|authorized|denied/i],
    "on general billing for a division-scoped actor": [
      harness({ divisions: [DIVISION] }),
      refund(),
      /Organization-wide/,
    ],
    "on a provider payment": [harness({ provider: "stripe" }), refund(), /payment provider/],
    "for a negative amount": [harness(), refund({ amountCents: -1 }), undefined],
    "without a reason": [harness(), refund({ reason: " " }), /refund reason/],
  }
  for (const [name, [service, input, error]] of Object.entries(cases)) {
    await assert.rejects(service.run(() => recordCustomerRefund(input)), error, name)
    assert.equal(refundCalls(service).length, 0, name)
    assert.deepEqual(service.audits, [], name)
  }
})
