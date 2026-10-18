const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, recordingService } = require("./support/mobile")

const punchCalls = []
stubModule(
  "app/(app)/projects/[id]/actions.ts",
  recordingService(punchCalls, {
    updateProjectPunchItemAction: (_project, _item, input) => ({
      success: true,
      data: { id: PUNCH, project_id: PROJECT, title: "Door", status: input.status, updated_at: "2026-10-09T12:00:00+00:00" },
    }),
  }),
)

const { updateMobilePunchStatus, updateMobileTaskStatus } = freshRequire("lib/mobile/field.ts")

const PROJECT = id(1)
const TASK = id(2)
const PUNCH = id(3)
const TASK_SAVED = "2026-10-09T10:00:00.5+00:00"
const PUNCH_SAVED = "2026-10-09T11:00:00+00:00"

function harness() {
  const service = createServiceHarness({
    permissions: ["project.read"],
    tables: {
      projects: [{ id: PROJECT, org_id: ORG, name: "Lot 12", phase: "delivery", property_type: "residential", status: "active", created_at: "2026-10-01T00:00:00Z" }],
      tasks: [{ id: TASK, org_id: ORG, project_id: PROJECT, title: "Pour slab", status: "todo", updated_at: TASK_SAVED, created_at: "2026-10-01T00:00:00Z" }],
      punch_items: [{ id: PUNCH, org_id: ORG, project_id: PROJECT, title: "Door", status: "open", updated_at: PUNCH_SAVED }],
    },
  })
  service.context = mobileContext(service)
  punchCalls.length = 0
  return service
}

describe("a queued task status change", () => {
  const change = (service, input) => service.run(() => updateMobileTaskStatus(service.context, PROJECT, TASK, input))

  test("is saved when it names the revision the app read", async () => {
    const service = harness()

    const task = await change(service, { status: "done", expected_revision: TASK_SAVED })

    assert.equal(task.status, "done")
  })

  test("is refused with the current task when someone else changed it first", async () => {
    const service = harness()

    await assert.rejects(change(service, { status: "done", expected_revision: "2026-10-09T09:00:00.000Z" }), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, "stale_revision")
      assert.equal(error.current.id, TASK)
      assert.equal(error.current.status, "todo")
      return true
    })
    assert.deepEqual(service.writes("tasks"), [])
  })

  test("is saved when it names no revision, as older app builds send it", async () => {
    const service = harness()

    const task = await change(service, { status: "in_progress" })

    assert.equal(task.status, "in_progress")
  })
})

describe("a queued punch status change", () => {
  const change = (service, input) => service.run(() => updateMobilePunchStatus(service.context, PROJECT, PUNCH, input))

  test("is handed to the punch lifecycle when it names the current revision", async () => {
    const service = harness()

    const item = await change(service, { status: "closed", expected_revision: PUNCH_SAVED })

    assert.equal(item.status, "closed")
    assert.equal(item.updated_at, "2026-10-09T12:00:00+00:00")
  })

  test("is refused with the current item, and nothing reaches the lifecycle, when the item moved on", async () => {
    const service = harness()

    await assert.rejects(change(service, { status: "closed", expected_revision: "2026-10-09T08:00:00Z" }), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.current.status, "open")
      return true
    })
    assert.deepEqual(punchCalls, [])
  })
})
