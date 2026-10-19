require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getProjectOverviewOperations } = freshRequire("lib/services/project-overview.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

function task(n, dueDate) {
  return { id: id(100 + n), org_id: ORG, project_id: PROJECT, title: `Task ${n}`, status: "todo", due_date: dueDate }
}

function rfi(n, dueDate) {
  return { id: id(200 + n), org_id: ORG, project_id: PROJECT, subject: `RFI ${n}`, status: "open", due_date: dueDate }
}

function overview(tables = {}, options = {}) {
  const service = createServiceHarness({
    permissions: ["project.read"],
    projects: [PROJECT],
    tables: { projects: [{ id: PROJECT, org_id: ORG }, { id: OTHER_PROJECT, org_id: ORG }], ...tables },
    ...options,
  })
  return { service, load: (projectId = PROJECT) => service.run(() => getProjectOverviewOperations(projectId)) }
}

test("a member without access to the project reads nothing", async () => {
  const { service, load } = overview({ tasks: [task(1, day(-3))] })
  await assert.rejects(load(OTHER_PROJECT), /project\.read/)
  assert.deepEqual(service.reads("tasks"), [])
})

test("a failed query fails the band instead of reporting a healthy zero", async () => {
  const { service, load } = overview({ rfis: [rfi(1, day(-3))] })
  service.tamper("rfis", replies.error("statement timeout"))
  await assert.rejects(load(), /Failed to load overdue RFIs: statement timeout/)
})

test("the attention band is capped and says so when more is overdue than it shows", async () => {
  const overdue = overview({
    tasks: Array.from({ length: 6 }, (_, n) => task(n, day(-10 + n))),
    rfis: Array.from({ length: 4 }, (_, n) => rfi(n, day(-20 + n))),
  })
  const crowded = await overdue.load()
  assert.equal(crowded.attention.length, 8, "five tasks and three RFIs")
  assert.equal(crowded.attentionTruncated, true)
  assert.equal(crowded.attention[0].title, "RFI 0", "most overdue first")

  const quiet = await overview({ tasks: [task(1, day(-2)), task(2, day(-1))] }).load()
  assert.equal(quiet.attention.length, 2)
  assert.equal(quiet.attentionTruncated, false)
})

test("the week band is capped and says so when more is coming up than it shows", async () => {
  const busy = await overview({ tasks: Array.from({ length: 8 }, (_, n) => task(n, day(1))) }).load()
  assert.equal(busy.comingUp.length, 5)
  assert.equal(busy.comingUpTruncated, true)

  const calm = await overview({ tasks: [task(1, day(2))] }).load()
  assert.deepEqual(calm.comingUp.map((item) => item.title), ["Task 1"])
  assert.equal(calm.comingUpTruncated, false)
})
