const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")
const { mobileContext, status } = require("./support/mobile")

const { editWorkspaceRecord } = freshRequire("lib/mobile/workspace-edit.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const TASK = id(10)
const OTHER_TASK = id(11)
const ASSIGNEE = id(12)
const SEEN = "2026-10-01T00:00:00+00:00"

const project = (projectId) => ({
  id: projectId,
  org_id: ORG,
  name: "Lot 12",
  phase: "delivery",
  property_type: "residential",
  status: "active",
  created_at: SEEN,
})
const task = (taskId, projectId, overrides = {}) => ({
  id: taskId,
  org_id: ORG,
  project_id: projectId,
  title: "Inspect roof",
  description: "North wing",
  status: "todo",
  priority: "normal",
  due_date: "2026-10-10",
  completed_at: null,
  assignee_id: ASSIGNEE,
  created_at: SEEN,
  updated_at: SEEN,
  ...overrides,
})

function harness({ permissions = ["project.read", "org.member"], tasks } = {}) {
  const service = createServiceHarness({
    permissions,
    tables: {
      projects: [project(PROJECT), project(OTHER_PROJECT)],
      tasks: tasks ?? [task(TASK, PROJECT), task(OTHER_TASK, OTHER_PROJECT)],
    },
  })
  const context = mobileContext(service)
  service.edit = (recordId, values) => service.run(() => editWorkspaceRecord(context, "tasks", PROJECT, recordId, values))
  service.task = (taskId = TASK) => service.db.tasks.find((row) => row.id === taskId)
  return service
}

const values = { title: "Inspect roof", description: "", due_date: "", priority: "normal", status: "done" }

test("an edit changes only the task's own fields and stamps completion", async () => {
  const service = harness()

  await service.edit(TASK, { ...values, assignee_id: "untrusted", project_id: OTHER_PROJECT })

  const saved = service.task()
  assert.equal(saved.project_id, PROJECT)
  assert.equal(saved.assignee_id, ASSIGNEE)
  assert.equal(saved.due_date, null)
  assert.equal(saved.status, "done")
  assert.ok(saved.completed_at)
  assert.deepEqual(service.task(OTHER_TASK), task(OTHER_TASK, OTHER_PROJECT))
  assert.equal(service.audits[0].entityId, TASK)
  assert.equal(service.events[0].eventType, "task_updated")
})

test("a task from another project cannot be edited through this one", async () => {
  const service = harness()

  await assert.rejects(service.edit(OTHER_TASK, values), status(404))
  assert.deepEqual(service.writes(), [])
})

test("an actor without the module's edit permission is refused before any write", async () => {
  const service = harness({ permissions: ["project.read"] })

  await assert.rejects(service.edit(TASK, values), status(403))
  assert.deepEqual(service.writes(), [])
})

test("reopening clears completion; an unknown status writes nothing", async () => {
  const service = harness({ tasks: [task(TASK, PROJECT, { status: "done", completed_at: SEEN })] })

  await service.edit(TASK, { ...values, status: "todo" })
  assert.equal(service.task().completed_at, null)

  const writes = service.writes().length
  await assert.rejects(service.edit(TASK, { ...values, status: "invalid" }))
  assert.equal(service.writes().length, writes)
})
