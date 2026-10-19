const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, recordingService } = require("./support/mobile")

const PROSPECT = id(1)
const PROJECT = id(2)
const REVISION = "2026-10-01T12:00:00Z"

// The prospect service (its own suite) holding one opportunity.
const pipeline = { status: "new", calls: [] }
stubModule(
  "lib/services/prospects.ts",
  recordingService(pipeline.calls, {
    getProspect: () => ({ id: PROSPECT, name: "Test", status: pipeline.status, updated_at: REVISION }),
    listProspectContacts: [],
    listProspectActivity: [],
    updateProspect: null,
    setProspectFollowUp: null,
  }),
)

const { loadProspectDetail, performProspectAction } = freshRequire("lib/mobile/workspace-precon.ts")

function harness({ phase = "precon", permissions = ["org.member", "project.read", "project.manage"] } = {}) {
  const service = createServiceHarness({
    permissions,
    tables: { projects: [{ id: PROJECT, org_id: ORG, prospect_id: PROSPECT, phase }] },
  })
  const context = mobileContext(service)
  service.actions = async () => (await service.run(() => loadProspectDetail(context, PROSPECT))).actions.map((action) => action.id)
  service.act = (actionId, values, revision) => service.run(() => performProspectAction(context, PROSPECT, actionId, values, revision))
  return service
}

const writes = () => pipeline.calls.filter(([name]) => name === "updateProspect" || name === "setProspectFollowUp")

beforeEach(() => {
  pipeline.status = "new"
  pipeline.calls.length = 0
})

test("won, delivered or unmanageable opportunities offer no actions; a lost one can only reopen", async () => {
  pipeline.status = "won"
  assert.deepEqual(await harness().actions(), [])
  pipeline.status = "new"
  assert.deepEqual(await harness({ phase: "delivery" }).actions(), [])
  assert.deepEqual(await harness({ permissions: ["org.member", "project.read"] }).actions(), [])

  pipeline.status = "lost"
  assert.deepEqual(await harness().actions(), ["reopen-prospect"])
})

test("stages set by documents cannot be chosen by hand", async () => {
  pipeline.status = "pricing"
  const service = harness()

  assert.equal((await service.actions()).includes("change-lead-stage"), false)
  for (const status of ["won", "executed", "pricing", "client_approved"]) {
    await assert.rejects(service.act("change-lead-stage", { status }, REVISION), undefined, status)
  }
  assert.deepEqual(writes(), [])
})

test("an edit carries the revision it was made against; a follow-up needs a real date", async () => {
  const service = harness()

  await service.act("edit-prospect", { name: "Updated", source: "Referral" }, REVISION)
  await assert.rejects(service.act("follow-up", { date: "2026-02-30" }))
  await service.act("follow-up", { date: "2026-10-15" })

  const [[, edit], [, followUp]] = writes()
  assert.equal(edit.input.expected_updated_at, REVISION)
  assert.equal(followUp.nextFollowUpAt, "2026-10-15T12:00:00.000Z")
})
