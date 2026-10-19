"use strict"

/**
 * The vendor-transfer release sweep (`releaseMaturedVendorTransfers`) runs
 * every five minutes. It must only report a money-movement failure when money
 * could actually have moved.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { releaseMaturedVendorTransfers } = freshRequire("lib/services/payment-payouts.ts")

function withEnv(values, work) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  return work().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

// Execution is switched on, but reconciliation is not — so a readiness check
// would fail. Whether it is reached is the behaviour under test.
const HALF_CONFIGURED = { FINTECH_PAYMENTS_EXECUTION_ENABLED: "true", FINTECH_PAYMENTS_RECONCILIATION_ENABLED: "false" }

test("with no organization on the rail, the sweep has nothing to do instead of failing readiness", async () => {
  const service = createServiceHarness({ tables: { payment_rail_policies: [{ org_id: ORG, enabled: false }] } })
  const result = await withEnv(HALF_CONFIGURED, () => service.run(() => releaseMaturedVendorTransfers()))
  assert.deepEqual(result, { attempted: 0, released: [], failed: [], skipped: "no_enabled_rails" })
  assert.equal(service.queries.some((query) => query.table.startsWith("rpc:")), false)
})

test("with a rail enabled, an unready deployment refuses before claiming any transfer", async () => {
  const service = createServiceHarness({ tables: { payment_rail_policies: [{ org_id: ORG, enabled: true }] } })
  await assert.rejects(
    withEnv(HALF_CONFIGURED, () => service.run(() => releaseMaturedVendorTransfers())),
    /reconciliation/,
  )
  assert.equal(service.queries.some((query) => query.table === "rpc:claim_matured_vendor_transfers"), false)
})

test("with execution switched off, the sweep does nothing", async () => {
  const service = createServiceHarness()
  const result = await withEnv({ FINTECH_PAYMENTS_EXECUTION_ENABLED: "false" }, () =>
    service.run(() => releaseMaturedVendorTransfers()),
  )
  assert.equal(result.skipped, "execution_disabled")
})
