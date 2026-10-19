const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, recordingService, status } = require("./support/mobile")

const PROJECT = id(1)
const BID = id(2)
const COMMITMENT = id(3)
const ITEM = id(4)
const CODE = id(5)
const LINE = id(6)

// The bid and commitment services (their own suites), holding one draft each.
const store = { status: "draft", scope: [], calls: [] }
stubModule(
  "lib/services/bids.ts",
  recordingService(store.calls, {
    getBidPackage: () => ({ id: BID, status: store.status, project_id: PROJECT, title: "Framing" }),
    listBidScopeItems: () => structuredClone(store.scope),
    saveBidScopeItems: null,
  }),
)
stubModule(
  "lib/services/commitments.ts",
  recordingService(store.calls, {
    getCommitmentDetail: () => ({
      commitment: { id: COMMITMENT, status: store.status, project_id: PROJECT },
      lines: [{ id: LINE, description: "Work", quantity: 2, unit: "hour", unit_cost_cents: 12500, scheduled_value_cents: null }],
    }),
    createCommitmentLine: null,
    updateCommitmentLine: null,
  }),
)

const { loadDocumentActions, performDocumentAction } = freshRequire("lib/mobile/workspace-document-actions.ts")

const WRITER = ["project.read", "bid.write", "commitment.write"]

function harness(permissions = WRITER) {
  const service = createServiceHarness({ permissions, tables: { projects: [{ id: PROJECT, org_id: ORG }] } })
  const context = mobileContext(service)
  service.load = (moduleId, recordId) => service.run(() => loadDocumentActions(context, moduleId, PROJECT, recordId))
  service.perform = (moduleId, recordId, actionId, values) =>
    service.run(() => performDocumentAction(context, moduleId, recordId, actionId, values))
  return service
}

const writes = () => store.calls.filter(([name]) => !name.startsWith("get") && !name.startsWith("list"))

beforeEach(() => {
  store.status = "draft"
  store.scope = [{ id: ITEM, description: "Work", item_type: "base", cost_code_id: CODE, quantity: 1, budget_cents: 10000 }]
  store.calls.length = 0
})

test("editing draft scope keeps the server's cost coding and prices the budget in cents", async () => {
  const row = { id: ITEM, description: "Revised work", item_type: "base", quantity: "2", budget: "300.50", cost_code_id: "injected" }

  await harness().perform("bids", BID, "edit-bid-scope", { items: JSON.stringify([row]) })

  const [, { input }] = writes()[0]
  assert.equal(input.items[0].cost_code_id, CODE)
  assert.equal(input.items[0].budget_cents, 30050)
})

test("a scope row borrowing another id, or repeating one, is refused", async () => {
  const row = { id: ITEM, description: "Work", item_type: "base" }
  for (const items of [[{ ...row, id: CODE }], [row, row]]) {
    await assert.rejects(harness().perform("bids", BID, "edit-bid-scope", { items: JSON.stringify(items) }), status(422))
  }
  assert.deepEqual(writes(), [])
})

test("issued documents, and readers without write access, get no draft actions", async () => {
  const cases = [
    { status: "sent", permissions: WRITER },
    { status: "approved", permissions: WRITER },
    { status: "draft", permissions: ["project.read"] },
  ]
  for (const { status: documentStatus, permissions } of cases) {
    store.status = documentStatus
    const service = harness(permissions)
    for (const [moduleId, recordId] of [["bids", BID], ["commitments", COMMITMENT]]) {
      assert.deepEqual((await service.load(moduleId, recordId)).actions, [], `${moduleId} ${documentStatus}`)
    }
  }
})

test("an action's revision changes when the scope behind it changes", async () => {
  const service = harness()
  const before = await service.load("bids", BID)
  store.scope[0].quantity = 3
  const after = await service.load("bids", BID)

  assert.notEqual(before.actions[0].revision, after.actions[0].revision)
})

test("schedule-of-values lines are shown and entered in dollars, stored in cents", async () => {
  const service = harness()

  const { actions } = await service.load("commitments", COMMITMENT)
  const edit = actions.find((action) => action.id === `edit-value-line:${LINE}`)
  assert.equal(edit.fields.find((field) => field.key === "unit_price").value, "125")

  await service.perform("commitments", COMMITMENT, "add-value-line", {
    description: "Work",
    quantity: "1.5",
    unit: "hour",
    unit_price: "125.25",
    scheduled_value: "",
    retainage_percent: "10",
    cost_code_id: CODE,
  })
  const [name, commitmentId, input] = writes()[0]
  assert.equal(name, "createCommitmentLine")
  assert.equal(commitmentId, COMMITMENT)
  assert.equal(input.unit_cost_cents, 12525)
  assert.equal(input.cost_code_id, undefined)
})
