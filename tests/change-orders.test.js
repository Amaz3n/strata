const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

// Neighbouring workbenches with their own suites: linking the executed file and
// carrying a selection change are recorded, not re-tested here.
const attached = []
stubModule("@/lib/services/file-links", {
  attachFileWithServiceRole: async (input) => attached.push(input),
})
stubModule("@/lib/services/selections", { applySelectionChangeFromChangeOrder: async () => {} })

const { approveChangeOrder, approveChangeOrderFromEnvelopeExecution, voidChangeOrder } = freshRequire("lib/services/change-orders.ts")

const PROJECT = id(1)
const CHANGE_ORDER = id(2)
const CONTRACT = id(3)
const ENVELOPE = id(4)

describe("approving a change order from an executed envelope", () => {
  const input = {
    orgId: ORG,
    changeOrderId: CHANGE_ORDER,
    envelopeId: ENVELOPE,
    documentId: id(5),
    executedFileId: id(6),
    signerName: "Owner",
  }

  function harness(contract = {}) {
    attached.length = 0
    return createServiceHarness({
      tables: {
        change_orders: [
          {
            id: CHANGE_ORDER,
            org_id: ORG,
            project_id: PROJECT,
            title: "Upgrade windows",
            status: "sent",
            lifecycle: "sent",
            total_cents: 50_000,
            metadata: {},
          },
        ],
        change_order_lines: [],
        contracts: [
          { id: CONTRACT, org_id: ORG, project_id: PROJECT, status: "active", total_cents: 1_000_000, snapshot: {}, ...contract },
        ],
        draw_schedules: [],
        project_financial_settings: [],
        approvals: [],
      },
    })
  }

  test("an effect that fails after approval is replayed once, without double-counting", async () => {
    const service = harness()
    // The approval commits, then the contract rollup fails part-way.
    service.tamper("draw_schedules", replies.error("temporary failure"), { on: "select", times: 1 })

    await assert.rejects(service.run(() => approveChangeOrderFromEnvelopeExecution(input)), /temporary failure/)
    const [changeOrder] = service.db.change_orders
    assert.equal(changeOrder.status, "approved")
    assert.equal(changeOrder.metadata.envelope_effects_completed, undefined)

    const result = await service.run(() => approveChangeOrderFromEnvelopeExecution(input))

    assert.deepEqual(result, { success: true, idempotent: false })
    assert.equal(service.db.change_orders[0].metadata.envelope_effects_completed, true)
    assert.equal(service.db.approvals.length, 1)
    assert.equal(service.db.contracts[0].total_cents, 1_050_000)
    assert.equal(service.db.contracts[0].snapshot.base_total_cents, 1_000_000)
  })

  test("a completed execution replays as a no-op", async () => {
    const service = harness()
    await service.run(() => approveChangeOrderFromEnvelopeExecution(input))
    const writes = service.writes().length

    const replay = await service.run(() => approveChangeOrderFromEnvelopeExecution(input))

    assert.deepEqual(replay, { success: true, idempotent: true })
    assert.equal(service.writes().length, writes)
    assert.equal(service.db.contracts[0].total_cents, 1_050_000)
    assert.equal(attached.length, 1)
  })

  test("a purchase agreement keeps its signed price: the closing adds the change once", async () => {
    const service = harness({ contract_type: "purchase_agreement" })
    await service.run(() => approveChangeOrderFromEnvelopeExecution(input))

    assert.equal(service.db.change_orders[0].status, "approved")
    assert.equal(service.db.contracts[0].total_cents, 1_000_000)
    assert.deepEqual(service.db.contracts[0].snapshot, {})
  })
})

describe("a change order on a sold home is an amendment to the buyer's agreement", () => {
  function harness({ changeOrder = {}, versions = [] } = {}) {
    return createServiceHarness({
      permissions: ["change_order.approve"],
      projects: [PROJECT],
      tables: {
        projects: [{ id: PROJECT, org_id: ORG, division_id: null }],
        change_orders: [{ id: CHANGE_ORDER, org_id: ORG, project_id: PROJECT, title: "Covered patio", status: "pending", lifecycle: "proposed", total_cents: 12_500_00, requires_signature: true, metadata: {}, ...changeOrder }],
        change_order_lines: [],
        contracts: [{ id: CONTRACT, org_id: ORG, project_id: PROJECT, contract_type: "purchase_agreement", status: "active", total_cents: 385_000_00, snapshot: {} }],
        purchase_agreement_versions: versions,
        approvals: [],
      },
    })
  }

  test("an offline approval without the buyer's signed copy is refused before anything is recorded", async () => {
    const service = harness()
    await assert.rejects(
      service.run(() => approveChangeOrder({ changeOrderId: CHANGE_ORDER, approval: { signerName: "Builder", note: "Buyer agreed by phone" } })),
      /amends the buyer's signed purchase agreement/,
    )
    assert.equal(service.db.change_orders[0].status, "pending")
    assert.deepEqual(service.db.approvals, [])
  })

  test("a signed amendment cannot be voided; it is reversed by another the buyer signs", async () => {
    const service = harness({
      changeOrder: { status: "approved", lifecycle: "approved", contract_id: CONTRACT },
      versions: [{ id: id(7), org_id: ORG, contract_id: CONTRACT, change_order_id: CHANGE_ORDER, version_number: 2 }],
    })
    await assert.rejects(service.run(() => voidChangeOrder({ changeOrderId: CHANGE_ORDER, reason: "Buyer changed mind" })), /cannot be voided/)
    assert.equal(service.db.change_orders[0].status, "approved")
    assert.equal(service.queries.some((query) => query.table === "rpc:void_approved_change_order_atomic"), false)
  })
})
