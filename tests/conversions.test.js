"use strict"

/**
 * `startProspectPricing()` in `lib/services/conversions.ts` — "Start pricing"
 * on a deal: create (or reuse) its precon project, pull the deal's unlinked
 * cost plans onto it, and move an early lead into pricing. Any open lead can
 * start from a name alone; a partial start is safe to retry; a project the
 * caller cannot manage is never relinked.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

// Project creation has its own suite; here it inserts the precon project.
let current = null
stubModule("@/lib/services/projects", {
  createProject: async ({ input }) => {
    const project = { id: CREATED, org_id: ORG, phase: input.phase, prospect_id: input.prospect_id, name: input.name }
    current.db.projects.push(project)
    return project
  },
})

const { startProspectPricing } = freshRequire("lib/services/conversions.ts")

const DEAL = id(1)
const CREATED = id(2)
const EXISTING = id(3)
const OTHER_PROJECT = id(4)

function harness({ status = "qualified", projects = [], permissions = ["org.member", "project.manage"], scope } = {}) {
  current = createServiceHarness({
    tables: {
      // A name and nothing else.
      prospects: [{ id: DEAL, org_id: ORG, name: "Test lead", status, notes: "", budget_range: "undecided" }],
      projects,
      estimates: [
        { id: id(10), org_id: ORG, prospect_id: DEAL, project_id: null },
        { id: id(11), org_id: id(99), prospect_id: DEAL, project_id: null },
        { id: id(12), org_id: ORG, prospect_id: id(98), project_id: null },
        { id: id(13), org_id: ORG, prospect_id: DEAL, project_id: OTHER_PROJECT },
      ],
    },
    permissions,
    projects: scope,
  })
  return current
}

const start = (service, options = {}) => service.run(() => startProspectPricing({ prospectId: DEAL, ...options }))
const dealStatus = (service) => service.db.prospects[0].status
const links = (service) => service.db.estimates.map((estimate) => estimate.project_id)
const projectIds = (service) => service.db.projects.map((project) => project.id)

test("starting pricing creates the precon project and carries only this deal's unlinked cost plans onto it", async () => {
  const service = harness()
  assert.deepEqual(await start(service), { projectId: CREATED, alreadyStarted: false })
  assert.equal(dealStatus(service), "pricing")
  assert.deepEqual(links(service), [CREATED, null, null, OTHER_PROJECT])

  assert.deepEqual(await start(service), { projectId: CREATED, alreadyStarted: true })
  assert.deepEqual(projectIds(service), [CREATED])
})

test("any open lead starts from a name alone; a later-stage deal keeps its stage", async () => {
  for (const [status, expected] of [
    ["new", "pricing"],
    ["contacted", "pricing"],
    ["qualified", "pricing"],
    ["estimate_sent", "estimate_sent"],
  ]) {
    const service = harness({ status })
    await start(service)
    assert.deepEqual(projectIds(service), [CREATED], status)
    assert.equal(dealStatus(service), expected, status)
  }
})

test("a closed deal cannot start pricing", async () => {
  for (const status of ["won", "lost"]) {
    const service = harness({ status })
    await assert.rejects(start(service), /closed/)
    assert.deepEqual(service.writes(), [])
  }
})

test("a start that failed partway is retried without a second project", async () => {
  const service = harness()
  service.tamper("estimates", replies.error("link failure"), { on: "update", times: 1 })
  await assert.rejects(start(service), /Retry Start pricing/)
  assert.equal(dealStatus(service), "qualified")

  await start(service)
  assert.deepEqual(projectIds(service), [CREATED])
  assert.equal(dealStatus(service), "pricing")
  assert.equal(links(service)[0], CREATED)
})

test("a failed project lookup, or a project the caller cannot manage, creates and relinks nothing", async () => {
  const failed = harness()
  failed.tamper("projects", replies.error("lookup failed"))
  await assert.rejects(start(failed), /lookup failed/)
  assert.deepEqual(failed.writes(), [])

  const restricted = harness({
    projects: [{ id: EXISTING, org_id: ORG, prospect_id: DEAL, phase: "precon" }],
    scope: [OTHER_PROJECT],
  })
  await assert.rejects(start(restricted), /Missing permission: project\.manage/)
  assert.equal(links(restricted)[0], null)
  assert.equal(dealStatus(restricted), "qualified")
})

test("an existing pricing project is reused as-is", async () => {
  const service = harness({ projects: [{ id: EXISTING, org_id: ORG, prospect_id: DEAL, phase: "precon" }] })
  assert.deepEqual(await start(service), { projectId: EXISTING, alreadyStarted: true })
  assert.equal(links(service)[0], EXISTING)
})

test("opening plans and files keeps the sales stage and reuses the same project", async () => {
  const service = harness({ status: "new" })
  const first = await start(service, { resourcesOnly: true })
  const again = await start(service, { resourcesOnly: true })
  assert.equal(first.projectId, again.projectId)
  assert.equal(dealStatus(service), "new")
  assert.deepEqual(projectIds(service), [CREATED])

  await start(service)
  assert.equal(dealStatus(service), "pricing")
})
