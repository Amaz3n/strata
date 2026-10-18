const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

// A neighbouring workbench with its own suite: linking the executed file is
// recorded, not re-tested here. A selection change is applied by the approval
// itself in the database (selections-db.test.js).
const attached = []
stubModule("@/lib/services/file-links", {
  attachFileWithServiceRole: async (input) => attached.push(input),
})

const { approveChangeOrder, approveChangeOrderFromEnvelopeExecution, updateChangeOrder, voidChangeOrder } = freshRequire("lib/services/change-orders.ts")

// The database merges a patch into a change order's metadata (`merge_change_order_metadata`).
function mergeMetadata(getService) {
  return (args) => {
    const row = getService().db.change_orders.find((changeOrder) => changeOrder.id === args.p_change_order_id && changeOrder.org_id === args.p_org_id)
    row.metadata = { ...row.metadata, ...args.p_patch }
    return { data: null, error: null }
  }
}

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
    const service = createServiceHarness({
      rpc: { merge_change_order_metadata: mergeMetadata(() => service) },
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
    return service
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

  test("the completion stamp merges into the metadata an outbox job stamped meanwhile", async () => {
    const service = harness()
    service.tamper("draw_schedules", (result) => {
      service.db.change_orders[0].metadata = { ...service.db.change_orders[0].metadata, selection_change_follow_up: { event_recorded: true } }
      return result
    }, { on: "select", times: 1 })

    await service.run(() => approveChangeOrderFromEnvelopeExecution(input))

    const { metadata } = service.db.change_orders[0]
    assert.equal(metadata.envelope_effects_completed, true)
    assert.deepEqual(metadata.selection_change_follow_up, { event_recorded: true })
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

  test("an applied selection change order cannot be voided even without an agreement amendment", async () => {
    const service = harness({
      changeOrder: { status: "approved", lifecycle: "approved", metadata: { selection_change: { changes: [] } } },
    })
    await assert.rejects(service.run(() => voidChangeOrder({ changeOrderId: CHANGE_ORDER, reason: "Buyer changed mind" })), /Reverse it with a new change order/)
    assert.equal(service.db.change_orders[0].status, "approved")
    assert.equal(service.queries.some((query) => query.table === "rpc:void_approved_change_order_atomic"), false)
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

describe("a selection change order", () => {
  const SELECTION_CHANGE = { changes: [{ selection_id: id(40), new_option_id: id(41), cost_delta_cents: 700_00, cost_code_id: id(42) }], fee_cents: 250_00 }
  const input = { orgId: ORG, changeOrderId: CHANGE_ORDER, envelopeId: ENVELOPE, documentId: id(5), executedFileId: id(6), signerName: "Buyer" }

  function harness() {
    attached.length = 0
    const service = createServiceHarness({
      rpc: { merge_change_order_metadata: mergeMetadata(() => service) },
      permissions: ["change_order.write", "project.read"],
      tables: {
        projects: [{ id: PROJECT, org_id: ORG, division_id: null }],
        change_orders: [{ id: CHANGE_ORDER, org_id: ORG, project_id: PROJECT, title: "Post-cutoff selection change", status: "pending", lifecycle: "proposed", total_cents: 1550_00, requires_signature: true, metadata: { selection_change: SELECTION_CHANGE } }],
        change_order_lines: [
          { id: id(43), org_id: ORG, change_order_id: CHANGE_ORDER, description: "Selection change: Countertop — Quartz", quantity: 1, unit_cost_cents: 1300_00, internal_cost_cents: 700_00, cost_code_id: id(42) },
          { id: id(44), org_id: ORG, change_order_id: CHANGE_ORDER, description: "Post-cutoff selection change fee", quantity: 1, unit_cost_cents: 250_00, internal_cost_cents: 0, cost_code_id: null },
        ],
        contracts: [],
        draw_schedules: [],
        project_financial_settings: [],
        approvals: [],
        budget_revisions: [],
        budget_revision_lines: [],
      },
    })
    return service
  }

  test("its budget revision is the approval's own, and an uncosted fee line no longer stops a budget posting", async () => {
    const service = harness()
    await service.run(() => approveChangeOrderFromEnvelopeExecution(input))
    const [changeOrder] = service.db.change_orders
    assert.equal(changeOrder.status, "approved")
    assert.deepEqual(service.writes("budget_revisions"), [])
    assert.deepEqual(changeOrder.metadata.financial_impact.budget_distributions.map((line) => [line.cost_code_id, line.budget_revision_cents]), [[id(42), 700_00]])
    assert.equal(changeOrder.metadata.financial_impact.posting_skipped_reason, undefined)
  })

  test("a buyer signature the approval refuses is recorded on the change order, with no approval behind it", async () => {
    const service = harness()
    service.tamper("change_orders", (result) => ({ ...result, data: null, error: { message: "Countertop changed after this change order was priced; void it and raise a new one", details: "SELECTION_CHANGED_SINCE_CHANGE_ORDER" } }), { on: "update", times: 1 })
    await assert.rejects(service.run(() => approveChangeOrderFromEnvelopeExecution(input)), /changed after this change order was priced/)
    assert.equal(service.db.change_orders[0].metadata.approval_blocked.code, "SELECTION_CHANGED_SINCE_CHANGE_ORDER")
    assert.deepEqual(service.db.approvals, [])

    // A signature that later lands clears the stuck note.
    const retried = harness()
    retried.db.change_orders[0].metadata = { ...retried.db.change_orders[0].metadata, approval_blocked: { reason: "stale", code: "SELECTION_CHANGED_SINCE_CHANGE_ORDER" } }
    await retried.run(() => approveChangeOrderFromEnvelopeExecution(input))
    assert.equal(retried.db.change_orders[0].status, "approved")
    assert.equal(retried.db.change_orders[0].metadata.approval_blocked, undefined)
    assert.equal(retried.db.approvals.length, 1)
  })

  test("it is not edited in place: its lines are the buyer's selection prices", async () => {
    const service = harness()
    await assert.rejects(
      service.run(() => updateChangeOrder({ changeOrderId: CHANGE_ORDER, input: { project_id: PROJECT, title: "Edited", lines: [{ description: "x", quantity: 1, unit_cost: 1 }] } })),
      /fixed as raised/,
    )
    assert.deepEqual(service.writes("change_order_lines"), [])
  })
})
