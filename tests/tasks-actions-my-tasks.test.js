const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, replies, ACTOR, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

// `listMyTasksAction` from app/(app)/tasks/actions.ts.
// Belongs in tests/tasks-actions.test.js; kept apart while that suite is being rewritten.
const { listMyTasksAction } = freshRequire("app/(app)/tasks/actions.ts")

test("a failed assignment read stops My Tasks instead of listing a partial set", async () => {
  const service = createServiceHarness({
    tables: {
      task_assignments: [{ id: id(1), org_id: ORG, user_id: ACTOR, task_id: id(2) }],
      tasks: [{ id: id(3), org_id: ORG, created_by: ACTOR, title: "Own task" }],
    },
  })
  service.tamper("task_assignments", replies.error("connection lost"))

  await assert.rejects(
    service.run(() => listMyTasksAction()),
    /Failed to load task assignments: connection lost/,
  )
  assert.deepEqual(service.reads("tasks"), [])
})
