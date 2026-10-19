"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { listEstimateTemplates } = freshRequire("lib/services/estimate-templates.ts")

function library(templates = []) {
  return createServiceHarness({ tables: { estimate_templates: templates }, permissions: ["org.member"] })
}

test("the library lists only the org's templates, and an empty library is empty", async () => {
  const service = library([
    { id: id(1), org_id: ORG, name: "Kitchen", lines: [{ description: "Cabinets", unit_cost_cents: 250000 }] },
    { id: id(2), org_id: id(9), name: "Foreign", lines: [] },
  ])
  const templates = await service.run(() => listEstimateTemplates())
  assert.deepEqual(
    templates.map((template) => [template.name, template.lines[0].unit_cost_cents]),
    [["Kitchen", 250000]],
  )

  assert.deepEqual(await library().run(() => listEstimateTemplates()), [])
})

test("a failed read surfaces instead of looking like an empty library", async () => {
  const service = library()
  service.tamper("estimate_templates", replies.error("query unavailable"))
  await assert.rejects(service.run(() => listEstimateTemplates()), /query unavailable/)
})
