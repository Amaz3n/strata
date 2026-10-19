"use strict"

/**
 * `createEstimate()` in `lib/services/estimates.ts` — pricing a deal. Any lead
 * can be priced from a name alone; a budget or agreement moves an early lead
 * into pricing, a preconstruction services agreement never does, and a
 * failed lookup writes nothing.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { DEFAULT_ESTIMATE_COMMERCIAL } = require("@/lib/financials/estimate-commercial")
const { createEstimate } = freshRequire("lib/services/estimates.ts")

const DEAL = id(1)
const PROJECT = id(2)

function harness({ status = "qualified", projects = [], permissions = ["org.member"] } = {}) {
  return createServiceHarness({
    tables: {
      // A name and nothing else: no notes, budget, timeline or contacts.
      prospects: [{ id: DEAL, org_id: ORG, name: "Kitchen remodel", status }],
      prospect_contacts: [],
      projects,
      estimates: [],
      estimate_items: [],
    },
    permissions,
  })
}

/** `purpose` is a precon purpose, or "legacy" for a document with no precon terms. */
function price(service, purpose) {
  return service.run(() =>
    createEstimate({
      prospect_id: DEAL,
      title: "Project pricing",
      lines: [{ description: "Work", quantity: 1, unit_cost_cents: 100000 }],
      ...(purpose === "legacy" ? {} : { precon: { ...DEFAULT_ESTIMATE_COMMERCIAL, purpose } }),
    }),
  )
}

const dealStatus = (service) => service.db.prospects[0].status

test("a budget or agreement on an early, name-only lead moves it into pricing", async () => {
  for (const status of ["new", "contacted", "qualified"]) {
    for (const purpose of ["budget", "construction_agreement", "legacy"]) {
      const service = harness({ status })
      const { estimate } = await price(service, purpose)
      assert.equal(service.db.estimates.length, 1)
      assert.equal(estimate.total_cents, 100000)
      assert.equal(dealStatus(service), "pricing", `${status} / ${purpose}`)
    }
  }
})

test("a preconstruction services agreement never advances the lead", async () => {
  for (const status of ["new", "contacted", "qualified", "estimate_sent"]) {
    const service = harness({ status })
    const { estimate } = await price(service, "preconstruction_agreement")
    assert.equal(estimate.metadata.precon.purpose, "preconstruction_agreement")
    assert.equal(dealStatus(service), status)
    assert.deepEqual(service.writes("prospects"), [])
    assert.equal(service.audits.length, 1)
  }
})

test("a revision on a deal already past qualification keeps its stage", async () => {
  for (const status of ["pricing", "changes_requested"]) {
    const service = harness({ status })
    await price(service, "budget")
    assert.equal(dealStatus(service), status)
  }
})

test("a deal with a pricing project prices onto that project", async () => {
  const service = harness({ status: "new", projects: [{ id: PROJECT, org_id: ORG, prospect_id: DEAL, phase: "precon" }] })
  const { estimate } = await price(service, "budget")
  assert.equal(estimate.project_id, PROJECT)
})

test("a failed lookup or a missing permission writes nothing", async () => {
  const cases = [
    [(service) => service.tamper("projects", replies.error("Project lookup failed")), /pricing workspace/],
    [(service) => service.tamper("prospects", replies.error("Prospect lookup failed")), /Prospect not found/],
    [(service) => (service.db.prospects = []), /Prospect not found/],
  ]
  for (const [breakIt, message] of cases) {
    const service = harness()
    breakIt(service)
    await assert.rejects(price(service, "budget"), message)
    assert.deepEqual(service.writes(), [])
  }

  const forbidden = harness({ permissions: [] })
  await assert.rejects(price(forbidden, "budget"), /org\.member/)
  assert.deepEqual(forbidden.writes(), [])
})
