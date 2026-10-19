const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getSafetyDesk } = freshRequire("lib/services/safety-desk.ts")

const PROJECT = id(1)

const day = (offset) => new Date(Date.UTC(2025, 0, 1 + offset)).toISOString()

const incident = (key, status, occurredAt) => ({
  id: id(1000 + key),
  org_id: ORG,
  project_id: PROJECT,
  status,
  occurred_at: occurredAt,
})

// 600 closed incidents are all newer than the 55 open ones, so a reader that
// fetched recent incidents and filtered afterwards would find none of them.
const TABLES = {
  safety_incidents: [
    ...Array.from({ length: 600 }, (_, n) => incident(n, "closed", day(400 + n))),
    ...Array.from({ length: 55 }, (_, n) => incident(600 + n, n % 2 ? "under_review" : "open", day(n))),
  ],
  observations: [{ id: id(2000), org_id: ORG, project_id: PROJECT, status: "open", created_at: day(1) }],
  inspections: Array.from({ length: 80 }, (_, n) => ({
    id: id(3000 + n),
    org_id: ORG,
    project_id: PROJECT,
    kind: "safety",
    result: n < 30 ? "fail" : "pass",
    updated_at: day(n),
  })),
}

test("open incidents behind 600 closed ones are listed and counted across pages", async () => {
  const service = createServiceHarness({ permissions: ["safety.read"], tables: TABLES })

  const first = await service.run(() => getSafetyDesk())
  const second = await service.run(() => getSafetyDesk(undefined, { incidents: 2 }))

  assert.equal(first.pageSize, 50)
  assert.equal(first.incidents.length, 50)
  assert.equal(second.incidents.length, 5)
  assert.equal(first.openIncidentCount, 55)
  const listed = [...first.incidents, ...second.incidents]
  assert.equal(new Set(listed.map((row) => row.id)).size, 55)
  assert.ok(listed.every((row) => row.status !== "closed"))

  assert.equal(second.pages.observations, 1, "paging incidents must not page observations")
  assert.equal(second.observations.length, 1)
  assert.equal(first.inspectionCount, 80)
  assert.equal(first.failedInspectionCount, 30)
})

test("an actor without safety.read reads nothing", async () => {
  const service = createServiceHarness({ permissions: [], tables: TABLES })
  await assert.rejects(service.run(() => getSafetyDesk()), /safety.read/)
  assert.deepEqual(service.reads("safety_incidents"), [])
})
