const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { dismissPoException } = freshRequire("lib/services/po-generation.ts")

const PROJECT = id(1)
const EXCEPTION = id(2)

function harness(status) {
  return createServiceHarness({
    permissions: ["project.read", "po_exception.resolve"],
    tables: {
      projects: [{ id: PROJECT, org_id: ORG }],
      po_generation_exceptions: [{ id: EXCEPTION, org_id: ORG, project_id: PROJECT, status, resolution: null }],
    },
  })
}

test("an open exception is dismissed with its note", async () => {
  const service = harness("open")

  const dismissed = await service.run(() => dismissPoException(EXCEPTION, "Builder-supplied item"))

  assert.equal(dismissed.status, "dismissed")
  assert.deepEqual(dismissed.resolution, { note: "Builder-supplied item" })
})

test("a resolved exception is not relabelled dismissed, even when the resolution lands mid-request", async () => {
  const resolved = harness("resolved_agreement")
  await assert.rejects(resolved.run(() => dismissPoException(EXCEPTION, "Late")), /already been resolved/)
  assert.deepEqual(resolved.writes(), [])

  const racing = harness("open")
  // A resolution commits between this request's read and its write.
  racing.tamper(
    "po_generation_exceptions",
    (result) => {
      racing.db.po_generation_exceptions[0].status = "resolved_agreement"
      return result
    },
    { on: "select", times: 1 },
  )
  await assert.rejects(racing.run(() => dismissPoException(EXCEPTION, "Late")), /already been resolved/)
  assert.equal(racing.db.po_generation_exceptions[0].status, "resolved_agreement")
})
