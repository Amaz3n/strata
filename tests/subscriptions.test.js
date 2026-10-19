"use strict"

/**
 * Arc's own subscription, written from Stripe webhooks
 * (`upsertSubscriptionFromStripe`, lib/services/subscriptions.ts). A webhook
 * that cannot be recorded must fail so Stripe retries it.
 *
 * Entitlement sync is its own service and is replaced with a recorder.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const entitlementSyncs = []
stubModule("@/lib/services/billing", {
  syncOrgEntitlementsFromPlan: async (orgId, planCode) => {
    entitlementSyncs.push([orgId, planCode])
  },
})

const { upsertSubscriptionFromStripe } = freshRequire("lib/services/subscriptions.ts")

const START = 1790107853
const END = 1792699853
const iso = (seconds) => new Date(seconds * 1000).toISOString()

function subscription(item = {}, overrides = {}) {
  return {
    id: "sub_test",
    customer: "cus_test",
    status: "active",
    metadata: { org_id: ORG, plan_code: "founders" },
    items: { data: [{ price: { id: "price" }, ...item }] },
    ...overrides,
  }
}

function setup(existing) {
  entitlementSyncs.length = 0
  return createServiceHarness({
    tables: { subscriptions: existing ? [{ id: id(1), org_id: ORG, external_subscription_id: "sub_test" }] : [] },
  })
}

const record = (service, event) => service.run(() => upsertSubscriptionFromStripe(event))
const stored = (service) => service.db.subscriptions.find((row) => row.external_subscription_id === "sub_test")

test("the billing period on the subscription item is recorded, for a new or an existing subscription", async () => {
  for (const existing of [false, true]) {
    const service = setup(existing)
    await record(service, subscription({ current_period_start: START, current_period_end: END }))

    assert.equal(service.db.subscriptions.length, 1)
    assert.equal(stored(service).current_period_start, iso(START))
    assert.equal(stored(service).current_period_end, iso(END))
    assert.deepEqual(entitlementSyncs, [[ORG, "founders"]])
  }
})

test("an older event with the period on the subscription itself is still recorded", async () => {
  const service = setup(false)
  await record(service, subscription({}, { current_period_start: START, current_period_end: END }))
  assert.equal(stored(service).current_period_start, iso(START))
})

test("an event without a billing period is refused before anything is written", async () => {
  const service = setup(false)
  await assert.rejects(record(service, subscription()), /no valid billing period/)
  assert.deepEqual(service.writes(), [])
  assert.deepEqual(entitlementSyncs, [])
})

test("a failed write fails the webhook so Stripe retries, and entitlements are not synced", async () => {
  for (const existing of [false, true]) {
    const service = setup(existing)
    service.tamper("subscriptions", replies.error("database unavailable"), { on: existing ? "update" : "upsert" })
    await assert.rejects(
      record(service, subscription({ current_period_start: START, current_period_end: END })),
      /Failed to upsert subscription/,
    )
    assert.deepEqual(entitlementSyncs, [])
  }
})
