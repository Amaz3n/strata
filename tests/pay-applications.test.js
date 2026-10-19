"use strict"

/**
 * `lib/services/pay-applications.ts` — what submitting a pay application
 * refuses before anything is posted. The posting itself is
 * `post_pay_application` (tests/pay-applications-db.test.js).
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { submitPayApplication } = freshRequire("lib/services/pay-applications.ts")

const PROJECT = id(1)
const CONTRACT = id(2)
const APPLICATION = id(3)

/** A $1,000 contract whose schedule of values totals `scheduled`. */
function harness({ scheduled, permissions = ["payapp.write", "invoice.read", "project.read"] }) {
  return createServiceHarness({
    permissions,
    tables: {
      projects: [{ id: PROJECT, org_id: ORG }],
      contracts: [{ id: CONTRACT, org_id: ORG, project_id: PROJECT, status: "active", total_cents: 100000, created_at: "2026-09-01" }],
      prime_sov_lines: [
        {
          id: id(10),
          org_id: ORG,
          contract_id: CONTRACT,
          line_number: 1,
          scheduled_value_cents: scheduled,
          previous_billed_cents: 0,
          stored_materials_cents: 0,
          retainage_held_cents: 0,
          retainage_released_cents: 0,
        },
      ],
      prime_sov_budget_links: [],
      pay_applications: [
        { id: APPLICATION, org_id: ORG, project_id: PROJECT, contract_id: CONTRACT, application_number: 1, status: "draft", metadata: {} },
      ],
      pay_application_lines: [],
      change_orders: [],
    },
  })
}

test("an application whose schedule of values does not foot to the contract sum cannot be submitted", async () => {
  const service = harness({ scheduled: 90000 })
  await assert.rejects(
    service.run(() => submitPayApplication(APPLICATION)),
    /\$900\.00 but the contract sum to date is \$1,000\.00\. Balance the schedule of values before submitting/,
  )
  assert.deepEqual(service.writes(), [])
  assert.equal(service.queries.some((query) => query.table.startsWith("rpc:")), false)
})

test("submitting needs pay application write access", async () => {
  const service = harness({ scheduled: 100000, permissions: ["invoice.read", "project.read"] })
  await assert.rejects(service.run(() => submitPayApplication(APPLICATION)))
  assert.deepEqual(service.writes(), [])
  assert.equal(service.reads("pay_application_lines").length, 0)
})
