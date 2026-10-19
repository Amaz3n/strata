const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

stubModule("next/cache", { revalidatePath: () => {} })

const { createMyTaskAction, searchTaskProjectsAction, updateMyTaskAction } = freshRequire("app/(app)/tasks/actions.ts")

const TASK = id(1)
const STRANGER = id(2)
const NOW = "2026-10-06T12:00:00+00:00"

function harness({ withTask = true } = {}) {
  const service = createServiceHarness({
    tables: {
      tasks: withTask
        ? [
            {
              id: TASK,
              org_id: ORG,
              project_id: null,
              title: "Review plans",
              description: "@Sam Builder review",
              status: "todo",
              priority: "normal",
              metadata: { mentioned_user_ids: [ACTOR] },
              created_at: NOW,
              updated_at: NOW,
            },
          ]
        : [],
      task_assignments: withTask ? [{ id: id(3), org_id: ORG, task_id: TASK, user_id: ACTOR }] : [],
    },
  })
  // The actor is the org's only person a task can reach.
  Object.assign(service.db.memberships[0], {
    app_users: { id: ACTOR, full_name: "Sam Builder" },
    roles: { key: "org_member", scope: "org" },
  })
  return service
}

const task = (service) => service.db.tasks.find((row) => row.id !== undefined && row.title === "Review plans")
const assignees = (service) => service.db.task_assignments.map((row) => row.user_id)

test("creating a task saves its assignee and takes mentions from the text, not the client", async () => {
  const service = harness({ withTask: false })

  const result = await service.run(() =>
    createMyTaskAction({
      title: "Review plans",
      description: "@Sam Builder review",
      assignee_id: ACTOR,
      assignee_kind: "user",
      mentioned_user_ids: [STRANGER],
    }),
  )

  assert.equal(result.success, true, result.error)
  assert.deepEqual(task(service).metadata.mentioned_user_ids, [ACTOR])
  assert.deepEqual(assignees(service), [ACTOR])
})

test("clearing the assignee removes the assignment", async () => {
  const service = harness()

  const result = await service.run(() => updateMyTaskAction(TASK, { clear_assignee: true }))

  assert.equal(result.success, true, result.error)
  assert.deepEqual(assignees(service), [])
})

test("assigning someone who cannot open the task changes nothing", async () => {
  const service = harness()

  const result = await service.run(() => updateMyTaskAction(TASK, { assignee_id: STRANGER, assignee_kind: "user" }))

  assert.equal(result.success, false)
  assert.deepEqual(service.writes(), [])
  assert.deepEqual(assignees(service), [ACTOR])
})

test("completing a task keeps its mentions; removing the description clears them", async () => {
  const service = harness()

  assert.equal((await service.run(() => updateMyTaskAction(TASK, { status: "done" }))).success, true)
  assert.deepEqual(task(service).metadata.mentioned_user_ids, [ACTOR])
  assert.ok(task(service).completed_at)

  assert.equal((await service.run(() => updateMyTaskAction(TASK, { description: "" }))).success, true)
  assert.deepEqual(task(service).metadata.mentioned_user_ids, [])
})

test("the project picker searches only projects the caller can open, a page at a time", async () => {
  const OWN_DIVISION = id(10)
  const OTHER_DIVISION = id(11)
  const projects = [
    { id: id(20), org_id: ORG, name: "Maple Lot 4", division_id: OWN_DIVISION, phase: "delivery", property_type: "production", status: "active" },
    { id: id(21), org_id: ORG, name: "Oak Lot 9", division_id: OTHER_DIVISION, phase: "delivery", property_type: "production", status: "active" },
    { id: id(22), org_id: id(999), name: "Another org", division_id: OWN_DIVISION, phase: "delivery" },
  ]
  const names = (result) => result.data.items.map((item) => item.name)

  const divisionLimited = createServiceHarness({
    tables: { projects },
    permissions: ["project.read"],
    divisions: [OWN_DIVISION],
  })
  const own = await divisionLimited.run(() => searchTaskProjectsAction({ search: "" }))
  assert.deepEqual(names(own), ["Maple Lot 4"])
  assert.equal(own.data.items[0].detail, "Home · active")
  assert.deepEqual(names(await divisionLimited.run(() => searchTaskProjectsAction({ search: "oak" }))), [])

  const assignedOnly = createServiceHarness({ tables: { projects }, permissions: ["project.read"], projects: [id(21)] })
  Object.assign(assignedOnly.db.project_members[0], { project: { id: id(21), phase: "delivery" } })
  assert.deepEqual(names(await assignedOnly.run(() => searchTaskProjectsAction({ search: "Oak" }))), ["Oak Lot 9"])
})

test("project search pages through a long portfolio and names the next page", async () => {
  const projects = Array.from({ length: 60 }, (_, index) => ({
    id: id(100 + index), org_id: ORG, name: `Home ${String(index).padStart(2, "0")}`, division_id: null, phase: "delivery", property_type: null, status: "active",
  }))
  const service = createServiceHarness({ tables: { projects }, permissions: ["project.read"] })

  const first = await service.run(() => searchTaskProjectsAction({ search: "" }))
  const third = await service.run(() => searchTaskProjectsAction({ search: "", page: 3 }))
  assert.deepEqual([first.data.items.length, first.data.nextPage], [25, 2])
  assert.deepEqual([third.data.items.length, third.data.nextPage], [10, null])
  assert.deepEqual((await service.run(() => searchTaskProjectsAction({ search: "home 47" }))).data.items.map((item) => item.name), ["Home 47"])
})

test("a task can be detached from its project and stays assigned and editable as a personal task", async () => {
  const service = harness()
  task(service).project_id = id(20)

  const result = await service.run(() => updateMyTaskAction(TASK, { project_id: null }))

  assert.equal(result.success, true, result.error)
  assert.equal(task(service).project_id, null)
  assert.deepEqual(assignees(service), [ACTOR])
  assert.deepEqual(task(service).metadata.mentioned_user_ids, [ACTOR])

  const untouched = await service.run(() => updateMyTaskAction(TASK, { title: "Review plans again" }))
  assert.equal(untouched.success, true, untouched.error)
  assert.equal(service.db.tasks[0].project_id, null)
})
