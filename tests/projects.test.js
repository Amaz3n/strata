"use strict"

/**
 * `lib/services/projects.ts` — creating a project and the billing contract it
 * opens with.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { createProject } = freshRequire("lib/services/projects.ts")

describe("createProject", () => {
  const harness = () =>
    createServiceHarness({
      permissions: ["project.manage"],
      tables: { projects: [], contracts: [], project_financial_settings: [], accounting_entity_map: [], orgs: [] },
    })
  const create = (service, input) => service.run(() => createProject({ input: { name: "Lot 12", status: "planning", ...input } }))

  test("a production home opens without a contract, so its purchase agreement is its only revenue contract", async () => {
    const service = harness()
    await create(service, { property_type: "production" })
    assert.equal(service.db.contracts.length, 0)
    assert.equal(service.db.project_financial_settings.length, 1)
  })

  test("a production home given billing terms opens the contract those terms describe", async () => {
    const service = harness()
    await create(service, { property_type: "production", billing_model: "cost_plus_percent", markup_percent: 12 })
    assert.equal(service.db.contracts.length, 1)
    assert.equal(service.db.contracts[0].contract_type, "cost_plus")
  })

  test("a custom home and a commercial job each open with their project contract", async () => {
    for (const property_type of ["residential", "commercial"]) {
      const service = harness()
      await create(service, { property_type })
      assert.equal(service.db.contracts.length, 1, property_type)
      assert.equal(service.db.contracts[0].status, "active", property_type)
    }
  })
})
